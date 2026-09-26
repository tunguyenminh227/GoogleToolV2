const test = require('node:test');
const assert = require('node:assert/strict');

test('secret-config encrypts and decrypts sensitive fields in gcpAdsConfig and proxyPassword', () => {
  const electronMock = {
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: str => Buffer.from(`ENC:${str}`),
      decryptString: buf => {
        const str = buf.toString();
        if (str.startsWith('ENC:')) return str.slice(4);
        throw new Error('Invalid ciphertext');
      },
    },
  };
  require.cache[require.resolve('electron')] = { exports: electronMock };
  const secretConfig = require('../secret-config');

  const original = {
    chromiumPath: 'C:\\path\\to\\chrome.exe',
    proxyPassword: 'secret-proxy-pass',
    gcpAdsConfig: {
      clientId: '12345-abc.apps.googleusercontent.com',
      clientSecret: 'secret-client-xyz',
      developerToken: 'secret-dev-token',
      refreshToken: 'secret-refresh-token',
      loginCustomerId: '1234567890',
    },
  };

  const stringified = secretConfig.stringify(original);
  assert.ok(!stringified.includes('secret-proxy-pass'));
  assert.ok(!stringified.includes('secret-client-xyz'));
  assert.ok(!stringified.includes('secret-dev-token'));
  assert.ok(!stringified.includes('secret-refresh-token'));
  assert.ok(stringified.includes('12345-abc.apps.googleusercontent.com'));
  assert.ok(stringified.includes('1234567890'));

  const parsed = secretConfig.parse(stringified);
  assert.deepEqual(parsed, original);
});
