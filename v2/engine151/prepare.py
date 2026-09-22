"""Fetch pinned Chromium 151 files and apply the existing verified 149 port."""
import base64, concurrent.futures, hashlib, json, re, shutil, subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BASE = ROOT.parent / 'engine149'
VERSION = '151.0.7922.173'
COMMIT = 'a96602f30358e9b5d256a0464e7e4d4bec223004'
GIT = r'C:\Program Files\Git\cmd\git.exe'

def fetch(url):
    result = subprocess.run(['curl.exe', '--fail', '--silent', '--show-error', '--location', '--retry', '3', '--max-time', '120', url], capture_output=True, check=True)
    return base64.b64decode(result.stdout)

if __name__ == '__main__':
    deps = fetch(f'https://chromium.googlesource.com/chromium/src/+/{COMMIT}/DEPS?format=TEXT')
    (ROOT / 'DEPS').write_bytes(deps)
    v8 = re.search(r"'v8_revision':\s*'([a-f0-9]+)'", deps.decode())[1]
    report149 = json.loads((BASE / 'port-report.json').read_text())
    manifest149 = json.loads((BASE / 'source-manifest.json').read_text())
    new_files = {f['path'] for f in manifest149['files'] if f.get('new')}
    paths = {f['path'] for f in report149['changes']} | {'chrome/VERSION', 'docs/windows_build_instructions.md', 'build/vs_toolchain.py'}
    def download(name):
        if name in new_files: return {'path':name,'new':True}
        p = ROOT / 'upstream' / name
        p.parent.mkdir(parents=True, exist_ok=True)
        if not p.exists():
            url = f'https://chromium.googlesource.com/chromium/src/+/{COMMIT}/{name}?format=TEXT'
            if name.startswith('v8/'): url = f'https://chromium.googlesource.com/v8/v8/+/{v8}/{name[3:]}?format=TEXT'
            p.write_bytes(fetch(url))
        return {'path':name,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        files = list(pool.map(download, sorted(paths)))
    manifest = {'version':VERSION,'chromiumCommit':COMMIT,'v8Commit':v8,'basePatchSha256':report149['patchSha256'],'files':files}
    (ROOT/'source-manifest.json').write_text(json.dumps(manifest,indent=2))
    work = ROOT/'work'
    if work.exists(): raise RuntimeError('Work already exists; refusing to overwrite resolutions')
    shutil.copytree(ROOT/'upstream',work)
    result = subprocess.run([GIT,'-c','core.autocrlf=false','apply','--reject','--whitespace=nowarn',str(BASE/'adryfish-149.patch')],cwd=work,capture_output=True,text=True)
    (ROOT/'initial-apply.log').write_text(result.stdout+result.stderr,encoding='utf-8')
    if result.returncode not in (0,1): raise RuntimeError(result.stderr)
    shutil.copyfile(BASE/'LICENSE.adryfish',ROOT/'LICENSE.adryfish')
    print(json.dumps({'version':VERSION,'v8Commit':v8,'rejectedFiles':[str(p.relative_to(work)) for p in work.rglob('*.rej')]},indent=2))
