const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspectChromium, CHROMIUM_VERSION, launchArgs } = require('../chromium-runtime');
const { createFingerprint, fingerprintArgs } = require('../fingerprint');

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'googletool-chromium-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('requires the pinned fingerprint engine, not just any Chromium executable', t => {
  const file = path.join(directory(t), 'chrome.exe');
  fs.writeFileSync(file, 'fixture');
  assert.equal(inspectChromium(file, { readVersion: () => CHROMIUM_VERSION, verifyEngine() {} }).ready, true);
  assert.equal(inspectChromium(file, { readVersion: () => '151.0.7922.138', verifyEngine() {} }).ready, false);
  assert.equal(inspectChromium(file, { readVersion: () => CHROMIUM_VERSION, verifyEngine() { throw new Error('Wrong engine hash'); } }).ready, false);
  assert.equal(inspectChromium(null).ready, false);
});
test('launch arguments retain the seed and automatic GPU configuration without shell interpretation', t => {
  const root = directory(t);
  const fingerprint = createFingerprint();
  const args = launchArgs(root, 'https://iphey.com/', fingerprint);
  assert.ok(args.includes(`--fingerprint=${fingerprint.seed}`));
  assert.ok(!args.some(arg => arg.startsWith('--uxr-') || arg.startsWith('--fingerprint-gpu-')));
  assert.throws(() => createFingerprint('intel-630'));
  assert.deepEqual(args, launchArgs(root, 'https://iphey.com/', JSON.parse(JSON.stringify(fingerprint))));
  const resume = launchArgs(root, null, fingerprint);
  assert.ok(!resume.includes('--new-window'));
  assert.ok(resume.every(arg => arg.startsWith('--')));
  assert.ok(resume.includes('--window-size=1280,720'));
  assert.ok(!args.some(arg => /no-sandbox|disable-web-security|remote-debugging/.test(arg)));
  assert.throws(() => launchArgs(root, 'https://unapproved.example/', fingerprint));
  assert.throws(() => fingerprintArgs({ ...fingerprint, seed: '--another-flag' }));
  assert.throws(() => createFingerprint('toString'));
});
test('protects profiles from a downgrade from a newer Chromium', t => {
  const root = directory(t);
  const fingerprint = createFingerprint();
  fs.writeFileSync(path.join(root, 'Last Version'), `${Number(CHROMIUM_VERSION.split('.')[0]) + 1}.0.0.0`);
  assert.throws(() => launchArgs(root, 'https://iphey.com/', fingerprint), /mới hơn/);
  fs.writeFileSync(path.join(root, 'Last Version'), CHROMIUM_VERSION);
  assert.ok(launchArgs(root, 'https://iphey.com/', fingerprint).length);
});

test('retains Client Hints and saved locale without overriding the user agent', () => {
  const fp = { ...createFingerprint(), locale: 'en-GB', timezone: 'Asia/Saigon' };
  const args = fingerprintArgs(fp);
  assert.ok(!args.some(arg => arg.startsWith('--user-agent=')));
  assert.ok(args.includes('--lang=en-GB'));
  assert.ok(args.includes('--accept-lang=en-GB,en'));
  assert.ok(args.includes('--timezone=Asia/Saigon'));
  assert.ok(args.includes(`--fingerprint-brand-version=${CHROMIUM_VERSION}`));
});
