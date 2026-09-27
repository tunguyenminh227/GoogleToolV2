// Bảng cấu hình pool (port từ Pool-Worker/web/PoolPanel.tsx) đặt trong dialog Cài đặt: số liệu trực tiếp + các knob,
// áp ngay không cần restart. Chỉ poll khi dialog đang mở. Thêm knob "Thời gian chờ mỗi task" (taskTimeoutMs).
(() => {
  const PHASE_LABEL = { ramping: 'Đang dò ↑', stable: 'Ổn định', cooldown: 'Back off (quota)' };

  const PILLS = [
    ['concurrency', 'Concurrency', 'is-accent'],
    ['running', 'Đang chạy', 'is-success'],
    ['pending', 'Hàng đợi', ''],
    ['ceiling', 'Trần đã dò', ''],
    ['quotaTrips', 'Lần dính quota', ''],
    ['probePhase', 'Pha', 'is-small'],
  ];

  // [khóa trong draft, nhãn, min, max, gợi ý, hậu tố]
  const FIELDS = [
    ['start', 'Worker khởi đầu (start)', 1, 500, 'Concurrency lúc bắt đầu dò. Lưu lại = nhảy về mức này + quên trần đã học (gỡ kẹt ngay). Khuyến nghị 10–40.'],
    ['min', 'Concurrency tối thiểu (min)', 1, 50, 'Sàn khi back off quota. Khuyến nghị 2–5.'],
    ['hardCap', 'Trần cứng (hardCap)', 1, 500, 'Trần concurrency khi dò. Khuyến nghị 50–100. Phải ≥ min.'],
    ['probeBatch', 'Lô thành công để +1 (probeBatch)', 1, 100, 'Càng nhỏ dò càng nhanh. Khuyến nghị 3–10.'],
    ['recSec', 'Tự hồi phục trần sau', 0, 600, 'Lâu không dính quota thì QUÊN trần đã dò để dò lại lên cao. 0 = tắt. Khuyến nghị 20–60s.', 'giây'],
    ['blockSec', 'Back off mặc định', 1, 600, 'Dùng khi lỗi quota không kèm thời gian chờ. Khuyến nghị 30–120s.', 'giây'],
    ['timeoutSec', 'Thời gian chờ mỗi task', 5, 1800, 'Lệnh gọi Google Ads API quá thời gian này bị hủy để trả slot cho pool. Mặc định 180s.', 'giây'],
  ];

  const svg = id => `<svg aria-hidden="true"><use href="#i-${id}"/></svg>`;

  window.createPoolPanel = window.uiTrace('renderer.poolCreatePanel', (root, { statsIntervalMs = 1000 } = {}) => {
    root.classList.add('pool-panel');
    root.innerHTML = `
      <div class="pool-panel-loading" data-ref="loading">Đang tải cấu hình pool…</div>
      <div data-ref="body" hidden>
        <div class="pool-panel-title">${svg('activity')} Trạng thái pool (cập nhật trực tiếp)</div>
        <div class="pool-stat-grid">
          ${PILLS.map(([key, label, cls]) => `<div class="pool-stat-pill ${cls}"><span>${label}</span><b data-stat="${key}">—</b></div>`).join('')}
        </div>
        <div class="pool-paused" data-ref="paused" hidden>${svg('alert')} <span data-ref="pausedText"></span></div>
        <div class="pool-panel-title is-config">Cấu hình (áp ngay, không cần restart)</div>
        <div class="pool-field-grid">
          ${FIELDS.map(([key, label, min, max, hint, suffix]) => `
            <label class="pool-field">
              <span class="pool-field-label">${label}</span>
              <span class="pool-field-input"><input type="number" data-field="${key}" min="${min}" max="${max}" step="1">${suffix ? `<small>${suffix}</small>` : ''}</span>
              <small class="field-help">${hint}</small>
            </label>`).join('')}
        </div>
        <div class="pool-panel-actions">
          <button type="button" class="button primary" data-ref="save">${svg('check')}<span>Lưu cấu hình pool</span></button>
          <span class="pool-panel-note is-error" data-ref="invalid" hidden>hardCap phải ≥ min và các giá trị ≥ 1.</span>
          <span class="pool-panel-note is-error" data-ref="error" hidden></span>
        </div>
      </div>`;
    const ref = name => root.querySelector(`[data-ref="${name}"]`);
    const input = key => root.querySelector(`[data-field="${key}"]`);

    let config = null;
    let saving = false;
    let timer = null;

    const readDraft = () => {
      const draft = {};
      for (const [key] of FIELDS) draft[key] = Number(input(key).value);
      return draft;
    };

    // Không bọc uiTrace: chạy mỗi giây theo nhịp poll
    const paintStats = stats => {
      for (const [key] of PILLS) {
        let value = stats?.[key] ?? '—';
        if (key === 'probePhase' && stats) value = PHASE_LABEL[stats.probePhase] ?? stats.probePhase;
        root.querySelector(`[data-stat="${key}"]`).textContent = value;
      }
      root.querySelector('[data-stat="quotaTrips"]').parentElement.classList.toggle('is-warn', Boolean(stats?.quotaTrips));
      ref('paused').hidden = !stats?.paused;
      if (stats?.paused) ref('pausedText').textContent = `Pool đang back off ~${Math.ceil(stats.blockedForMs / 1000)}s do quota.`;
    };

    const refreshButtons = window.uiTrace('renderer.poolRefreshButtons', () => {
      if (!config) return;
      const d = readDraft();
      const dirty =
        d.start !== config.start ||
        d.min !== config.min ||
        d.hardCap !== config.hardCap ||
        d.probeBatch !== config.probeBatch ||
        d.blockSec * 1000 !== config.fallbackBlockMs ||
        d.recSec * 1000 !== config.recoveryMs ||
        d.timeoutSec * 1000 !== config.taskTimeoutMs;
      const invalid = d.hardCap < d.min || d.min < 1 || d.start < 1 || d.probeBatch < 1 || d.blockSec < 1 || d.timeoutSec < 5;
      ref('invalid').hidden = !invalid;
      ref('save').disabled = !dirty || invalid || saving;
    });

    const applyConfig = window.uiTrace('renderer.poolApplyConfig', c => {
      config = c;
      input('start').value = c.start;
      input('min').value = c.min;
      input('hardCap').value = c.hardCap;
      input('probeBatch').value = c.probeBatch;
      input('blockSec').value = Math.round(c.fallbackBlockMs / 1000);
      input('recSec').value = Math.round(c.recoveryMs / 1000);
      input('timeoutSec').value = Math.round(c.taskTimeoutMs / 1000);
      refreshButtons();
    });

    const showError = message => {
      ref('error').textContent = message;
      ref('error').hidden = !message;
    };

    root.addEventListener('input', refreshButtons);

    ref('save').addEventListener('click', window.uiTrace('renderer.poolSave', async () => {
      const d = readDraft();
      saving = true;
      refreshButtons();
      ref('save').replaceChildren(document.createRange().createContextualFragment(`${svg('loader')}<span>Lưu cấu hình pool</span>`));
      ref('save').classList.add('is-busy');
      showError('');
      try {
        const r = await window.poolApi.setConfig({
          start: d.start, min: d.min, hardCap: d.hardCap, probeBatch: d.probeBatch,
          fallbackBlockMs: d.blockSec * 1000, recoveryMs: d.recSec * 1000, taskTimeoutMs: d.timeoutSec * 1000,
        });
        applyConfig(r.pool);
        paintStats(r.poolStats);
      } catch (e) {
        showError(e instanceof Error ? e.message : String(e));
      } finally {
        saving = false;
        ref('save').classList.remove('is-busy');
        ref('save').replaceChildren(document.createRange().createContextualFragment(`${svg('check')}<span>Lưu cấu hình pool</span>`));
        refreshButtons();
      }
    }));

    const stop = window.uiTrace('renderer.poolStopPanel', () => {
      clearInterval(timer);
      timer = null;
    });

    const start = window.uiTrace('renderer.poolStartPanel', async () => {
      stop();
      config = null;
      showError('');
      ref('loading').hidden = false;
      ref('loading').textContent = 'Đang tải cấu hình pool…';
      ref('body').hidden = true;
      timer = setInterval(() => {
        window.poolApi.stats().then(paintStats).catch(() => {});
      }, statsIntervalMs);
      try {
        const r = await window.poolApi.config();
        applyConfig(r.pool);
        paintStats(r.poolStats);
        ref('loading').hidden = true;
        ref('body').hidden = false;
      } catch (e) {
        ref('loading').textContent = e instanceof Error ? e.message : String(e);
      }
    });

    return { start, stop };
  });
})();
