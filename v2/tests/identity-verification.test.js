const test = require('node:test');
const assert = require('node:assert/strict');
const ads = require('../ads-verification');

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const verification = progress => ({
  identityVerification: [{
    verificationProgram: 'ADVERTISER_IDENTITY_VERIFICATION',
    identityVerificationRequirement: { verificationCompletionDeadlineTime: '2026-12-01 00:00:00' },
    ...(progress ? { verificationProgress: progress } : {}),
  }],
});

// Giả lập GetIdentityVerification theo chuỗi phản hồi; đếm số lần StartIdentityVerification
function mockApi(t, getResponses, startOk = true) {
  const calls = { get: 0, start: 0 };
  t.mock.method(globalThis, 'fetch', async url => {
    url = String(url);
    if (url.endsWith(':startIdentityVerification')) { calls.start++; return startOk ? json(200, {}) : json(400, { error: { message: 'session in progress' } }); }
    const response = getResponses[Math.min(calls.get, getResponses.length - 1)];
    calls.get++;
    return response();
  });
  return calls;
}
const check = () => ads.getCustomerVerification('token', '', '1111111111', '2222222222');

test('empty response = không yêu cầu, không gọi Start', async t => {
  const calls = mockApi(t, [() => json(200, {})]);
  const r = await check();
  assert.equal(r.status, 'NOT_REQUIRED');
  assert.equal(r.required, false);
  assert.equal(calls.start, 0);
});

test('lỗi API không bị coi là "không yêu cầu"', async t => {
  mockApi(t, [() => json(403, { error: { message: 'The caller does not have permission' } })]);
  const r = await check();
  assert.equal(r.status, 'API_ERROR');
  assert.equal(r.required, true);
  assert.match(r.statusText, /permission/);
});

test('chưa bắt đầu -> Start rồi đọc lại để lấy action_url', async t => {
  const calls = mockApi(t, [
    () => json(200, verification(null)),
    () => json(200, verification({ programStatus: 'PENDING_USER_ACTION', actionUrl: 'https://verify.example/new', invitationLinkExpirationTime: '2099-01-01 00:00:00' })),
  ]);
  const r = await check();
  assert.equal(calls.start, 1);
  assert.equal(r.status, 'PENDING_USER_ACTION');
  assert.equal(r.actionUrl, 'https://verify.example/new');
  assert.equal(r.deadline, '2026-12-01 00:00:00');
});

test('link hết hạn -> Start phiên mới; link còn hạn -> dùng luôn', async t => {
  const expired = mockApi(t, [
    () => json(200, verification({ programStatus: 'PENDING_USER_ACTION', actionUrl: 'https://verify.example/old', invitationLinkExpirationTime: '2000-01-01 00:00:00' })),
    () => json(200, verification({ programStatus: 'PENDING_USER_ACTION', actionUrl: 'https://verify.example/fresh', invitationLinkExpirationTime: '2099-01-01 00:00:00' })),
  ]);
  assert.equal((await check()).actionUrl, 'https://verify.example/fresh');
  assert.equal(expired.start, 1);

  t.mock.restoreAll();
  const valid = mockApi(t, [() => json(200, verification({ programStatus: 'PENDING_USER_ACTION', actionUrl: 'https://verify.example/ok', invitationLinkExpirationTime: '2099-01-01 00:00:00' }))]);
  assert.equal((await check()).actionUrl, 'https://verify.example/ok');
  assert.equal(valid.start, 0);
});

test('đang chờ duyệt / đã xác minh -> không gọi Start', async t => {
  const calls = mockApi(t, [() => json(200, verification({ programStatus: 'PENDING_REVIEW' }))]);
  const r = await check();
  assert.equal(r.statusText, 'Đang chờ Google duyệt');
  assert.equal(r.required, true);
  assert.equal(calls.start, 0);

  t.mock.restoreAll();
  mockApi(t, [() => json(200, verification({ programStatus: 'SUCCESS' }))]);
  assert.equal((await check()).required, false);
});

test('Suspend trả rỗng -> khởi tạo phiên, lấy nguyên văn link wizard có ivid', async t => {
  const wizard = 'https://ads.google.com/identity/advertiser-verification?ocid=123456&ivid=abc-session';
  const calls = mockApi(t, [
    () => json(200, {}),
    () => json(200, verification({ programStatus: 'PENDING_USER_ACTION', actionUrl: wizard, invitationLinkExpirationTime: '2099-01-01 00:00:00' })),
  ]);
  const r = await ads.getCustomerVerification('token', '', '1111111111', '2222222222', { startWhenEmpty: true });
  assert.equal(calls.start, 1);
  assert.equal(r.actionUrl, wizard);
  assert.equal(r.status, 'PENDING_USER_ACTION');
});

test('Suspend trả rỗng mà Google từ chối khởi tạo -> báo lý do, không gọi lại', async t => {
  const calls = mockApi(t, [() => json(200, {})], false);
  const r = await ads.getCustomerVerification('token', '', '1111111111', '2222222222', { startWhenEmpty: true });
  assert.equal(calls.start, 1);
  assert.equal(r.required, false);
  assert.match(r.startError, /không khởi tạo được phiên: session in progress/);
});

test('Start thất bại (đang có phiên khác) -> giữ trạng thái, dùng link mặc định', async t => {
  mockApi(t, [() => json(200, verification(null))], false);
  const r = await check();
  assert.equal(r.status, 'NOT_STARTED');
  assert.match(r.actionUrl, /advertiserverification/);
});
