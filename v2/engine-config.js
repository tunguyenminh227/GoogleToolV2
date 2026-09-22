const fs = require('node:fs');
const path = require('node:path');

// Default 148 is selected by the user for comparison testing.
// Keep validation history in the manifest; selection does not imply all tests passed.
const requested = process.env.GOOGLETOOL_ENGINE || '148';
if (!['148', '149', '151'].includes(requested)) throw new Error('Phiên bản GoogleTool engine không hợp lệ.');
const manifestFile = path.join(__dirname, `engine${requested}`, 'build-manifest.json');
const manifest = requested !== '148' && fs.existsSync(manifestFile)
  ? JSON.parse(fs.readFileSync(manifestFile, 'utf8').replace(/^\uFEFF/, '')) : null;
const trial = requested !== '148';
const major = requested;
const version = { '148': '148.0.7778.215', '149': '149.0.7827.102', '151': '151.0.7922.173' }[major];
let executable = path.join(__dirname, 'runtime', `adryfish-${version}`,
  'ungoogled-chromium_148.0.7778.215-1.1_windows_x64', 'chrome.exe');
let hashes = {
  'chrome.exe': '1867319e56bcabbc4681d8575c002106ce7b61b5290dc5eb34a37676805f6915',
  'chrome.dll': '4dccd72386d833fccc3e861dd981bd708c4bf412393127606a57f205c69c8408',
};
// Each local build retains its own version, hashes and profile namespace.
if (trial) {
  executable = `E:\\GoogleToolBuild${major}\\src\\out\\GoogleTool${major}\\chrome.exe`;
  hashes = null;
  if (manifest) {
    if (manifest.compiled !== true || manifest.version !== version || !path.isAbsolute(manifest.executable) ||
        !manifest.hashes || !['chrome.exe', 'chrome.dll'].every(name => /^[a-f0-9]{64}$/.test(manifest.hashes[name]))) {
      throw new Error(`Thông tin bản build Chromium ${major} không hợp lệ.`);
    }
    executable = manifest.executable;
    hashes = manifest.hashes;
  }
}
module.exports = Object.freeze({
  major, version, executable, hashes: hashes && Object.freeze(hashes),
  id: `adryfish-${major}`, label: `Chromium ${major}`,
  dataNamespace: `googletool-v2-adryfish${major}`,
  profileDirectory: `profiles-adryfish${major}`,
  missingMessage: trial ? `Chưa có bản build Chromium ${major} hoàn tất hoặc thiếu manifest xác minh.`
    : 'Chưa có Chromium 148. Chạy v2/setup-chromium148.ps1.',
});
