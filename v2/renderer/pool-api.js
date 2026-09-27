// Client gọi API pool (port từ Pool-Worker/web/poolApi.ts). App không có HTTP server: gọi qua IPC
// window.googleTool.poolRequest(method, path, body), đường dẫn vẫn là POOL_BASE + path như bản gốc.
(() => {
  /** Tiền tố route ở main process (khớp `prefix` khi đăng ký registerPoolRoutes). */
  let POOL_BASE = '/api/pool';
  const setPoolBase = window.uiTrace('renderer.poolSetBase', base => { POOL_BASE = base; });

  // Không bọc uiTrace: stats được poll 1 giây/lần, phía main đã trace từng lần gọi IPC.
  const call = (path, init = {}) => window.googleTool.poolRequest(init.method || 'GET', POOL_BASE + path, init.body);

  window.poolApi = {
    setPoolBase,
    stats: () => call('/stats'),
    config: () => call('/config'),
    setConfig: window.uiTrace('renderer.poolSetConfig', p => call('/config', { method: 'PUT', body: p })),
  };
})();
