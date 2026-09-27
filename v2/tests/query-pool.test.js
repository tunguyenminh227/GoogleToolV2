const test = require('node:test');
const assert = require('node:assert/strict');
const { QueryPool, QuotaStopError, AdsApiError, isAdsQuotaError, adsBlockMsOf } = require('../query-pool');
const { registerPoolRoutes } = require('../pool-routes');

const quotaBody = retryDelay => ({
  error: {
    code: 429,
    status: 'RESOURCE_EXHAUSTED',
    message: 'Resource has been exhausted (e.g. check quota).',
    details: [{ errors: [{ errorCode: { quotaError: 'RESOURCE_EXHAUSTED' }, details: { quotaErrorDetails: { rateScope: 'DEVELOPER', retryDelay } } }] }],
  },
});

test('isAdsQuotaError / adsBlockMsOf read Google Ads REST quota errors', () => {
  const quota = new AdsApiError(429, quotaBody('22.5s'));
  assert.equal(isAdsQuotaError(quota), true);
  assert.equal(adsBlockMsOf(quota), 22500);
  assert.equal(isAdsQuotaError(new AdsApiError(200, { error: { details: [{ errors: [{ errorCode: { quotaError: 'RESOURCE_TEMPORARILY_EXHAUSTED' } }] }] } })), true);
  assert.equal(adsBlockMsOf(new AdsApiError(429, {}, '7')), 7000);
  assert.equal(adsBlockMsOf(new AdsApiError(429, {})), 0);
  assert.equal(isAdsQuotaError(new AdsApiError(400, { error: { status: 'INVALID_ARGUMENT' } })), false);
  assert.equal(isAdsQuotaError(new Error('quota exceeded')), false);
});

test('pool ramps concurrency up by +1 per probeBatch successes, capped at hardCap', async () => {
  const pool = new QueryPool({ start: 2, min: 1, hardCap: 4, probeBatch: 2 });
  for (let i = 0; i < 10; i++) await pool.run(async () => i);
  assert.equal(pool.concurrency, 4);
  assert.equal(pool.stats().probePhase, 'ramping');
});

test('quota trip records ceiling, halves concurrency, rejects pending and backs off for retryDelay', async () => {
  const pool = new QueryPool({ start: 6, min: 1, hardCap: 10, isQuotaError: isAdsQuotaError, blockMsOf: adsBlockMsOf });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const running = Array.from({ length: 5 }, () => pool.run(() => gate));
  const tripped = pool.run(async () => { throw new AdsApiError(429, quotaBody('2s')); }); // slot thứ 6
  const pending = Array.from({ length: 4 }, () => pool.run(async () => 'never'));
  assert.deepEqual([pool.running, pool.pending], [6, 4]);

  await assert.rejects(tripped, AdsApiError);
  release();
  await Promise.allSettled(running);
  for (const p of pending) await assert.rejects(p, QuotaStopError);

  const s = pool.stats();
  assert.equal(s.ceiling, 5); // trần = điểm vỡ (6) - 1
  assert.equal(s.concurrency, 3); // ceil(5 / 2)
  assert.equal(s.paused, true);
  assert.equal(s.lastBlockMs, 2000);
  assert.ok(s.blockedForMs > 1500 && s.blockedForMs <= 2000);
  assert.equal(s.quotaTrips, 1);
  assert.equal(s.pending, 0);
  await assert.rejects(pool.run(async () => 1), QuotaStopError); // đang back off -> từ chối ngay
});

test('pool routes: GET stats/config, PUT clamps and persists, rejects hardCap < min', async () => {
  const pool = new QueryPool({ start: 10, hardCap: 80 });
  let timeout = 180_000;
  const handlers = {};
  const persisted = [];
  const ready = registerPoolRoutes((channel, fn) => { handlers[channel] = fn; }, {
    pool,
    prefix: '/api/pool',
    taskTimeout: { get: () => timeout, set: ms => { timeout = ms; } },
    load: async () => ({ start: 12, probeBatch: 3, taskTimeoutMs: 60_000 }),
    persist: cfg => { persisted.push(cfg); },
  });
  await ready;
  const call = (method, path, body) => handlers['v2:pool']({ method, path, body });

  assert.equal((await call('GET', '/api/pool/stats')).concurrency, 12);
  const config = await call('GET', '/api/pool/config');
  assert.deepEqual(config.pool, { start: 12, min: 2, hardCap: 80, probeBatch: 3, fallbackBlockMs: 60_000, recoveryMs: 30_000, taskTimeoutMs: 60_000 });

  const saved = await call('PUT', '/api/pool/config', { hardCap: 9999, probeBatch: 0, taskTimeoutMs: 1 });
  assert.equal(saved.pool.hardCap, 500);
  assert.equal(saved.pool.probeBatch, 1);
  assert.equal(saved.pool.taskTimeoutMs, 5000);
  assert.deepEqual(persisted, [saved.pool]);

  await assert.rejects(call('PUT', '/api/pool/config', { min: 10, hardCap: 5 }), /hardCap phải >= min/);
  await assert.rejects(call('GET', '/api/pool/nope'), /Không tìm thấy route pool/);
});
