const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const firebaseService = require('../firebase-service');

test('createServiceAccountJwt produces valid RS256 JWT structure', () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = {
    client_email: 'test-admin@test.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };

  const jwt = firebaseService.createServiceAccountJwt(sa);
  assert.ok(typeof jwt === 'string');
  const parts = jwt.split('.');
  assert.equal(parts.length, 3);

  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  assert.equal(header.alg, 'RS256');
  assert.equal(header.typ, 'JWT');

  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  assert.equal(payload.iss, sa.client_email);
  assert.ok(payload.scope.includes('firebase.database'));
  assert.ok(payload.exp > payload.iat);
});
