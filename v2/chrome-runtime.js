const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CHROME_MAJOR = 151;
const CHROME_VERSION = '151.0.7922.138';
const BUNDLED_CHROME = path.join(__dirname, 'runtime', CHROME_VERSION, 'chrome-win64', 'chrome.exe');
const versionCache = new Map();

function readVersion(file) {
  const stat = fs.statSync(file);
  const key = `${file}:${stat.size}:${stat.mtimeMs}`;
  if (versionCache.has(key)) return versionCache.get(key);
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const version = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command',
    '(Get-Item -LiteralPath $env:GOOGLETOOL_CHROME_FILE).VersionInfo.ProductVersion'], {
    encoding: 'utf8', windowsHide: true, timeout: 10000,
    env: { ...process.env, GOOGLETOOL_CHROME_FILE: file },
  }).trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) throw new Error('Không đọc được phiên bản Chrome.');
  versionCache.set(key, version);
  return version;
}

function inspectChrome(file, getVersion = readVersion) {
  if (!file || !fs.existsSync(file)) return { path: null, version: null, ready: false, error: 'Chưa có Chrome 151. Chạy setup-chrome151.ps1 hoặc chọn chrome.exe phiên bản 151.' };
  try {
    const version = getVersion(file);
    const ready = Number(version.split('.')[0]) === CHROME_MAJOR;
    return { path: file, version, ready, error: ready ? null : `Đã tìm thấy Chrome ${version}. V2 yêu cầu Chrome 151.` };
  } catch (error) {
    return { path: file, version: null, ready: false, error: `Không xác minh được Chrome: ${error.message}` };
  }
}

function resolveChrome(selected, getVersion = readVersion) {
  if (selected) return inspectChrome(selected, getVersion);
  const candidates = [BUNDLED_CHROME,
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  let detected;
  for (const candidate of candidates.filter(Boolean)) {
    if (!fs.existsSync(candidate)) continue;
    const info = inspectChrome(candidate, getVersion);
    if (info.ready) return info;
    detected ||= info;
  }
  return detected || inspectChrome(null);
}

function launchArgs(directory, url) {
  if (url !== null && !['https://mail.google.com/', 'https://iphey.com/', 'https://ads.google.com/aw/billing/advertiserverification'].includes(url) && !url.startsWith('https://ads.google.com/')) throw new Error('Địa chỉ mở profile không hợp lệ.');
  // Never downgrade a data directory already opened by a newer Chrome.
  const marker = path.join(directory, 'Last Version');
  if (fs.existsSync(marker)) {
    const lastVersion = fs.readFileSync(marker, 'utf8').trim();
    if (Number(lastVersion.split('.')[0]) > CHROME_MAJOR) {
      throw new Error(`Profile đã chạy Chrome ${lastVersion}; hãy tạo profile mới cho Chrome 151 để tránh lỗi dữ liệu.`);
    }
  }
  return [`--user-data-dir=${directory}`, '--no-first-run', '--no-default-browser-check', '--new-window', url];
}

module.exports = { CHROME_MAJOR, CHROME_VERSION, BUNDLED_CHROME, readVersion, inspectChrome, resolveChrome, launchArgs };
