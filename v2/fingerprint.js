const { randomInt } = require('node:crypto');
const engine = require('./engine-config');
const { normalize } = require('./fingerprint-config');

const GPU_PRESETS = Object.freeze({ auto: { label: 'GPU tự động theo seed' }, real: { label: 'GPU thật của máy' } });

function createFingerprint(gpu = 'auto', usedSeeds = new Set()) {
  if (gpu !== 'auto' && !Object.hasOwn(GPU_PRESETS, gpu)) throw new Error('GPU không hợp lệ.');
  let seed;
  do { seed = randomInt(1, 0x7fffffff); } while (usedSeeds.has(seed));
  const locale = Intl.DateTimeFormat().resolvedOptions();
  return { engine: engine.id, seed, gpu: gpu,
    locale: locale.locale, timezone: locale.timeZone };
}

function validateFingerprint(value) {
  if (!value || value.engine !== engine.id || !Number.isInteger(value.seed) || value.seed < 1 || value.seed >= 0x7fffffff || !Object.hasOwn(GPU_PRESETS, value.gpu)) {
    throw new Error('Cấu hình fingerprint không hợp lệ.');
  }
  try {
    if (typeof value.locale !== 'string' || typeof value.timezone !== 'string') throw new Error();
    new Intl.DateTimeFormat(value.locale, { timeZone: value.timezone });
  } catch (_) { throw new Error('Ngôn ngữ hoặc múi giờ fingerprint không hợp lệ.'); }
  normalize(value);
  return value;
}

function fingerprintArgs(value) {
  validateFingerprint(value);
  const config = normalize(value);
  const languages = [...new Set([value.locale, value.locale.split('-')[0]])].join(',');
  const args = [
    `--fingerprint=${value.seed}`, `--fingerprint-platform=${config.platform}`,
    '--fingerprint-brand=Chrome', `--fingerprint-brand-version=${engine.version}`,
    `--fingerprint-hardware-concurrency=${config.hardwareConcurrency}`,
    `--timezone=${value.timezone}`, `--lang=${value.locale}`, `--accept-lang=${languages}`,
  ];
  const disabled = ['canvas', 'audio', 'font', 'clientrects'].filter(key => config[key] === 'off');
  if (config.gpu === 'real') disabled.push('gpu');
  if (disabled.length) args.push(`--disable-spoofing=${disabled.join(',')}`);
  if (config.resolution !== 'native') {
    const [width, height] = config.resolution.split('x');
    args.push(`--fingerprint-screen-width=${width}`, `--fingerprint-screen-height=${height}`);
  }
  if (config.proxyUrl) args.push(`--proxy-server=${config.proxyUrl}`);
  if (config.webrtc === 'restrict') args.push('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
  return args;
}

module.exports = { GPU_PRESETS, createFingerprint, validateFingerprint, fingerprintArgs };
