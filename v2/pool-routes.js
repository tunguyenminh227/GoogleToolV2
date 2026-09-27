// Route đọc/ghi cấu hình pool — viết lại từ Pool-Worker/server/poolRoutes.ts (Fastify) cho IPC của Electron.
// App không có HTTP server (và CSP renderer chặn fetch): renderer gọi window.googleTool.poolRequest(method, path, body)
// qua một kênh IPC, ở đây định tuyến theo "METHOD path" dưới tiền tố prefix — cùng bộ route GET /stats, GET /config,
// PUT /config như bản gốc. Việc lưu cấu hình và việc chặn quyền truyền vào qua options.
const trace = require('./trace-log');
const t = trace.traced;

const clampInt = t('poolRoutes.clampInt', (v, lo, hi) => Math.min(hi, Math.max(lo, Math.floor(Number(v)))));

/** Giới hạn an toàn cho từng knob. taskTimeoutMs là thời gian chờ mỗi task (không thuộc QueryPool). */
const LIMITS = {
  start: [1, 500],
  min: [1, 50],
  hardCap: [1, 500],
  probeBatch: [1, 100],
  fallbackBlockMs: [1000, 600_000],
  recoveryMs: [0, 600_000],
};
const TASK_TIMEOUT_LIMIT = [5_000, 1_800_000];

/**
 * @param {(channel: string, fn: Function) => void} handle hàm đăng ký IPC của main.js
 * @param {object} opts
 * @param {import('./query-pool').QueryPool} opts.pool
 * @param {string} [opts.prefix] Tiền tố đường dẫn, mặc định '/api/pool'.
 * @param {string} [opts.channel] Kênh IPC, mặc định 'v2:pool'.
 * @param {() => void | Promise<void>} [opts.guard] Chặn quyền — ném lỗi để từ chối. Bỏ trống = ai cũng gọi được.
 * @param {{ get: () => number, set: (ms: number) => void }} [opts.taskTimeout] Thời gian chờ mỗi task.
 * @param {() => Promise<object | null | undefined>} [opts.load] Nạp cấu hình đã lưu, gọi 1 lần lúc đăng ký.
 * @param {(cfg: object) => Promise<void> | void} [opts.persist] Lưu cấu hình sau mỗi lần đổi.
 */
const registerPoolRoutes = t('poolRoutes.register', (handle, opts) => {
  const { pool, prefix = '/api/pool', channel = 'v2:pool', guard, taskTimeout, load, persist } = opts;

  const currentConfig = t('poolRoutes.currentConfig', () => (
    taskTimeout ? { ...pool.getConfig(), taskTimeoutMs: taskTimeout.get() } : pool.getConfig()
  ));
  const applySaved = t('poolRoutes.applySaved', saved => {
    const patch = {};
    for (const k of Object.keys(LIMITS)) {
      if (saved[k] !== undefined) patch[k] = clampInt(saved[k], LIMITS[k][0], LIMITS[k][1]);
    }
    if (patch.min !== undefined && patch.hardCap !== undefined && patch.hardCap < patch.min) {
      throw new Error('hardCap phải >= min');
    }
    pool.setConfig(patch);
    if (taskTimeout && saved.taskTimeoutMs !== undefined) {
      taskTimeout.set(clampInt(saved.taskTimeoutMs, TASK_TIMEOUT_LIMIT[0], TASK_TIMEOUT_LIMIT[1]));
    }
  });

  // Nạp cấu hình đã lưu ở nền — không chặn mở cửa sổ khi mạng chậm. PUT chờ bước này xong để khỏi bị ghi đè.
  const ready = load
    ? Promise.resolve().then(load).then(saved => { if (saved) applySaved(saved); })
      .catch(t('poolRoutes.loadFailed', error => console.warn('[pool] Không nạp được cấu hình pool (dùng mặc định):', error.message)))
    : Promise.resolve();

  const routes = {
    // Thanh trạng thái poll đường dẫn này (1 giây/lần) — để nhẹ.
    [`GET ${prefix}/stats`]: async () => pool.stats(),
    [`GET ${prefix}/config`]: async () => ({ pool: currentConfig(), poolStats: pool.stats() }),
    [`PUT ${prefix}/config`]: async body => {
      await ready;
      applySaved(body && typeof body === 'object' ? body : {});
      const applied = currentConfig();
      if (persist) await persist(applied);
      return { ok: true, pool: applied, poolStats: pool.stats() };
    },
  };

  handle(channel, async input => {
    const key = `${String(input?.method || 'GET').toUpperCase()} ${String(input?.path || '')}`;
    const route = routes[key];
    if (!route) throw new Error('Không tìm thấy route pool.');
    if (guard) await guard();
    return route(input?.body);
  });
  return ready;
});

module.exports = { registerPoolRoutes, LIMITS, TASK_TIMEOUT_LIMIT };
