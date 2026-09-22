"""Apply the verified source patch to an exact Chromium 151 checkout."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('source', type=Path, help='Chromium src directory, with matching V8 checkout')
parser.add_argument('--check', action='store_true', help='Verify without changing source files')
args = parser.parse_args()
source = args.source.resolve(strict=True)
report = json.loads((root / 'port-report.json').read_text())
manifest = json.loads((root / 'source-manifest.json').read_text())
patch = root / 'adryfish-151.patch'
if hashlib.sha256(patch.read_bytes()).hexdigest() != report['patchSha256']:
    raise SystemExit('Patch checksum mismatch')
expected = {x['path']: x for x in manifest['files']}
for entry in report['changes']:
    name = entry['path']
    original = expected.get(name)
    destination = source / name
    if not destination.is_relative_to(source):
        raise SystemExit('Unsafe patch path')
    if original and original.get('sha256'):
        if hashlib.sha256(destination.read_bytes()).hexdigest() != original['sha256']:
            raise SystemExit('Source differs from pinned upstream: ' + name)
    elif destination.exists():
        raise SystemExit('New patch file already exists: ' + name)
version = dict(line.split('=', 1) for line in (source / 'chrome/VERSION').read_text().splitlines() if '=' in line)
if '.'.join(version[k] for k in ['MAJOR', 'MINOR', 'BUILD', 'PATCH']) != report['chromium']:
    raise SystemExit('Wrong Chromium version')
command = ['git', '-c', 'core.autocrlf=false', 'apply', '--whitespace=nowarn']
subprocess.run(command + ['--check', str(patch)], cwd=source, check=True)
if not args.check:
    subprocess.run(command + [str(patch)], cwd=source, check=True)
    for entry in report['changes']:
        if hashlib.sha256((source / entry['path']).read_bytes()).hexdigest() != entry['sha256']:
            raise SystemExit('Output verification failed: ' + entry['path'])
print('Source patch checked.' if args.check else 'Source patch applied and verified. Compilation is still required.')
