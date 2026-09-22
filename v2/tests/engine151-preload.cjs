// Test-only engine selection. Does not change the app default or existing profiles.
const fs = require('node:fs');
const path = require('node:path');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../engine151/build-manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
if (!manifest.compiled || manifest.version !== '151.0.7922.173') throw new Error('151 build is not ready');
const configPath = require.resolve('../engine-config');
require(configPath);
require.cache[configPath].exports = Object.freeze({
  major: '151', version: manifest.version, executable: manifest.executable,
  hashes: Object.freeze(manifest.hashes), id: 'adryfish-151', label: 'Chromium 151',
  dataNamespace: 'googletool-v2-test151', profileDirectory: 'profiles-test151',
  missingMessage: 'Test build Chromium 151 is missing',
});
