"""Generate and verify the 151 patch from resolved source; leaves 149 untouched."""
import difflib, hashlib, json, shutil, subprocess, tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parent
manifest=json.loads((ROOT/'source-manifest.json').read_text())
chunks=[]; changes=[]
for p in sorted((ROOT/'work').rglob('*')):
    if not p.is_file() or p.suffix=='.rej': continue
    rel=p.relative_to(ROOT/'work').as_posix()
    original=ROOT/'upstream'/rel
    before=original.read_text(encoding='utf-8') if original.exists() else ''
    after=p.read_text(encoding='utf-8')
    if before==after: continue
    chunks.append(f'diff --git a/{rel} b/{rel}\n')
    if not original.exists(): chunks.append('new file mode 100644\n')
    chunks.extend(difflib.unified_diff(before.splitlines(keepends=True),after.splitlines(keepends=True),fromfile='a/'+rel if original.exists() else '/dev/null',tofile='b/'+rel))
    changes.append({'path':rel,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
patch=ROOT/'adryfish-151.patch';patch.write_text(''.join(chunks),encoding='utf-8',newline='\n')
verify=Path(tempfile.mkdtemp(prefix='verify-',dir=ROOT));shutil.copytree(ROOT/'upstream',verify,dirs_exist_ok=True)
for flags in [['--check'],[]]:
    subprocess.run([r'C:\Program Files\Git\cmd\git.exe','-c','core.autocrlf=false','apply','--whitespace=nowarn',*flags,str(patch)],cwd=verify,check=True)
for entry in changes:
    assert hashlib.sha256((verify/entry['path']).read_bytes()).hexdigest()==entry['sha256'],entry['path']
report={'chromium':manifest['version'],'chromiumCommit':manifest['chromiumCommit'],'v8Commit':manifest['v8Commit'],'basePatchSha256':manifest['basePatchSha256'],'sourceOnly':True,'compiled':False,'runtimeTested':False,'ipheyTested':False,'cleanApplyVerified':True,'patchSha256':hashlib.sha256(patch.read_bytes()).hexdigest(),'appliedTree':str(verify),'changes':changes}
(ROOT/'port-report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps({k:v for k,v in report.items() if k!='changes'},indent=2));print('Changed files:',len(changes))
