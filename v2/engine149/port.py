"""Reproduce the source-only port and verify clean application to upstream files."""
import difflib
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent
manifest = json.loads((ROOT / 'source-manifest.json').read_text())
vendor = ROOT / 'vendor/fingerprint-chromium-144.0.7559.132'
work = Path(tempfile.mkdtemp(prefix='port-', dir=ROOT))
shutil.copytree(ROOT / 'upstream', work, dirs_exist_ok=True)
log = []
for entry in manifest['files']:
    if entry.get('sha256'):
        actual = hashlib.sha256((work / entry['path']).read_bytes()).hexdigest()
        if actual != entry['sha256']:
            raise ValueError('Source checksum mismatch: ' + entry['path'])
for name in manifest['series']:
    result = subprocess.run(['git', '-c', 'core.autocrlf=false', 'apply', '--reject', '--whitespace=nowarn', str(vendor / 'patches' / name)],
                            cwd=work, capture_output=True, encoding='utf-8', errors='replace')
    if result.returncode not in [0, 1]:
        raise RuntimeError(result.stderr)
    log.append({'patch': name, 'exit': result.returncode, 'output': result.stdout + result.stderr})
(ROOT / 'initial-apply.json').write_text(json.dumps(log, indent=2), encoding='utf-8')
subprocess.run([sys.executable, str(ROOT / 'resolve.py'), str(work)], check=True)

chunks = []
changes = []
for p in sorted(work.rglob('*')):
    if not p.is_file() or p.suffix == '.rej':
        continue
    rel = p.relative_to(work).as_posix()
    original = ROOT / 'upstream' / rel
    before = original.read_text(encoding='utf-8') if original.exists() else ''
    after = p.read_text(encoding='utf-8')
    if before == after:
        continue
    chunks.append(f'diff --git a/{rel} b/{rel}\n')
    if not original.exists():
        chunks.append('new file mode 100644\n')
    chunks.extend(difflib.unified_diff(before.splitlines(keepends=True), after.splitlines(keepends=True),
                                     fromfile='a/' + rel if original.exists() else '/dev/null', tofile='b/' + rel))
    changes.append({'path': rel, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()})

patch = ROOT / 'adryfish-149.patch'
patch.write_text(''.join(chunks), encoding='utf-8', newline='\n')
verify = Path(tempfile.mkdtemp(prefix='verify-', dir=ROOT))
shutil.copytree(ROOT / 'upstream', verify, dirs_exist_ok=True)
for args in [['--check'], []]:
    result = subprocess.run(['git', '-c', 'core.autocrlf=false', 'apply', '--whitespace=nowarn', *args, str(patch)], cwd=verify, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
for entry in changes:
    if hashlib.sha256((verify / entry['path']).read_bytes()).hexdigest() != entry['sha256']:
        raise ValueError('Applied output mismatch: ' + entry['path'])
shutil.copyfile(vendor / 'LICENSE', ROOT / 'LICENSE.adryfish')
report = {'chromium': manifest['version'], 'chromiumCommit': '112f665d98a2fe84b156c74fbea2aed742f16c15',
          'v8Commit': '16ef80c1f5d3cfade812bd1743952a4cfd480a31', 'adryfishTag': manifest['patchTag'],
          'sourceOnly': True, 'compiled': False, 'ipheyTested': False,
          'patchSha256': hashlib.sha256(patch.read_bytes()).hexdigest(),
          'cleanApplyVerified': True, 'appliedTree': str(verify), 'changes': changes}
(ROOT / 'port-report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps({k: v for k, v in report.items() if k != 'changes'}, indent=2))
print('Changed files:', len(changes))
