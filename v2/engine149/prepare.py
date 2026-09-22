"""Fetch exact upstream files touched by the selected patch series; no full checkout."""
import base64
import concurrent.futures
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parent
VENDOR = ROOT / 'vendor/fingerprint-chromium-144.0.7559.132'
VERSION = '149.0.7827.102'
PREFIX = 'https://chromium.googlesource.com/chromium/src/+/refs/tags/' + VERSION + '/'
selected = [
    'extra/ungoogled-chromium/add-ungoogled-flag-headers.patch',
    'extra/bromite/fingerprinting-flags-client-rects-and-measuretext.patch',
    'extra/bromite/flag-fingerprinting-canvas-image-data-noise.patch',
    'extra/ungoogled-chromium/add-components-ungoogled.patch',
]
selected += [p for p in (VENDOR / 'patches/series').read_text().splitlines() if p.startswith('extra/fingerprint/')]
paths = {}
for name in selected:
    patch = (VENDOR / 'patches' / name).read_text(encoding='utf-8')
    for old, new in re.findall(r'^--- (\S+).*?\n\+\+\+ (\S+)', patch, re.M):
        target = new.removeprefix('b/')
        if target not in paths:
            paths[target] = old != '/dev/null'
for name in ['chrome/VERSION', 'docs/windows_build_instructions.md', 'build/vs_toolchain.py',
             'components/embedder_support/BUILD.gn', 'third_party/blink/common/BUILD.gn',
             'third_party/blink/renderer/core/BUILD.gn', 'third_party/blink/renderer/modules/BUILD.gn']:
    paths[name] = True

def fetch(item):
    name, existed = item
    if not existed:
        return {'path': name, 'new': True}
    destination = ROOT / 'upstream' / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not destination.exists():
        url = PREFIX + name + '?format=TEXT'
        if name.startswith('v8/'):
            url = 'https://chromium.googlesource.com/v8/v8/+/16ef80c1f5d3cfade812bd1743952a4cfd480a31/' + name[3:] + '?format=TEXT'
        result = subprocess.run(['curl.exe', '--fail', '--location', '--silent', '--show-error',
                                 '--retry', '2', '--max-time', '90', url], capture_output=True)
        if result.returncode:
            return {'path': name, 'error': result.stderr.decode(errors='replace')}
        destination.write_bytes(base64.b64decode(result.stdout))
    return {'path': name, 'sha256': hashlib.sha256(destination.read_bytes()).hexdigest()}

if __name__ == '__main__':
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(fetch, paths.items()))
    (ROOT / 'source-manifest.json').write_text(json.dumps({'version': VERSION, 'patchTag': '144.0.7559.132',
        'series': selected, 'files': results}, indent=2), encoding='utf-8')
    failures = [r for r in results if 'error' in r]
    print(json.dumps({'files': len(results), 'patches': len(selected), 'failures': failures}, indent=2))
    raise SystemExit(bool(failures))
