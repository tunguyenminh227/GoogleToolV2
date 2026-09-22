const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const code = fs.readFileSync(path.join(__dirname, '../engine-config.js'), 'utf8');
const built = { compiled: true, version: '149.0.7827.102', executable: path.resolve('fixture/chrome.exe'),
  hashes: { 'chrome.exe': 'a'.repeat(64), 'chrome.dll': 'b'.repeat(64) }, runtimeTested: false };
function config(manifest, requested) {
  const sandbox = { module: { exports: {} }, __dirname: path.resolve(__dirname, '..'),
    process: { env: { GOOGLETOOL_ENGINE: requested } },
    require: name => name === 'node:fs' ? { existsSync: () => Boolean(manifest), readFileSync: () => JSON.stringify(manifest) } : require(name) };
  vm.runInNewContext(code, sandbox);
  return sandbox.module.exports;
}
test('148 is the test default and newer builds remain explicitly selectable', () => {
  assert.equal(config(null).major, '148');
  assert.ok(config(null).hashes['chrome.exe']);
  assert.equal(config(built, '149').major, '149');
  assert.equal(config({ ...built, version: '151.0.7922.173' }, '151').major, '151');
});
test('explicit trial/fallback selection keeps separate profile namespaces', () => {
  const old = config({ ...built, runtimeTested: true }, '148');
  const trial = config(null, '149');
  assert.equal(old.major, '148');
  assert.equal(trial.major, '149');
  assert.equal(trial.hashes, null);
  assert.notEqual(old.dataNamespace, trial.dataNamespace);
  assert.notEqual(old.profileDirectory, trial.profileDirectory);
  const latest = config({ ...built, version: '151.0.7922.173' }, '151');
  assert.notEqual(latest.dataNamespace, trial.dataNamespace);
  assert.notEqual(latest.profileDirectory, trial.profileDirectory);
});
test('an invalid completed build cannot be activated', () => {
  assert.throws(() => config({ ...built, version: '148.0.7778.215', runtimeTested: true }, '149'));
  assert.throws(() => config({ ...built, compiled: false, runtimeTested: true }, '149'));
  assert.throws(() => config(built, '152'));
  assert.throws(() => config({ ...built, version: '151.0.7922.173', compiled: false }, '151'));
  assert.throws(() => config({ ...built, version: '151.0.7922.173', hashes: {} }, '151'));
});
