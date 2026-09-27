// Ô trạng thái pool trên thanh trên cùng (port từ Pool-Worker/web/PoolStatus.tsx): chấm sống + worker đang chạy
// · tổng (chạy + chờ) · trần đã dò · back off. Tự poll. Viền sáng chạy quanh khi pool đang bận (.pool-glow trong pool.css).
(() => {
  const TEMPLATE = `
    <span class="pool-status-item">
      <span class="pool-live"><span class="pool-live-ping"></span><span class="pool-live-dot"></span></span>
      <svg aria-hidden="true"><use href="#i-cpu"/></svg>
      <b data-ref="running">0</b>
    </span>
    <span class="pool-status-sep"></span>
    <span class="pool-status-item">
      <svg aria-hidden="true"><use href="#i-sigma"/></svg>
      <b data-ref="total">0</b>
    </span>
    <span class="pool-status-sep" data-ref="ceilingSep" hidden></span>
    <span class="pool-status-item" data-ref="ceilingItem" title="Trần concurrency pool tự dò được" hidden>
      <svg aria-hidden="true"><use href="#i-gauge"/></svg>
      <b data-ref="ceiling"></b>
    </span>
    <span class="pool-status-sep" data-ref="blockedSep" hidden></span>
    <span class="pool-status-blocked" data-ref="blocked" title="Pool đang tạm dừng do lỗi quota" hidden></span>`;

  window.mountPoolStatus = window.uiTrace('renderer.poolMountStatus', (root, intervalMs = 1000) => {
    root.classList.add('pool-status');
    root.title = 'Pool worker — đang chạy · tổng · trần đã dò';
    root.innerHTML = TEMPLATE;
    const ref = name => root.querySelector(`[data-ref="${name}"]`);

    // Không bọc uiTrace: chạy mỗi giây theo nhịp poll.
    const paint = data => {
      const running = data?.running ?? 0;
      const pending = data?.pending ?? 0;
      const active = running > 0 || pending > 0;
      const ceiling = data?.ceiling ?? null;
      const blockedSec = data?.paused ? Math.ceil((data.blockedForMs ?? 0) / 1000) : 0;
      root.classList.toggle('pool-glow', active);
      root.classList.toggle('is-active', active);
      ref('running').textContent = running;
      ref('total').textContent = running + pending;
      ref('ceilingSep').hidden = ref('ceilingItem').hidden = ceiling == null;
      ref('ceiling').textContent = ceiling ?? '';
      ref('blockedSep').hidden = ref('blocked').hidden = blockedSec <= 0;
      ref('blocked').textContent = `back off ${blockedSec}s`;
    };

    let alive = true;
    const tick = async () => {
      try {
        const s = await window.poolApi.stats();
        if (alive) paint(s);
      } catch {
        /* mất kết nối IPC -> giữ số cũ, lần sau thử lại */
      }
    };
    paint(null);
    void tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  });
})();
