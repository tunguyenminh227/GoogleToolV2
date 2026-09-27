const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { readVersion } = require('./chrome-runtime');
const { fingerprintArgs } = require('./fingerprint');
const trace = require('./trace-log');
const { normalize } = require('./fingerprint-config');
const engine = require('./engine-config');

const CHROMIUM_VERSION = engine.version;
const BUNDLED_CHROMIUM = engine.executable;
const HASHES = engine.hashes;
const verified = new Set();

function verifyEngine(file) {
  if (!HASHES) throw new Error(engine.missingMessage);
  for (const [name, expected] of Object.entries(HASHES)) {
    const item = path.join(path.dirname(file), name);
    const stat = fs.statSync(item);
    const key = `${item}:${stat.size}:${stat.mtimeMs}`;
    if (verified.has(key)) continue;
    const hash = createHash('sha256').update(fs.readFileSync(item)).digest('hex');
    if (hash !== expected) throw new Error(`File trình duyệt không khớp bản ${engine.label} đã đăng ký.`);
    verified.add(key);
  }
}

function inspectChromium(file, deps = { readVersion, verifyEngine }) {
  if (!file || !fs.existsSync(file)) return { path: null, version: null, ready: false, error: engine.missingMessage };
  try {
    const version = deps.readVersion(file);
    if (version !== CHROMIUM_VERSION) return { path: file, version, ready: false, error: `Cần Chromium Adryfish ${CHROMIUM_VERSION}; file đã chọn là ${version}.` };
    deps.verifyEngine(file);
    return { path: file, version, ready: true, error: null };
  } catch (error) { return { path: file, version: null, ready: false, error: error.message }; }
}

function resolveChromium(selected) { return inspectChromium(selected || BUNDLED_CHROMIUM); }

const ALLOWED_URLS = [
  'https://mail.google.com/',
  'https://iphey.com/',
  'https://ads.google.com/aw/billing/advertiserverification',
];

const launchArgs = trace.traced('chromium.launchArgs', (directory, url, fingerprint) => {
  if (url !== null && !ALLOWED_URLS.includes(url) && !url.startsWith('https://ads.google.com/')) throw new Error('Địa chỉ mở profile không hợp lệ.');
  const marker = path.join(directory, 'Last Version');
  if (fs.existsSync(marker)) {
    const previous = fs.readFileSync(marker, 'utf8').trim();
    const oldParts = previous.split('.').map(Number);
    const newParts = CHROMIUM_VERSION.split('.').map(Number);
    if (oldParts.length !== 4 || oldParts.some(part => !Number.isInteger(part))) throw new Error('Không đọc được phiên bản đã sử dụng của profile.');
    for (let i = 0; i < 4; i++) {
      if (oldParts[i] < newParts[i]) break;
      if (oldParts[i] > newParts[i]) throw new Error(`Profile đã dùng ${previous}, mới hơn Chromium ${CHROMIUM_VERSION}. Hãy tạo profile mới.`);
    }
  }
  return [`--user-data-dir=${directory}`, '--no-first-run', '--no-default-browser-check',
    ...(url === null ? ['--restore-last-session'] : ['--new-window', url]),
    ...fingerprintArgs(fingerprint), `--window-size=${normalize(fingerprint).windowSize.replace('x', ',')}`];
});

module.exports = { CHROMIUM_VERSION, BUNDLED_CHROMIUM, HASHES, inspectChromium, resolveChromium, launchArgs };
