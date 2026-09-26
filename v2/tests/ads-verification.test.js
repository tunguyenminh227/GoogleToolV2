const test = require('node:test');
const assert = require('node:assert/strict');
const { traced: t } = require('../trace-log');
const {
  cleanCustomerId,
  formatCustomerId,
  getAccessToken,
  scanMccVerification,
} = require('../ads-verification');

test('cleanCustomerId strips non-digits correctly', t('test.cleanCustomerId', () => {
  assert.equal(cleanCustomerId('123-456-7890'), '1234567890');
  assert.equal(cleanCustomerId('  123 456 7890  '), '1234567890');
  assert.equal(cleanCustomerId('abc123def456'), '123456');
  assert.equal(cleanCustomerId(''), '');
  assert.equal(cleanCustomerId(null), '');
}));

test('formatCustomerId formats 10-digit IDs nicely', t('test.formatCustomerId', () => {
  assert.equal(formatCustomerId('1234567890'), '123-456-7890');
  assert.equal(formatCustomerId('123-456-7890'), '123-456-7890');
  assert.equal(formatCustomerId('123'), '123');
  assert.equal(formatCustomerId(null), '');
}));

test('getAccessToken throws if required OAuth2 fields are missing', t('test.getAccessTokenMissingFields', async () => {
  await assert.rejects(
    () => getAccessToken({}),
    /Chưa cấu hình Client ID, Client Secret hoặc chưa có Refresh Token/
  );
  await assert.rejects(
    () => getAccessToken({ clientId: 'id', clientSecret: 'sec' }),
    /Chưa cấu hình Client ID, Client Secret hoặc chưa có Refresh Token/
  );
}));

test('scanMccVerification throws if mccId is invalid', t('test.scanMccVerificationValidation', async () => {
  await assert.rejects(
    () => scanMccVerification({}, '123'),
    /Vui lòng nhập ID MCC hợp lệ/
  );
  await assert.rejects(
    () => scanMccVerification({}, ''),
    /Vui lòng nhập ID MCC hợp lệ/
  );
}));
