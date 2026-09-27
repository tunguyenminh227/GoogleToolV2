const WebSocket = require('ws');
const trace = require('./trace-log');
const t = trace.traced;

const isChallengeUrl = t('passkeyWatcher.isChallengeUrl', url => {
  if (!url || typeof url !== 'string') return false;
  return url.includes('challenge/pk') ||
         url.includes('signin/challenge/pk') ||
         url.includes('/challenge/pk') ||
         url.includes('challenge/webauthn');
});

const CLICK_CONTINUE_JS = `(function(){
  var targets = ['continue', 'tiếp tục', 'continuer', 'continuar', 'weiter', 'ok', 'siguiente', 'next', 'tiếp theo', 'confirm with a passkey', 'confirm', 'xác nhận bằng passkey', 'xác nhận bằng khoá truy cập', 'xác nhận bằng khoá đăng nhập', 'xác nhận'];

  function trigger(el) {
    if (!el) return false;
    var rect = el.getBoundingClientRect();
    var x = rect.left + rect.width / 2;
    var y = rect.top + rect.height / 2;
    var mdown = new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y });
    var mup = new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y });
    var mclick = new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y });
    el.dispatchEvent(mdown);
    el.dispatchEvent(mup);
    el.dispatchEvent(mclick);
    if (typeof el.click === 'function') el.click();
    return true;
  }

  // 1. Kiểm tra các ID đặc trưng của Google cho nút Next / Continue
  var idSelectors = [
    '#passkeyNext button',
    '#passkeyNext',
    '#next button',
    '#next'
  ];
  for (var i = 0; i < idSelectors.length; i++) {
    var el = document.querySelector(idSelectors[i]);
    if (el && el.offsetParent !== null && !el.disabled) {
      trigger(el);
      return 'clicked:id:' + idSelectors[i];
    }
  }

  // 2. Tìm theo text của các nút có thể bấm được
  var candidates = Array.prototype.slice.call(document.querySelectorAll('button, [role="button"], a, div[role="button"], input[type="submit"], input[type="button"]'));
  for (var j = 0; j < candidates.length; j++) {
    var node = candidates[j];
    if (node.offsetParent === null || node.disabled) continue;
    var text = (node.innerText || node.textContent || node.value || '').trim().toLowerCase();
    for (var k = 0; k < targets.length; k++) {
      if (text === targets[k] || (text.indexOf(targets[k]) !== -1 && text.length < 50)) {
        var btn = node.closest('button, [role="button"], a, div[role="button"]') || node;
        trigger(btn);
        return 'clicked:text:' + text;
      }
    }
  }
  return 'no-match';
})()`;

const connectAndSend = t('passkeyWatcher.connectAndSend', (wsUrl, actions, timeoutMs = 30000) => new Promise((resolve) => {
  let settled = false;
  let overallTimeout;
  const settle = val => {
    if (!settled) {
      settled = true;
      if (overallTimeout) clearTimeout(overallTimeout);
      resolve(val);
    }
  };
  overallTimeout = setTimeout(() => settle(null), timeoutMs);

  let ws;
  try {
    ws = new WebSocket(wsUrl);
  } catch (_) {
    return settle(null);
  }

  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((res) => {
    const myId = ++id;
    const timeout = setTimeout(() => {
      pending.delete(myId);
      res(null);
    }, 8000);
    pending.set(myId, msg => {
      clearTimeout(timeout);
      res(msg);
    });
    try {
      ws.send(JSON.stringify({ id: myId, method, params }));
    } catch (_) {
      clearTimeout(timeout);
      pending.delete(myId);
      res(null);
    }
  });

  ws.on('message', data => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.id && pending.has(msg.id)) {
        const cb = pending.get(msg.id);
        pending.delete(msg.id);
        cb(msg);
      }
    } catch (_) {}
  });

  ws.on('error', () => { settle(null); });
  ws.on('close', () => { settle(null); });

  ws.on('open', async () => {
    try {
      const result = await actions(send);
      settle(result);
    } catch (_) {
      settle(null);
    } finally {
      try { ws.close(); } catch (_) {}
    }
  });
}));

const clickContinueOnTab = t('passkeyWatcher.clickContinueOnTab', async (wsUrl, passkeyBlob) => {
  let cred = null;
  if (passkeyBlob && passkeyBlob.trim()) {
    try {
      cred = JSON.parse(Buffer.from(passkeyBlob.trim(), 'base64').toString('utf8'));
    } catch (_) {}
  }

  return await connectAndSend(wsUrl, async (send) => {
    let authenticatorId = null;
    if (cred) {
      try {
        await send('WebAuthn.enable', { enableUI: false });
        const va = await send('WebAuthn.addVirtualAuthenticator', {
          options: {
            protocol: 'ctap2',
            transport: 'internal',
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
          },
        });
        authenticatorId = va && va.result && va.result.authenticatorId;
        if (authenticatorId) {
          await send('WebAuthn.addCredential', { authenticatorId, credential: cred });
          console.log('[passkey-watcher] Đã nạp Virtual Authenticator vào tab hiện tại.');
        }
      } catch (err) {
        console.warn('[passkey-watcher] Lỗi nạp authenticator vào tab:', err.message);
      }
    }

    await send('Runtime.enable');

    // Chờ trang render và tìm nút Continue trong tối đa 12 giây
    let clicked = false;
    for (let attempt = 0; attempt < 24; attempt++) {
      const r = await send('Runtime.evaluate', { expression: CLICK_CONTINUE_JS, returnByValue: true });
      const res = r && r.result && r.result.result ? r.result.result.value : null;
      if (res && typeof res === 'string' && res.startsWith('clicked')) {
        console.log('[passkey-watcher] Đã bấm nút Continue trên tab hiện tại:', res);
        clicked = true;
        break;
      }
      await new Promise(res => setTimeout(res, 500));
    }

    if (!clicked) {
      console.log('[passkey-watcher] Không tìm thấy nút Continue sau thời gian chờ.');
      return false;
    }

    // Nếu đã gắn Virtual Authenticator, DUY TRÌ kết nối CDP để WebAuthn hoàn tất (không được đóng ws ngay)
    if (authenticatorId) {
      console.log('[passkey-watcher] Đang duy trì kết nối CDP để hoàn tất xác thực Passkey...');
      for (let w = 0; w < 30; w++) {
        await new Promise(res => setTimeout(res, 500));
        const hr = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
        const href = hr && hr.result && hr.result.result ? hr.result.result.value : '';
        if (typeof href === 'string' && !isChallengeUrl(href)) {
          console.log('[passkey-watcher] Xác thực thành công! URL đã chuyển sang:', href.split('?')[0]);
          return true;
        }
      }
      console.log('[passkey-watcher] Hết thời gian chờ chuyển trang sau khi bấm Continue.');
    } else {
      await new Promise(res => setTimeout(res, 1000));
    }

    return clicked;
  }, 35000);
});

const openFreshTabWithPasskey = t('passkeyWatcher.openFreshTab', async (port, challengeUrl, passkeyBlob, onTabCreated = null) => {
  const blob = (passkeyBlob || '').trim();
  if (!blob) return false;
  let cred;
  try {
    cred = JSON.parse(Buffer.from(blob, 'base64').toString('utf8'));
  } catch (_) {
    return false;
  }

  let newTab = null;
  try {
    let nr = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
    if (!nr.ok) nr = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'GET' });
    if (!nr.ok) return false;
    newTab = await nr.json();
  } catch (_) {
    return false;
  }

  if (newTab && newTab.id && typeof onTabCreated === 'function') {
    onTabCreated(newTab);
  }

  const wsUrl = newTab && newTab.webSocketDebuggerUrl;
  if (!wsUrl) return false;

  console.log('[passkey-watcher] Mở tab mới sạch để xử lý Passkey:', challengeUrl.split('?')[0]);

  return await connectAndSend(wsUrl, async (send) => {
    await send('WebAuthn.enable', { enableUI: false });
    const va = await send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    const authenticatorId = va && va.result && va.result.authenticatorId;
    if (!authenticatorId) return false;

    await send('WebAuthn.addCredential', { authenticatorId, credential: cred });
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: challengeUrl });

    // Đợi trang thực sự điều hướng tới link challenge (không nhầm với about:blank)
    let navigated = false;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 400));
      const hr = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
      const href = hr && hr.result && hr.result.result ? hr.result.result.value : '';
      if (typeof href === 'string' && isChallengeUrl(href)) {
        navigated = true;
        break;
      }
    }

    if (navigated) {
      for (let i = 0; i < 20; i++) {
        const r1 = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
        const ready = r1 && r1.result && r1.result.result ? r1.result.result.value : '';
        if (ready === 'complete' || ready === 'interactive') break;
        await new Promise(r => setTimeout(r, 400));
      }
    }

    await new Promise(r => setTimeout(r, 600));

    let clicked = false;
    for (let attempt = 0; attempt < 15; attempt++) {
      const cr = await send('Runtime.evaluate', { expression: CLICK_CONTINUE_JS, returnByValue: true });
      const res = cr && cr.result && cr.result.result ? cr.result.result.value : '';
      if (res && typeof res === 'string' && res.startsWith('clicked')) {
        console.log(`[passkey-watcher] Tab mới: Đã bấm Continue thành công:`, res);
        clicked = true;
        break;
      }
      await new Promise(r => setTimeout(r, 600));
    }

    let success = false;
    if (navigated) {
      for (let j = 0; j < 30; j++) {
        await new Promise(r => setTimeout(r, 500));
        const hr = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
        const href = hr && hr.result && hr.result.result ? hr.result.result.value : '';
        if (typeof href === 'string' && !isChallengeUrl(href) && href !== 'about:blank' && !href.startsWith('chrome:')) {
          console.log('[passkey-watcher] Xác thực thành công! URL tab mới đã chuyển sang:', href.split('?')[0]);
          success = true;
          break;
        }
      }
    }

    console.log('[passkey-watcher] Kết quả xác thực trên tab mới sạch:', success ? 'THÀNH CÔNG' : (clicked ? 'Đã bấm Continue' : 'chờ/tiếp tục'));
    return success;
  }, 40000);
});

const startPasskeyWatcher = t('passkeyWatcher.start', (child, port, passkeyBlobOrGetter, profileId) => {
  if (!child || !port) return;
  const activeTargets = new Set();
  const handledTargets = new Map();
  const managedTabs = new Set();
  let isProcessing = false;
  let stopped = false;

  const timer = setInterval(async () => {
    if (stopped || child.killed || child.exitCode !== null || isProcessing) {
      if (stopped || child.killed || child.exitCode !== null) clearInterval(timer);
      return;
    }

    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`).catch(() => null);
      if (!res || !res.ok) return;
      const targets = await res.json().catch(() => []);
      if (!Array.isArray(targets)) return;

      const currentIds = new Set(targets.map(t => t.id));
      for (const id of activeTargets) {
        if (!currentIds.has(id)) activeTargets.delete(id);
      }
      for (const id of handledTargets.keys()) {
        if (!currentIds.has(id)) handledTargets.delete(id);
      }
      for (const id of managedTabs) {
        if (!currentIds.has(id)) managedTabs.delete(id);
      }

      for (const target of targets) {
        if (target.type !== 'page' || !target.webSocketDebuggerUrl) continue;
        if (managedTabs.has(target.id)) continue;
        if (!isChallengeUrl(target.url)) continue;

        if (activeTargets.has(target.id)) continue;
        if (handledTargets.has(target.id)) continue;

        activeTargets.add(target.id);
        handledTargets.set(target.id, target.url);
        isProcessing = true;
        console.log('[passkey-watcher] 🎯 Bất cứ khi nào có link khớp, tự động thực hiện Passkey:', target.url.split('?')[0]);

        const runProfileTrace = (profileId && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(profileId))
          ? fn => trace.withProfile(profileId, fn)
          : fn => fn();

        runProfileTrace(async () => {
          try {
            const rawBlob = typeof passkeyBlobOrGetter === 'function' ? passkeyBlobOrGetter() : passkeyBlobOrGetter;
            const passkeyBlob = (rawBlob || '').trim();

            if (passkeyBlob) {
              const challengeUrl = target.url;
              console.log('[passkey-watcher] 🚀 Sao chép URL challenge và đóng popup cũ bị vướng...');
              await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
              console.log('[passkey-watcher] 🔑 Bật tab mới và gắn CDP để nhập Passkey tự động...');
              await openFreshTabWithPasskey(port, challengeUrl, passkeyBlob, newTab => {
                if (newTab && newTab.id) {
                  managedTabs.add(newTab.id);
                  activeTargets.add(newTab.id);
                  handledTargets.set(newTab.id, challengeUrl);
                }
              });
            } else {
              await clickContinueOnTab(target.webSocketDebuggerUrl, passkeyBlob);
            }
          } catch (err) {
            console.warn('[passkey-watcher] Lỗi khi xử lý tab:', err && err.message);
          } finally {
            activeTargets.delete(target.id);
            isProcessing = false;
          }
        });
        break; // Mỗi chu kỳ chỉ xử lý tối đa 1 challenge
      }
    } catch (_) {
      isProcessing = false;
    }
  }, 350);

  child.once('exit', () => {
    stopped = true;
    clearInterval(timer);
  });
});

module.exports = {
  isChallengeUrl,
  clickContinueOnTab,
  openFreshTabWithPasskey,
  startPasskeyWatcher,
  CLICK_CONTINUE_JS,
};
