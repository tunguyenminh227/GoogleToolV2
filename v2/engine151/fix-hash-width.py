"""Preserve the 149 hash truncation explicitly for Chromium 151 warnings."""
from pathlib import Path
import re

root = Path(__file__).resolve().parent / 'work'
files = {
    'third_party/blink/renderer/modules/canvas/canvas2d/base_rendering_context_2d.cc': 1,
    'third_party/blink/renderer/modules/webaudio/offline_audio_context.cc': 2,
    'third_party/blink/renderer/core/dom/document.cc': 2,
}
for name, count in files.items():
    p = root / name
    text = p.read_text(encoding='utf-8')
    pattern = r'(\buint32_t\s+\w+\s*=\s*)(std::hash<std::string>\{\}\([^;]+\));'
    updated, changed = re.subn(pattern, r'\1static_cast<uint32_t>(\2);', text)
    if changed != count:
        raise ValueError(f'{name}: expected {count} conversions, found {changed}')
    p.write_text(updated, encoding='utf-8', newline='\n')
    print(f'{name}: {changed} explicit conversions')
