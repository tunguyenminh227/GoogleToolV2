const trace = require('./trace-log');

// Pool worker TỰ DÒ TRẦN (AIMD) — port từ Pool-Worker/server/queryPool.ts sang CommonJS (repo không dùng TypeScript).
//  - nhận task bất kỳ lúc nào qua run() -> hợp BFS/đệ quy
//  - TĂNG concurrency dần khi liên tục thành công (additive increase) để dò tốc độ tối đa
//  - gặp lỗi QUOTA/RATE LIMIT -> ghi nhớ "trần", DỪNG TOÀN BỘ task đang chờ, GIẢM mạnh concurrency
//    (multiplicative decrease) và back off đúng thời gian API báo, rồi tự ramp lại.
//
// Thuật toán giữ nguyên bản gốc. Chỉ khác: instance dùng chung ở cuối file cấu hình cho Google Ads API
// (isAdsQuotaError / adsBlockMsOf) và biến môi trường đổi tên theo app.

/** Lỗi báo pool đang tạm dừng vì quota — task bị từ chối thay vì gọi API tiếp. */
class QuotaStopError extends Error {
  constructor(message = 'Pool đang tạm dừng do lỗi quota (rate limit).') {
    super(message);
    this.name = 'QuotaStopError';
  }
}

/** Mặc định: nhận diện quota/rate limit kiểu gRPC RESOURCE_EXHAUSTED (code 8) hoặc HTTP 429. */
function defaultIsQuotaError(e) {
  const err = e;
  if (err?.code === 8 || err?.code === 429 || err?.status === 429) return true;
  return /RESOURCE_EXHAUSTED|rate.?limit|too many requests|quota/i.test(String(err?.message ?? ''));
}

/**
 * Mặc định: lấy thời gian chờ từ retry_delay kiểu google.protobuf.Duration ({ seconds, nanos }),
 * hoặc từ retryAfter/retry_after (giây). Không có -> trả 0 để pool dùng fallbackBlockMs.
 */
function defaultBlockMsOf(e) {
  const err = e;
  const d = err?.errors?.[0]?.details?.quota_error_details?.retry_delay;
  if (d) {
    const ms = Number(d.seconds ?? 0) * 1000 + Math.round(Number(d.nanos ?? 0) / 1e6);
    if (ms > 0) return ms;
  }
  const sec = Number(err?.retryAfter ?? err?.retry_after ?? 0);
  return sec > 0 ? sec * 1000 : 0;
}

/**
 * @typedef {object} QueryPoolOptions
 * @property {number} [start] Concurrency khởi đầu (mặc định 10).
 * @property {number} [min] Concurrency tối thiểu khi back off (mặc định 2).
 * @property {number} [hardCap] Trần cứng khi dò (mặc định 80) — không vượt quá.
 * @property {number} [fallbackBlockMs] Block fallback nếu lỗi quota không kèm thời gian chờ (mặc định 60s).
 * @property {number} [probeBatch] Số task thành công liên tiếp để +1 concurrency (mặc định 5).
 * @property {number} [recoveryMs] Sau bao lâu KHÔNG trip thì quên ceiling để dò lại lên cao (ms, mặc định 30s). 0 = tắt.
 * @property {(e: unknown) => boolean} [isQuotaError] Nhận diện lỗi quota của API bạn dùng (mặc định defaultIsQuotaError).
 * @property {(e: unknown) => number} [blockMsOf] Thời gian back off API yêu cầu, tính bằng ms; trả 0 = dùng fallbackBlockMs.
 */

/**
 * Các knob an toàn cho phép chỉnh từ UI.
 * @typedef {object} PoolConfig
 * @property {number} start Concurrency khởi đầu — mức bắt đầu dò; set lại = nhảy về mức này + quên trần.
 * @property {number} min
 * @property {number} hardCap
 * @property {number} probeBatch
 * @property {number} fallbackBlockMs
 * @property {number} recoveryMs Tự hồi phục: lâu không trip thì quên ceiling để dò lại (ms). 0 = tắt.
 */

class QueryPool {
  /** @param {QueryPoolOptions} o */
  constructor(o = {}) {
    this.active = 0;
    this.queue = [];
    this.pausedUntil = 0; // > now() => đang back off vì quota
    this.lastBlockMs = 0; // thời gian block của lần quota gần nhất
    this.lastTripAt = 0; // lần trip quota gần nhất (cho hồi phục ceiling)
    this.ceiling = 0; // trần concurrency đã dò được (0 = chưa biết / đã quên)
    this.successSinceBump = 0;
    this.quotaTrips = 0;
    this.min = Math.max(1, Math.floor(o.min ?? 2));
    this.hardCap = Math.max(this.min, Math.floor(o.hardCap ?? 80));
    this.startN = Math.min(this.hardCap, Math.max(this.min, Math.floor(o.start ?? 10))); // worker khởi đầu (concurrency bắt đầu dò)
    this.max = this.startN; // concurrency hiện tại (biến AIMD)
    this.fallbackBlockMs = Math.max(0, o.fallbackBlockMs ?? 60_000);
    this.probeBatch = Math.max(1, Math.floor(o.probeBatch ?? 5));
    this.recoveryMs = Math.max(0, Math.floor(o.recoveryMs ?? 30_000)); // lâu không trip -> quên ceiling
    this.isQuota = o.isQuotaError ?? defaultIsQuotaError;
    this.blockMsOf = o.blockMsOf ?? defaultBlockMsOf;
  }

  /** Chỉnh concurrency thủ công (vẫn nằm trong [min, hardCap]). */
  setConcurrency(n) {
    this.max = Math.min(this.hardCap, Math.max(this.min, Math.floor(n)));
    this.pump();
  }

  /** Cấu hình chỉnh được từ UI (an toàn). Không cho sửa max/ceiling/pausedUntil... (cơ chế AIMD). */
  getConfig() {
    return {
      start: this.startN,
      min: this.min,
      hardCap: this.hardCap,
      probeBatch: this.probeBatch,
      fallbackBlockMs: this.fallbackBlockMs,
      recoveryMs: this.recoveryMs,
    };
  }

  /** Áp cấu hình mới NGAY trên pool đang chạy (không cần restart). Tự kẹp concurrency về [min, hardCap]. */
  setConfig(p) {
    if (p.min !== undefined) this.min = Math.max(1, Math.floor(p.min));
    if (p.hardCap !== undefined) this.hardCap = Math.max(this.min, Math.floor(p.hardCap));
    if (p.probeBatch !== undefined) this.probeBatch = Math.max(1, Math.floor(p.probeBatch));
    if (p.fallbackBlockMs !== undefined) this.fallbackBlockMs = Math.max(0, Math.floor(p.fallbackBlockMs));
    if (p.recoveryMs !== undefined) this.recoveryMs = Math.max(0, Math.floor(p.recoveryMs));
    if (p.start !== undefined) {
      this.startN = Math.min(this.hardCap, Math.max(this.min, Math.floor(p.start)));
      this.max = this.startN; // nhảy concurrency hiện tại về mức khởi đầu
      this.ceiling = 0; // quên trần đã học -> dò lại từ start (gỡ kẹt thủ công)
    }
    this.max = Math.min(this.hardCap, Math.max(this.min, this.max)); // kẹp concurrency hiện tại vào dải mới
    this.pump();
  }

  get concurrency() {
    return this.max;
  }
  get pending() {
    return this.queue.length;
  }
  get running() {
    return this.active;
  }
  get paused() {
    return Date.now() < this.pausedUntil;
  }
  get blockedForMs() {
    return Math.max(0, this.pausedUntil - Date.now());
  }
  get phase() {
    if (this.paused) return 'cooldown';
    if (this.ceiling > 0 && this.max >= this.ceiling) return 'stable';
    return 'ramping';
  }

  stats() {
    return {
      concurrency: this.max,
      running: this.active,
      pending: this.queue.length,
      paused: this.paused,
      blockedForMs: this.blockedForMs,
      blockedUntil: this.pausedUntil,
      lastBlockMs: this.lastBlockMs,
      ceiling: this.ceiling || null,
      hardCap: this.hardCap,
      probePhase: this.phase,
      quotaTrips: this.quotaTrips,
    };
  }

  /** Đẩy 1 task vào pool; trả promise kết quả. Từ chối ngay nếu đang back off quota. */
  run(task) {
    if (this.paused) return Promise.reject(new QuotaStopError());
    return new Promise((resolve, reject) => {
      this.queue.push({ run: task, resolve, reject });
      this.pump();
    });
  }

  pump() {
    if (this.paused) return;
    while (this.active < this.max && this.queue.length > 0) {
      const job = this.queue.shift();
      this.active++;
      void job
        .run()
        .then((v) => {
          job.resolve(v);
          this.onSuccess();
        })
        .catch((e) => {
          if (this.isQuota(e)) this.trip(e);
          job.reject(e);
        })
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }

  /** AIMD additive-increase: dò trần bằng cách +1 concurrency sau mỗi lô thành công. */
  onSuccess() {
    if (this.paused) return;
    // HỒI PHỤC: đã lâu không trip -> QUÊN ceiling để dò lại lên cao (gỡ "kẹt ở mức thấp" sau 1 đợt quota thoáng qua).
    if (this.ceiling > 0 && this.recoveryMs > 0 && Date.now() - this.lastTripAt >= this.recoveryMs) {
      this.ceiling = 0;
    }
    const target = this.ceiling > 0 ? this.ceiling : this.hardCap;
    if (this.max >= target) return;
    if (++this.successSinceBump >= this.probeBatch) {
      this.max = Math.min(this.hardCap, this.max + 1);
      this.successSinceBump = 0;
    }
  }

  /** Dính quota -> ghi trần, giảm mạnh concurrency, dừng toàn bộ task chờ, back off. */
  trip(err) {
    this.quotaTrips++;
    this.lastTripAt = Date.now(); // mốc để tính hồi phục ceiling
    this.ceiling = Math.max(this.min, this.max - 1); // trần = điểm vỡ - 1 (biên an toàn)
    this.max = Math.max(this.min, Math.ceil(this.ceiling / 2)); // multiplicative decrease
    this.successSinceBump = 0;
    this.lastBlockMs = this.blockMsOf(err) || this.fallbackBlockMs;
    this.pausedUntil = Date.now() + this.lastBlockMs;
    const waiting = this.queue.splice(0);
    for (const j of waiting) j.reject(new QuotaStopError());
  }
}

// ---------------------------------------------------------------------------------------------
// Google Ads API (REST) — dạng lỗi rate limit:
//   HTTP 429, body { error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [ { errors: [ {
//     errorCode: { quotaError: 'RESOURCE_EXHAUSTED' | 'RESOURCE_TEMPORARILY_EXHAUSTED' | ... },
//     details: { quotaErrorDetails: { rateScope, rateName, retryDelay: '30s' } } } ] } ] } }
// Lỗi này do ads-verification.js ném ra dưới dạng AdsApiError { status, body, retryAfter }.

/** Lỗi HTTP từ Google Ads API mang theo status, body JSON và header Retry-After (nếu có). */
class AdsApiError extends Error {
  constructor(status, body, retryAfter = null) {
    super(body?.error?.message || `Google Ads API HTTP ${status}`);
    this.name = 'AdsApiError';
    this.status = status;
    this.body = body;
    this.retryAfter = retryAfter;
  }
}

const adsFailureErrors = trace.traced('queryPool.adsFailureErrors', body => (body?.error?.details || []).flatMap(d => (Array.isArray(d?.errors) ? d.errors : [])));

/** Quota Google Ads: HTTP 429, status RESOURCE_EXHAUSTED, hoặc có errorCode.quotaError trong GoogleAdsFailure. */
const isAdsQuotaError = trace.traced('queryPool.isAdsQuotaError', e => {
  if (!(e instanceof AdsApiError)) return false;
  if (e.status === 429 || e.body?.error?.status === 'RESOURCE_EXHAUSTED') return true;
  return adsFailureErrors(e.body).some(item => item?.errorCode?.quotaError);
});

// Duration JSON của protobuf: chuỗi giây như "30s" hoặc "1.5s"
const durationMs = trace.traced('queryPool.durationMs', value => {
  const match = /^(\d+(?:\.\d+)?)s$/.exec(String(value ?? '').trim());
  return match ? Math.round(Number(match[1]) * 1000) : 0;
});

/** Thời gian back off: retryDelay lớn nhất trong quotaErrorDetails, rồi tới header Retry-After; 0 = fallbackBlockMs. */
const adsBlockMsOf = trace.traced('queryPool.adsBlockMsOf', e => {
  const delays = adsFailureErrors(e?.body).map(item => durationMs(item?.details?.quotaErrorDetails?.retryDelay));
  const retryDelayMs = Math.max(0, ...delays);
  if (retryDelayMs > 0) return retryDelayMs;
  const header = String(e?.retryAfter ?? '').trim();
  if (!header) return 0;
  if (/^\d+$/.test(header)) return Number(header) * 1000;
  const date = Date.parse(header); // Retry-After dạng HTTP-date
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
});

/** Pool dùng chung cho toàn app — mọi lệnh gọi Google Ads API phải đi qua queryPool.run(). */
const queryPool = new QueryPool({
  start: Number(process.env.GOOGLETOOL_ADS_POOL_START) || 10,
  hardCap: Number(process.env.GOOGLETOOL_ADS_POOL_HARD_CAP) || 80,
  isQuotaError: isAdsQuotaError,
  blockMsOf: adsBlockMsOf,
});

// Thời gian chờ tối đa cho mỗi task trong pool (pool không tự có timeout — API treo sẽ chiếm slot vĩnh viễn).
let taskTimeoutMs = Number(process.env.GOOGLETOOL_ADS_POOL_TASK_TIMEOUT_MS) || 180_000;
const getTaskTimeoutMs = trace.traced('queryPool.getTaskTimeoutMs', () => taskTimeoutMs);
const setTaskTimeoutMs = trace.traced('queryPool.setTaskTimeoutMs', ms => { taskTimeoutMs = Math.max(1000, Math.floor(ms)); });

module.exports = {
  QueryPool,
  QuotaStopError,
  defaultIsQuotaError,
  defaultBlockMsOf,
  AdsApiError,
  isAdsQuotaError,
  adsBlockMsOf,
  queryPool,
  getTaskTimeoutMs,
  setTaskTimeoutMs,
};
