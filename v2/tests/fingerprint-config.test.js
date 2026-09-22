const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, template } = require('../fingerprint-config');
const { createFingerprint, fingerprintArgs } = require('../fingerprint');
test('configuration rejects unsupported or injectable values', () => {
  for (const input of [{ platform: '--bad' }, { resolution: '1x2' }, { canvas: 'block' },
    { hardwareConcurrency: 0 }, { locale: '--bad' }, { timezone: 'invalid' },
    { proxyUrl: 'file:///x' }, { proxyUrl: 'http://localhost:8080/?x=1' }]) assert.throws(() => normalize(input));
  assert.throws(() => template({ name: 'x'.repeat(81) }));
});

test('HTTP proxy input accepts host:port and separates URL credentials', require('../trace-log').traced('test.httpProxyInput', () => {
  assert.equal(normalize({ proxyUrl: '127.0.0.1:8080' }).proxyUrl, 'http://127.0.0.1:8080');
  const config = normalize({ proxyUrl: 'http://fixture:p%40ss%3Aword@localhost:8080' });
  assert.equal(config.proxyUsername, 'fixture');
  assert.equal(config.proxyPassword, 'p@ss:word');
  assert.equal(config.proxyUrl, 'http://localhost:8080');
  assert.ok(!fingerprintArgs({ ...createFingerprint(), ...config }).join(' ').includes('p@ss:word'));
  assert.throws(() => normalize({ proxyUrl: 'http://fixture:pass@localhost:8080', proxyUsername: 'different' }));
  assert.throws(() => normalize({ proxyUrl: 'socks4://fixture:pass@localhost:1080' }));
}));
test('configured launch uses a single validated set of engine flags', () => {
  const config = normalize({ platform: 'linux', hardwareConcurrency: 4, canvas: 'off', audio: 'off', gpu: 'real',
    proxyUrl: 'socks5://localhost:1080', webrtc: 'restrict' });
  const args = fingerprintArgs({ ...createFingerprint(), ...config });
  for (const flag of ['--fingerprint-platform=linux','--fingerprint-hardware-concurrency=4','--disable-spoofing=canvas,audio,gpu',
    '--proxy-server=socks5://localhost:1080',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp']) assert.ok(args.includes(flag), flag);
});
