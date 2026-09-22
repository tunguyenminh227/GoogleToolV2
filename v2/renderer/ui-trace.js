// Logging primitives do not trace themselves. No arguments/results are logged.
window.uiTrace = function (name, fn) {
  return function (...args) {
    const callId = crypto.randomUUID(), start = performance.now();
    window.googleTool.logTrace({ name, callId, event: 'trace in' });
    const finish = status => window.googleTool.logTrace({ name, callId, event: 'trace out', status, durationMs: performance.now() - start });
    try {
      const result = fn.apply(this, args);
      if (result && typeof result.then === 'function') return Promise.resolve(result).then(
        value => { finish('ok'); return value; }, error => { finish('error'); throw error; });
      finish('ok'); return result;
    } catch (error) { finish('error'); throw error; }
  };
};
