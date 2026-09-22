"""Check patched C++ using generated build flags, without writing build outputs."""
import ctypes
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
source = Path(sys.argv[1] if len(sys.argv) > 1 else 'E:/GoogleToolBuild149/src').resolve()
output = source / 'out/GoogleTool149'
changed = {e['path'] for e in json.loads((ROOT / 'port-report.json').read_text())['changes']
           if e['path'].endswith('.cc')}
targets_only = '--targets-only' in sys.argv
focused = len(sys.argv) > 2 and not targets_only
if focused:
    changed &= set(sys.argv[2:])
targets = []
owners = {output / 'obj' / parent for relative in changed for parent in Path(relative).parents}
found = set()
# These targets are declared in the source file's directory or an ancestor.
# Avoid recursively walking generated output trees (including package links).
ninja_files = sorted({ninja for owner in owners for ninja in owner.glob('*.ninja')})
for ninja in ninja_files:
    with ninja.open(encoding='utf-8') as stream:
        for line in stream:
            if line.startswith('build ') and ': cxx ../../' in line:
                target, tail = line[6:].split(': cxx ../../', 1)
                if tail.split()[0] in changed:
                    targets.append(target)
                    found.add(tail.split()[0])
print(f'Found {len(targets)} patched C++ targets.', flush=True)
if not targets:
    raise RuntimeError('No patched C++ targets found in the generated build.')
if found != changed:
    raise RuntimeError('Missing patched targets: ' + ', '.join(sorted(changed - found)))
if targets_only:
    (ROOT / 'patch-targets.json').write_text(json.dumps(targets, indent=2), encoding='utf-8')
    sys.exit(0)
result = subprocess.run([str(source / 'third_party/ninja/ninja.exe'), '-t', 'commands', '-s', *targets],
                        cwd=output, capture_output=True, text=True, check=True)
split_command = ctypes.windll.shell32.CommandLineToArgvW
split_command.argtypes = [ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_int)]
split_command.restype = ctypes.POINTER(ctypes.c_wchar_p)
ctypes.windll.kernel32.LocalFree.argtypes = [ctypes.c_void_p]
reports = []
for command in result.stdout.splitlines():
    count = ctypes.c_int()
    pointer = split_command(command, ctypes.byref(count))
    try:
        args = [pointer[i] for i in range(count.value)]
    finally:
        ctypes.windll.kernel32.LocalFree(pointer)
    if Path(args[0]).name.lower() != 'clang-cl.exe':
        raise RuntimeError('Unexpected compiler: ' + args[0])
    args[0] = str((output / args[0]).resolve())
    args = [arg for arg in args if arg != '/c' and not arg.startswith(('/Fo', '/Fd', '/showIncludes'))]
    args.append('/Zs')
    unit = next(arg for arg in args if arg.endswith('.cc'))
    print('CHECK ' + unit, flush=True)
    check = subprocess.run(args, cwd=output, capture_output=True, text=True, errors='replace')
    reports.append({'source': unit, 'exit': check.returncode, 'output': check.stdout + check.stderr})
    print(('PASS ' if check.returncode == 0 else 'FAIL ') + unit, flush=True)
    if check.returncode:
        print(check.stdout + check.stderr, flush=True)
    report_file = 'syntax-report-focused.json' if focused else 'syntax-report.json'
    (ROOT / report_file).write_text(json.dumps(reports, indent=2), encoding='utf-8')
sys.exit(1 if any(r['exit'] for r in reports) else 0)
