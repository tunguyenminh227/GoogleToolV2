const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspectChrome, launchArgs } = require('../chrome-runtime');

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'googletool-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('accepts Chrome 151 and rejects 152 without spoofing a version', t => {
  const file = path.join(directory(t), 'chrome.exe');
  fs.writeFileSync(file, 'version-reader-fixture');
  assert.equal(inspectChrome(file, () => '151.0.7922.138').ready, true);
  assert.equal(inspectChrome(file, () => '152.0.7977.83').ready, false);
  assert.equal(inspectChrome(file, () => { throw new Error('Unreadable'); }).ready, false);
  assert.equal(inspectChrome(null).ready, false);
});
test('only opens Gmail or IPhey with a separate data directory', t => {
  const root = directory(t);
  const args = launchArgs(root, 'https://iphey.com/');
  assert.equal(args[0], `--user-data-dir=${root}`);
  assert.equal(args.at(-1), 'https://iphey.com/');
  assert.ok(!args.some(arg => /user-agent|disable-web-security|no-sandbox/.test(arg)));
  assert.throws(() => launchArgs(root, '--arbitrary-flag'));
});
test('blocks downgrading profiles used by newer Chrome', t => {
  const root = directory(t);
  fs.writeFileSync(path.join(root, 'Last Version'), '152.0.7977.83');
  assert.throws(() => launchArgs(root, 'https://mail.google.com/'), /152/);
  fs.writeFileSync(path.join(root, 'Last Version'), '151.0.7922.138');
  assert.ok(launchArgs(root, 'https://mail.google.com/').length > 0);
});
