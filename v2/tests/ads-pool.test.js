const test = require('node:test');
const assert = require('node:assert/strict');
const { queryPool, QuotaStopError, setTaskTimeoutMs } = require('../query-pool');
const adsVerification = require('../ads-verification');

// Mô phỏng Google Ads API bằng fetch giả: token OAuth luôn OK; mỗi lệnh googleAds:search chạy qua queryPool.
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const config = { clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh' };

test('mọi lệnh gọi Ads API đi qua queryPool; dính quota thì cả lượt dừng bằng QuotaStopError và pool back off', async t => {
  const ids = Array.from({ length: 40 }, (_, i) => String(1000000000 + i));
  let quotaOnce = true;
  let inFlight = 0, maxInFlight = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).startsWith('https://oauth2.googleapis.com/token')) return json(200, { access_token: 'token' });
    if (String(url).endsWith('customers:listAccessibleCustomers')) return json(200, { resourceNames: ids.map(id => `customers/${id}`) });
    assert.ok(init.signal instanceof AbortSignal, 'mỗi task phải có AbortSignal timeout');
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(resolve => setTimeout(resolve, 5));
    inFlight--;
    const id = String(url).match(/customers\/(\d+)\//)[1];
    return json(200, { results: [{ customer: { id, descriptiveName: `MCC ${id}`, manager: Number(id) % 2 === 0 } }] });
  });

  const mccs = await adsVerification.listAccessibleMccs(config);
  assert.equal(mccs.length, 20);
  assert.ok(maxInFlight <= queryPool.stats().hardCap);
  assert.ok(queryPool.concurrency > 10, 'concurrency phải tăng dần sau các lô thành công');

  // Lỗi quota thật dạng REST của Google Ads (429 + retryDelay) ở 1 lệnh gọi -> trip.
  const before = queryPool.concurrency;
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).startsWith('https://oauth2.googleapis.com/token')) return json(200, { access_token: 'token' });
    if (String(url).endsWith('customers:listAccessibleCustomers')) return json(200, { resourceNames: ids.map(id => `customers/${id}`) });
    await new Promise(resolve => setTimeout(resolve, 5));
    if (quotaOnce) {
      quotaOnce = false;
      return json(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [{ errors: [{ errorCode: { quotaError: 'RESOURCE_EXHAUSTED' }, message: 'Too many requests. Retry in 3 seconds.', details: { quotaErrorDetails: { retryDelay: '3s' } } }] }] } });
    }
    return json(200, { results: [] });
  });
  await assert.rejects(adsVerification.listAccessibleMccs(config), QuotaStopError);
  const s = queryPool.stats();
  assert.equal(s.quotaTrips, 1);
  assert.equal(s.ceiling, Math.max(2, before - 1));
  assert.equal(s.concurrency, Math.max(2, Math.ceil(s.ceiling / 2)));
  assert.equal(s.paused, true);
  assert.equal(s.lastBlockMs, 3000);
  await assert.rejects(adsVerification.scanMccSuspended(config, '1234567890'), QuotaStopError); // đang back off -> từ chối ngay
});

test('task treo quá thời gian chờ bị hủy bằng AbortSignal và trả slot cho pool', async t => {
  queryPool.pausedUntil = 0; // bỏ back off của test trước (cùng instance dùng chung)
  setTaskTimeoutMs(1000);
  t.mock.method(globalThis, 'fetch', (url, init) => {
    if (String(url).startsWith('https://oauth2.googleapis.com/token')) return Promise.resolve(json(200, { access_token: 'token' }));
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  });
  await assert.rejects(adsVerification.scanMccSuspended(config, '1234567890'), /không phản hồi sau 1 giây/);
  assert.equal(queryPool.running, 0);
});
