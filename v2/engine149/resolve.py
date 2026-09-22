"""Explicit resolutions for the initial 144-to-149 rejected hunks. Run once."""
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parent
WORK = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / 'work'
if not WORK.is_relative_to(ROOT):
    raise ValueError('Work tree must stay inside engine149')

def change(name, old, new):
    p = WORK / name
    text = p.read_text(encoding='utf-8')
    if text.count(old) != 1:
        raise ValueError(f'Expected one anchor in {name}: {old[:80]}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8', newline='\n')

# Include-only conflicts caused by reordered/deleted Chromium includes.
for rejected in WORK.rglob('*.rej'):
    p = rejected.with_suffix('')
    text = p.read_text(encoding='utf-8')
    includes = re.findall(r'^\+(#include .+)$', rejected.read_text(encoding='utf-8'), re.M)
    missing = [line for line in includes if line not in text]
    if missing:
        pos = text.index('\n', text.index('#include ')) + 1
        text = text[:pos] + '\n'.join(missing) + '\n' + text[pos:]
        p.write_text(text, encoding='utf-8', newline='\n')

change('content/browser/renderer_host/render_process_host_impl.cc',
       '      switches::kForceDeviceScaleFactor,',
       ''.join('      switches::' + name + ',\n' for name in [
           'kFingerprintingClientRectsNoise', 'kFingerprintingCanvasMeasureTextNoise',
           'kFingerprintingCanvasImageDataNoise', 'kFingerprint', 'kFingerprintBrand',
           'kFingerprintBrandVersion', 'kDisableSpoofing', 'kFingerprintScreenWidth',
           'kFingerprintScreenHeight', 'kFingerprintDeviceScaleFactor',
           'kFingerprintHardwareConcurrency', 'kFingerprintPlatform',
           'kFingerprintPlatformVersion', 'kFingerprintLocation', 'kFingerprintTimezone'])
       + '      switches::kForceDeviceScaleFactor,')

change('chrome/browser/bromite_flag_entries.h',
       '#endif  // CHROME_BROWSER_BROMITE_FLAG_ENTRIES_H_',
       '''    {"fingerprinting-canvas-image-data-noise",
     "Enable Canvas image data fingerprint deception",
     "Modify Canvas image data using the configured fingerprint seed.",
     kOsAll, SINGLE_VALUE_TYPE(switches::kFingerprintingCanvasImageDataNoise)},
#endif  // CHROME_BROWSER_BROMITE_FLAG_ENTRIES_H_''')

change('third_party/blink/renderer/core/dom/document.cc', '  DCHECK(agent_);', '''  DCHECK(agent_);
  const base::CommandLine* command_line = base::CommandLine::ForCurrentProcess();
  if (command_line->HasSwitch(switches::kFingerprint)) {
    const std::string seed = command_line->GetSwitchValueASCII(switches::kFingerprint);
    const uint32_t x = std::hash<std::string>{}(seed + "offset_x");
    const uint32_t y = std::hash<std::string>{}(seed + "offset_y");
    noise_factor_x_ = (x / 4294967295.0 - 0.5) * 0.002;
    noise_factor_y_ = (y / 4294967295.0 - 0.5) * 0.002;
  }''')
# Client-rect patches use offsets, so neutral defaults must be zero, not one.
for axis in ['x', 'y']:
    change('third_party/blink/renderer/core/dom/document.h',
           f'double noise_factor_{axis}_ = 1;', f'double noise_factor_{axis}_ = 0;')

change('third_party/blink/renderer/core/dom/element.h',
       '  ShadowRoot* OpenShadowRoot() const;',
       '  ShadowRoot* OpenShadowRoot() const;\n  ShadowRoot* FakeShadowRoot() const;')
change('third_party/blink/renderer/core/frame/navigator_ua.cc',
       '  UserAgentMetadata metadata = GetUserAgentMetadata();',
       '  UserAgentMetadata metadata = GetUserAgentMetadata();\n  UpdateUserAgentMetadataFingerprint(&metadata);')

name = 'components/embedder_support/user_agent_utils.cc'
change(name, '''  if (base::CommandLine::ForCurrentProcess()->HasSwitch(kHeadless)) {
    product.insert(0, "Headless");
  }
''', '')
change(name, '''  return ShouldSendUserAgentUnifiedPlatform()
             ? BuildUnifiedPlatformUserAgentFromProduct(product)
             : BuildUserAgentFromProduct(product);''', '''  std::string user_agent = ShouldSendUserAgentUnifiedPlatform()
             ? BuildUnifiedPlatformUserAgentFromProduct(product)
             : BuildUserAgentFromProduct(product);
  user_agent += blink::GetUserAgentFingerprintBrandInfo();
  return user_agent;''')
change(name, 'std::string GetUnifiedPlatform() {', '''std::string GetUnifiedPlatform() {
  const auto* command_line = base::CommandLine::ForCurrentProcess();
  if (command_line->HasSwitch(switches::kFingerprintPlatform)) {
    const auto platform = base::ToLowerASCII(
        command_line->GetSwitchValueASCII(switches::kFingerprintPlatform));
    if (platform == "windows") return "Windows NT 10.0; Win64; x64";
    if (platform == "linux") return "X11; Linux x86_64";
    if (platform == "macos") return "Macintosh; Intel Mac OS X 10_15_7";
  }''')

name = 'third_party/blink/renderer/modules/webaudio/offline_audio_context.cc'
rejected = (WORK / (name + '.rej')).read_text(encoding='utf-8')
added = '\n'.join(line[1:] for line in rejected.splitlines() if line.startswith('+')) + '\n'
change(name, 'OfflineAudioContext::OfflineAudioContext(LocalDOMWindow* window,',
       added + 'OfflineAudioContext::OfflineAudioContext(LocalDOMWindow* window,')

name = 'third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc'
for kind in ['Renderer', 'Vendor']:
    anchor = f'''    case WebGLDebugRendererInfo::kUnmasked{kind}Webgl:
      if (ExtensionEnabled(kWebGLDebugRendererInfoName)) {{'''
    change(name, anchor, anchor + f'''
        const auto fingerprint_value = GetGL{kind}StringForFingerprint();
        if (!fingerprint_value.empty()) {{
          return WebGLAny(script_state, String::FromUtf8(fingerprint_value));
        }}''')

# Chromium renamed the UTF-8 factory between 144 and 149.
for p in WORK.rglob('*'):
    if p.suffix in ['.cc', '.h']:
        text = p.read_text(encoding='utf-8')
        if 'FromUTF8(' in text:
            p.write_text(text.replace('FromUTF8(', 'FromUtf8('), encoding='utf-8', newline='\n')

# Upstream Adryfish passes a delta to a multiplicative API: this explains the
# near-zero/negative widths observed in 148. Preserve width scale near one.
name = 'third_party/blink/renderer/modules/canvas/canvas2d/base_rendering_context_2d.cc'
p = WORK / name
text = p.read_text(encoding='utf-8')
assert text.count('text_metrics->Shuffle(noise_x);') == 2
p.write_text(text.replace('text_metrics->Shuffle(noise_x);', 'text_metrics->Shuffle(1.0 + noise_x);'),
             encoding='utf-8', newline='\n')
print('Explicit rejected-hunk resolutions and text metric correction applied.')

# The public 144 patch hardcodes its original Chromium versions even when no
# fingerprint flags are supplied. Keep this port's default hints on real 149.
change('components/ungoogled/fingerprint_data.h', '''constexpr const char* kChromiumVersions[] = {
    "144.0.7559.132",
    "144.0.7559.109",
    "144.0.7559.96",
    "144.0.7559.59"
};''', '''constexpr const char* kChromiumVersions[] = {
    "149.0.7827.102"
};''')
change('components/ungoogled/fingerprint_data.h',
       'kChromeDefaultVersion = "144.0.7559.132"',
       'kChromeDefaultVersion = "149.0.7827.102"')

# Chromium 149 rejects unsafe indexing through the raw 2D permutation arrays.
# std::array preserves the table/order while providing bounded containers.
name = 'third_party/blink/common/user_agent/user_agent_metadata.cc'
change(name, '#include <algorithm>', '#include <algorithm>\n#include <array>')
for width in (3, 4):
    p = WORK / name
    text = p.read_text(encoding='utf-8')
    start = text.index(f'    static constexpr size_t orders[][{width}] = {{')
    end = text.index('    };', start) + len('    };')
    block = text[start:end]
    replacement = block.replace(
        f'static constexpr size_t orders[][{width}] = {{',
        f'static constexpr auto orders = std::to_array<std::array<size_t, {width}>>({{')
    replacement = replacement[:-len('    };')] + '    });'
    change(name, block, replacement)

name = 'third_party/blink/renderer/platform/fonts/font_cache.cc'
change(name, '#include "base/command_line.h"',
       '#include "base/command_line.h"\n#include "base/no_destructor.h"')
change(name, 'static const std::set<std::string> basic_fonts = {',
       'static const base::NoDestructor<std::set<std::string>> basic_fonts({')
change(name, '    "BlinkMacSystemFont"\n  };', '    "BlinkMacSystemFont"\n  });')
change(name, 'basic_fonts.count(font_family)', 'basic_fonts->count(font_family)')

name = 'third_party/blink/renderer/modules/webgl/gpu_info.cc'
change(name, '#include "base/strings/stringprintf.h"',
       '#include "base/containers/span.h"\n#include "base/no_destructor.h"\n#include "base/strings/stringprintf.h"')
change(name, 'kGpuModels[index]', 'base::span(kGpuModels)[index]')
change(name, 'kMacosGpuModels[index]', 'base::span(kMacosGpuModels)[index]')
change(name, '''  static const std::vector<GpuInfo>* windows_gpu_info = nullptr;
  if (!windows_gpu_info) {
    windows_gpu_info = new std::vector<GpuInfo>(GetAllWindowsGpuInfo());
  }''', '''  static const base::NoDestructor<std::vector<GpuInfo>> windows_gpu_info(
      GetAllWindowsGpuInfo());''')

# Use Skia's typed pixel accessors with the real buffer extent and stride.
# Source crop coordinates are not dimensions of the destination pixel buffer.
name = 'third_party/blink/renderer/platform/graphics/static_bitmap_image.h'
change(name, '#include "third_party/skia/include/core/SkRefCnt.h"',
       '#include "third_party/skia/include/core/SkRefCnt.h"\n#include "third_party/skia/include/core/SkPixmap.h"')
change(name, 'ShuffleSubchannelColorData(const void *addr, const SkImageInfo& info, int srcX, int srcY)',
       'ShuffleSubchannelColorData(const SkPixmap& pixmap)')
name = 'third_party/blink/renderer/platform/graphics/static_bitmap_image.cc'
change(name, '#define writable_addr(T, p, stride, x, y) (T*)((const char *)p + y * stride + x * sizeof(T))\n', '')
change(name, '''void StaticBitmapImage::ShuffleSubchannelColorData(const void *addr, const SkImageInfo& info, int srcX, int srcY) {
  auto w = info.width() - srcX, h = info.height() - srcY;''', '''void StaticBitmapImage::ShuffleSubchannelColorData(const SkPixmap& pixmap) {
  const SkImageInfo& info = pixmap.info();
  const int w = info.width(), h = info.height();
  if (!pixmap.addr() || pixmap.rowBytes() < info.minRowBytes())
    return;''')
change(name, 'auto fRowBytes = info.minRowBytes(); // stride', 'auto fRowBytes = pixmap.rowBytes(); // actual stride')
change(name, 'auto max_pixels = (w * h) / 128;', 'auto max_pixels = (static_cast<int64_t>(w) * h) / 128;')
for bits in (8, 16, 32):
    p = WORK / name
    text = p.read_text(encoding='utf-8')
    old = f'writable_addr(uint{bits}_t, addr, fRowBytes, '
    assert text.count(old) == 6
    p.write_text(text.replace(old, f'pixmap.writable_addr{bits}('), encoding='utf-8', newline='\n')

change('third_party/blink/renderer/core/html/canvas/html_canvas_element.cc',
       'pixel_buffer.data(), image_info, 0, 0);',
       'SkPixmap(image_info, pixel_buffer.data(), row_bytes));')
change('third_party/blink/renderer/modules/canvas/canvas2d/base_rendering_context_2d.cc',
       'ShuffleSubchannelColorData(image_data_pixmap.addr(), image_data_pixmap.info(), sx, sy);',
       'ShuffleSubchannelColorData(image_data_pixmap);')
change('third_party/blink/renderer/platform/graphics/image_data_buffer.cc',
       'ShuffleSubchannelColorData(pixmap_.writable_addr(), pixmap_.info(), 0, 0);',
       'ShuffleSubchannelColorData(pixmap_);')
change('third_party/blink/renderer/platform/image-encoders/image_encoder.cc',
       'ShuffleSubchannelColorData(src.writable_addr(), src.info(), 0, 0);',
       'ShuffleSubchannelColorData(src);')

# Do not reinterpret packed, floating-point or non-RGBA WebGL buffers as RGBA8.
# Non-default row lengths/skips retain the original unmodified readback.
name = 'third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc'
text = (WORK / name).read_text(encoding='utf-8')
end_token = '      StaticBitmapImage::ShuffleSubchannelColorData(data, image_info, 0, 0);'
end = text.index(end_token) + len(end_token)
start = text.rfind('      SkColorType color_type;', 0, end)
assert start >= 0
change(name, text[start:end], '''      if (format != GL_RGBA || type != GL_UNSIGNED_BYTE ||
          width <= 0 || height <= 0) {
        return;
      }
      const auto pack = GetPackPixelStoreParams();
      const SkImageInfo image_info = SkImageInfo::Make(
          width, height, kRGBA_8888_SkColorType, kUnpremul_SkAlphaType);
      const size_t row_bytes = image_info.minRowBytes();
      if (pack.row_length != 0 || pack.skip_pixels != 0 || pack.skip_rows != 0 ||
          pack.alignment <= 0 || row_bytes % pack.alignment != 0 ||
          image_info.computeMinByteSize() > buffer_size.ValueOrDie()) {
        return;
      }
      StaticBitmapImage::ShuffleSubchannelColorData(
          SkPixmap(image_info, data, row_bytes));''')

# New direct dependencies introduced into Chromium's non-Ungoogled targets.
for name, target in [
    ('components/embedder_support/BUILD.gn', 'static_library("user_agent")'),
    ('third_party/blink/common/BUILD.gn', 'source_set("common")'),
]:
    p = WORK / name
    text = (ROOT / 'upstream' / name).read_text(encoding='utf-8')
    pos = text.index('  deps = [', text.index(target)) + len('  deps = [')
    p.write_text(text[:pos] + '\n    "//components/ungoogled:ungoogled_switches",' + text[pos:],
                 encoding='utf-8', newline='\n')

name = 'third_party/blink/renderer/platform/BUILD.gn'
p = WORK / name
text = p.read_text(encoding='utf-8')
text = text.replace('    "//components/ungoogled:ungoogled_switches",\n', '')
pos = text.index('  public_deps = [', text.index('component("platform")')) + len('  public_deps = [')
p.write_text(text[:pos] + '\n    "//components/ungoogled:ungoogled_switches",' + text[pos:],
             encoding='utf-8', newline='\n')

name = 'third_party/blink/public/common/user_agent/user_agent_metadata.h'
change(name, 'void UpdateUserAgentMetadataFingerprint(', 'BLINK_COMMON_EXPORT void UpdateUserAgentMetadataFingerprint(')
change(name, 'std::string GetUserAgentFingerprintBrandInfo();',
       'BLINK_COMMON_EXPORT std::string GetUserAgentFingerprintBrandInfo();')
for p in WORK.rglob('*.cc'):
    text = p.read_text(encoding='utf-8')
    if 'std::hash<' in text and '#include <functional>' not in text:
        pos = text.index('\n', text.index('#include ')) + 1
        p.write_text(text[:pos] + '#include <functional>\n' + text[pos:], encoding='utf-8', newline='\n')
