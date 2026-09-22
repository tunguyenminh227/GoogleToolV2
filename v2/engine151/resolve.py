"""Explicit 149-to-151 compatibility resolutions; run once after prepare.py."""
from pathlib import Path
import re
ROOT = Path(__file__).resolve().parent
work = ROOT/'work'
for rejected in work.rglob('*.rej'):
    p = rejected.with_suffix('')
    text = p.read_text(encoding='utf-8')
    includes = re.findall(r'^\+(#include .+)$',rejected.read_text(encoding='utf-8'),re.M)
    missing = [line for line in includes if line not in text]
    if missing:
        pos=text.index('\n',text.index('#include '))+1
        p.write_text(text[:pos]+'\n'.join(missing)+'\n'+text[pos:],encoding='utf-8',newline='\n')
def change(name,old,new):
    p=work/name
    text=p.read_text(encoding='utf-8')
    if text.count(old)!=1: raise ValueError('Unexpected anchor: '+name)
    p.write_text(text.replace(old,new,1),encoding='utf-8',newline='\n')
change('third_party/blink/renderer/core/loader/frame_fetch_context.cc',
       '  if (ua) {\n    bool ua_changed',
       '  if (ua) {\n    UpdateUserAgentMetadataFingerprint(&ua.value());\n    bool ua_changed')
p=work/'v8/src/inspector/v8-runtime-agent-impl.cc'
text=p.read_text(encoding='utf-8')
start=text.index('void V8RuntimeAgentImpl::addBindings(InspectedContext* context) {')
end=text.index('\nvoid V8RuntimeAgentImpl::restore()',start)
text=text[:start]+'''void V8RuntimeAgentImpl::addBindings(InspectedContext* /*context*/) {
  // Preserve the behavior of the verified 149 port.
  return;
}
'''+text[end:]
p.write_text(text,encoding='utf-8',newline='\n')
p=work/'components/ungoogled/fingerprint_data.h'
text=p.read_text(encoding='utf-8')
assert text.count('149.0.7827.102')==2
p.write_text(text.replace('149.0.7827.102','151.0.7922.173'),encoding='utf-8',newline='\n')
change('third_party/blink/renderer/platform/fonts/font_cache.cc',
       '    uint32_t hash = std::hash<std::string>{}(fingerprint + requested_family);',
       '    uint32_t hash = static_cast<uint32_t>(\n'
       '        std::hash<std::string>{}(fingerprint + requested_family));')
import runpy
runpy.run_path(str(ROOT/'fix-hash-width.py'))
print('Resolved include conflicts, Client Hints caching, V8 bindings, and explicit 32-bit hash conversions; pinned 151 version.')
