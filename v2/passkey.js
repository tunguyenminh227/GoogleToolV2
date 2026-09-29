const WebSocketClient = typeof WebSocket !== 'undefined' ? WebSocket : require('ws');
const trace = require('./trace-log');
const { totp, typeField, humanClick, clickAndWaitUrl, stepRecaptcha, stepPassword, stepTotp, classify } = require('./gmail-login');
const t = trace.traced;

const failure = t('passkey.failure', (code, message) => {
  const span = trace.traceIn(`passkey.error.${code}`);
  try { return Object.assign(new Error(message), { passkeyCode: code }); }
  finally { trace.traceOut(span, 'error'); }
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

const PASSKEY_URL = 'https://myaccount.google.com/signinoptions/passkeys';
const PASSKEY_CREATE_LABELS = ['create a passkey', 'tạo mã xác thực', 'tạo khóa truy cập', 'tạo passkey'];
const PASSKEY_CONTINUE_LABELS = ['continue', 'tiếp tục', 'create a passkey', 'tạo mã xác thực', 'tạo khóa truy cập', 'tạo passkey'];
const PASSKEY_DONE_LABELS = ['done', 'xong', 'hoàn tất'];

// Snippet JS từ V1: tìm phần tử khớp text và THỰC SỰ bấm được qua elementFromPoint (main.js:3694-3740)
const clickableTextRectJs = (needles, preferBottom = false) => `(function(){
  var needles = ${JSON.stringify(needles)};
  function norm(s){ return ((s || '')).replace(/[‘’ʼ]/g, "'").trim().toLowerCase(); }
  var nn = needles.map(norm);
  var all = Array.prototype.slice.call(
    document.querySelectorAll('button, a, [role=button], [role=link], [jsaction], [data-challengetype]'));
  var cands = [];
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var t = norm(el.innerText || el.textContent);
    if (!t) continue;
    if (!nn.some(function(n){ return n && t.indexOf(n) !== -1; })) continue;
    var r0 = el.getBoundingClientRect();
    cands.push({ el: el, t: t, area: Math.max(1, r0.width) * Math.max(1, r0.height) });
  }
  cands.sort(function(a, b){
    if (a.t.length !== b.t.length) return a.t.length - b.t.length;
    return a.area - b.area;
  });
  var info = [];
  for (var j = 0; j < cands.length; j++) {
    var el2 = cands[j].el;
    try { el2.scrollIntoView({ block: 'center', inline: 'center' }); } catch(e){}
    var r = el2.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) { info.push('size0'); continue; }
    var cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) {
      info.push('offscreen@' + cx + ',' + cy); continue;
    }
    var top = document.elementFromPoint(cx, cy);
    if (!top) { info.push('noTop@' + cx + ',' + cy); continue; }
    if (top === el2 || el2.contains(top)) {
      var cls = ((top.className || '') + '').toString().slice(0, 24);
      return { x: cx, y: cy, tag: (top.tagName || '') + '.' + cls, n: cands.length };
    }
    var bcls = ((top.className || '') + '').toString().slice(0, 16);
    info.push('blk:' + (top.tagName || '') + '.' + bcls + '@' + cx + ',' + cy);
  }
  return { x: null, y: null, n: cands.length, info: info.join(' | ') };
})()`;

// Snippet JS từ V1: fallback click bằng dispatch Pointer/Mouse/Click event đầy đủ (main.js:2879-2925)
const clickOptionByTextJs = (needles, preferBottom = false) => `(function(){
  var needles = ${JSON.stringify(needles)};
  function norm(s){ return ((s || '')).replace(/[‘’ʼ]/g, "'").trim().toLowerCase(); }
  function vis(el){
    if (!el || el.offsetParent === null) return false;
    var r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    var st = window.getComputedStyle(el);
    if (st && st.visibility === 'hidden') return false;
    return true;
  }
  var all = Array.prototype.slice.call(
    document.querySelectorAll('li, a, button, [role=link], [role=button], [data-challengetype], span, div'));
  var match = null;
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (!vis(el)) continue;
    var t = norm(el.innerText || el.textContent);
    if (!t) continue;
    if (needles.some(function(n){ return t.indexOf(n) !== -1; })) {
      if (!match || t.length < norm(match.innerText || match.textContent).length) match = el;
    }
  }
  if (!match) return 'no-match';
  function fire(el){
    try { el.scrollIntoView({ block: 'center' }); } catch(e){}
    var r = el.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var seq = ['pointerover','pointerenter','pointerdown','mousedown','pointerup','mouseup','click'];
    for (var i = 0; i < seq.length; i++) {
      var name = seq[i];
      var isPtr = name.indexOf('pointer') === 0;
      var Ctor = (isPtr && window.PointerEvent) ? window.PointerEvent : MouseEvent;
      var ev = null;
      try {
        ev = new Ctor(name, { bubbles: true, cancelable: true, view: window,
          clientX: cx, clientY: cy, button: 0, pointerId: 1, isPrimary: true });
      } catch(e) {
        var alt = (name === 'pointerdown') ? 'mousedown'
          : (name === 'pointerup') ? 'mouseup'
          : (name === 'pointerover') ? 'mouseover'
          : (name === 'pointerenter') ? 'mouseenter' : name;
        try { ev = new MouseEvent(alt, { bubbles: true, cancelable: true,
          view: window, clientX: cx, clientY: cy, button: 0 }); } catch(e2) { ev = null; }
      }
      if (ev) try { el.dispatchEvent(ev); } catch(e){}
    }
  }
  var target = match.closest('[jsaction], li, [role=link], [role=button], a, button, [data-challengetype]') || match;
  fire(match);
  if (target !== match) fire(target);
  return 'clicked:' + norm(target.innerText || target.textContent).slice(0, 40);
})()`;

// Thao tác click tọa độ chuột qua CDP Input.dispatchMouseEvent (chuẩn V1)
const fclickAt = t('passkey.clickAt', async (page, client, x, y) => {
  if (client && typeof client.send === 'function') {
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await sleep(60);
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await sleep(60);
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    return true;
  }
  if (page && page.mouse && typeof page.mouse.click === 'function') {
    await page.mouse.click(x, y);
    return true;
  }
  return false;
});

// Click nhãn theo luồng V1: clickableTextRectJs + fclickAt trước, fallback clickOptionByTextJs
const fClickLabel = t('passkey.fClickLabel', async (page, client, labels, tries = 8, scrollBottom = false, timeoutMs = 30000) => {
  const shortWait = timeoutMs <= 500;
  for (let i = 0; i < tries; i++) {
    if ((scrollBottom || i >= 2) && typeof page.evaluate === 'function') {
      try {
        await page.evaluate(() => {
          if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
            window.scrollTo(0, document.body.scrollHeight);
          }
        });
      } catch (_) {}
      await sleep(shortWait ? 50 : 400);
    }

    if (typeof page.evaluate === 'function') {
      try {
        const r = await page.evaluate(clickableTextRectJs(labels));
        if (r === true) return true;
        if (r && typeof r.x === 'number') {
          await fclickAt(page, client, r.x, r.y);
          return true;
        }
      } catch (_) {}

      try {
        const res = await page.evaluate(clickOptionByTextJs(labels));
        if (res === true || (typeof res === 'string' && res.indexOf('clicked') === 0)) {
          return true;
        }
      } catch (_) {}
    }

    if (shortWait) break;
    await sleep(1200);
  }
  return false;
});

const clickBottomPasskeyButton = t('passkey.clickBottomButton', async (page, client, timeoutMs = 30000) => {
  return fClickLabel(page, client, PASSKEY_CREATE_LABELS, 4, true, timeoutMs);
});

const clickModalPasskeyButton = t('passkey.clickModalButton', async (page, client, timeoutMs = 30000) => {
  const res = await fClickLabel(page, client, PASSKEY_CONTINUE_LABELS, 4, false, timeoutMs);
  return { success: !!res };
});

const clickLabelRobust = t('passkey.clickLabel', async (page, labels, tries = 8, scrollBottom = false, timeoutMs = 30000) => {
  return fClickLabel(page, null, labels, tries, scrollBottom, timeoutMs);
});

const passReauthChallenge = t('passkey.passReauth', async (page, account, options) => {
  const currentUrl = page.url();
  const state = typeof classify === 'function' ? classify(currentUrl) : '';

  // 1) Re-auth mật khẩu (/signin/challenge/pwd)
  if (state === 'password' || currentUrl.includes('/signin/challenge/pwd') || currentUrl.includes('/challenge/password')) {
    console.log('[passkey-trace] Phát hiện yêu cầu xác minh lại mật khẩu (challenge/pwd)...');
    if (!account.password) {
      throw failure('missing_password', 'Tài khoản chưa có mật khẩu để vượt màn xác minh.');
    }
    await stepPassword(page, account, options);
    console.log('[passkey-trace] Điền mật khẩu xác minh = OK');
    return true;
  }

  // 2) Re-auth 2FA Authenticator (/signin/challenge/totp)
  if (state === 'totp' || currentUrl.includes('/signin/challenge/totp') || currentUrl.includes('/challenge/totp')) {
    console.log('[passkey-trace] Phát hiện yêu cầu xác minh lại 2FA (challenge/totp)...');
    if (!account.twofa && !account.totpSecret) {
      throw failure('missing_totp', 'Tài khoản chưa có 2FA Authenticator để vượt màn xác minh.');
    }
    await stepTotp(page, account, options);
    console.log('[passkey-trace] Điền mã 2FA xác minh = OK');
    return true;
  }

  // 3) Re-auth Passkey (/signin/challenge/pk)
  if (state === 'passkey' || currentUrl.includes('/signin/challenge/pk') || currentUrl.includes('/challenge/pk')) {
    console.log('[passkey-trace] Phát hiện yêu cầu xác minh lại bằng Passkey (challenge/pk)...');
    return false;
  }

  // 4) Màn reCAPTCHA
  let hasRecaptcha = false;
  try {
    hasRecaptcha = await page.evaluate(() => {
      if (typeof document === 'undefined') return false;
      return !!document.querySelector('iframe[src*="recaptcha"], iframe[title*="reCAPTCHA" i], .g-recaptcha, #recaptcha');
    });
  } catch (_) {}

  if (state === 'recaptcha' || currentUrl.includes('/challenge/recaptcha') || hasRecaptcha) {
    console.warn('[passkey-trace] ⚠️ Phát hiện trang yêu cầu giải CAPTCHA (reCAPTCHA v2)!');
    if (typeof options.onStatus === 'function') await options.onStatus('recaptcha', 'Đang giải CAPTCHA...');
    await stepRecaptcha(page, options);
    return true;
  }

  return false;
});

const gotoSecurePasskeyPage = t('passkey.gotoSecurePage', async (page, account, options, onStatus = null) => {
  console.log('[passkey-trace] 1. Điều hướng tới trang Passkey...');
  await page.goto(PASSKEY_URL, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });

  const opts = { ...options, onStatus: onStatus || options.onStatus };

  for (let step = 0; step < 15; step++) {
    const url = page.url();
    if (url.includes('signinoptions/passkeys') && !url.includes('/challenge/')) {
      let hasCaptchaOnPasskeys = false;
      try {
        hasCaptchaOnPasskeys = await page.evaluate(() => {
          if (typeof document === 'undefined') return false;
          return !!document.querySelector('iframe[src*="recaptcha"], iframe[title*="reCAPTCHA" i], .g-recaptcha, #recaptcha');
        });
      } catch (_) {}
      if (hasCaptchaOnPasskeys) {
        console.warn('[passkey-trace] ⚠️ Phát hiện CAPTCHA trên trang passkeys!');
        if (typeof opts.onStatus === 'function') await opts.onStatus('recaptcha', 'Đang giải CAPTCHA...');
        await stepRecaptcha(page, opts);
        await sleep(1200);
        continue;
      }

      console.log('[passkey-trace] 1.x Đã tới trang quản lý Passkey thành công.');
      await sleep(1200);
      return true;
    }

    if (url.includes('/signin/identifier') || url.includes('/ServiceLogin')) {
      throw failure('not_logged_in', 'Tài khoản chưa đăng nhập Gmail. Vui lòng thực hiện Login gmail trước khi bật Passkey.');
    }

    if (/CheckCookie/i.test(url)) {
      console.log('[passkey-trace] ⏳ Đang chuyển hướng (CheckCookie)...');
      const waitStart = Date.now();
      while (Date.now() - waitStart < 8000) {
        await sleep(300);
        if (!/CheckCookie/i.test(page.url())) break;
      }
      continue;
    }

    if (url.includes('/challenge/') || (typeof classify === 'function' && classify(url) === 'recaptcha')) {
      const handled = await passReauthChallenge(page, account, opts);
      if (handled) {
        await sleep(1200);
        continue;
      }
    }

    let hasCaptcha = false;
    try {
      hasCaptcha = await page.evaluate(() => {
        if (typeof document === 'undefined') return false;
        return !!document.querySelector('iframe[src*="recaptcha"], iframe[title*="reCAPTCHA" i], .g-recaptcha, #recaptcha');
      });
    } catch (_) {}
    if (hasCaptcha) {
      console.warn('[passkey-trace] ⚠️ Phát hiện iframe CAPTCHA trên trang khi tới URL passkey!');
      if (typeof opts.onStatus === 'function') await opts.onStatus('recaptcha', 'Đang giải CAPTCHA...');
      await stepRecaptcha(page, opts);
      await sleep(1200);
      continue;
    }

    await sleep(1000);
  }

  throw failure('timeout', 'Hết thời gian chờ hoặc quá số bước điều hướng tới trang Passkey.');
});

function getPortFromBrowser(browser) {
  if (!browser) return null;
  if (typeof browser.wsEndpoint === 'function') {
    const ep = browser.wsEndpoint();
    if (ep) {
      try {
        const u = new URL(ep);
        if (u.port) return parseInt(u.port, 10);
      } catch (_) {}
    }
  }
  if (typeof browser.process === 'function') {
    const proc = browser.process();
    if (proc && Array.isArray(proc.spawnargs)) {
      const arg = proc.spawnargs.find(a => a && a.startsWith('--remote-debugging-port='));
      if (arg) {
        const p = parseInt(arg.split('=')[1], 10);
        if (p) return p;
      }
    }
  }
  return null;
}

// Flow BẬT PASSKEY: Port thẳng luồng V1 (mở tab bằng /json/new + WebSocket thô, click một bước)
const enablePasskey = t('passkey.enable', async (browser, account, onStatus, input = {}) => {
  const options = { typingDelayMs: 90, timeoutMs: 30000, ...input };

  // 0) Nếu profile đã có passkey lưu sẵn -> coi như đã bật, không tạo lại
  if (account.passkey && account.passkey.trim()) {
    console.log('[passkey] (0) profile đã có passkey lưu sẵn trong notes -> BỎ QUA.');
    await onStatus('passkey_enabled', 'Đã có Passkey');
    return { status: 'already_enabled', passkeyBlob: account.passkey.trim() };
  }

  await onStatus('starting', 'Đang kết nối...');
  const page = (await browser.pages())[0] || await browser.newPage();

  // 1) Vào trang quản lý Passkey trên tab chính và vượt re-auth / captcha nếu cần (như V1)
  console.log('[passkey] (1) điều hướng tới trang Passkey (tự vượt xác minh mật khẩu/2FA nếu bị hỏi).');
  await gotoSecurePasskeyPage(page, account, { ...options, onStatus }, onStatus);

  const passkeyPageUrl = (typeof page.url === 'function' ? page.url() : '') || PASSKEY_URL;
  console.log('[passkey] (2) URL passkey trên tab gốc =', passkeyPageUrl);

  const port = options.port || getPortFromBrowser(browser);

  // Nếu có cổng DevTools HTTP (môi trường Chromium thật): Mở tab mới sạch qua /json/new + WebSocket thô
  if (port) {
    let freshTab = null;
    try {
      let nr = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).catch(() => null);
      if (!nr || !nr.ok) nr = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'GET' }).catch(() => null);
      if (nr && nr.ok) freshTab = await nr.json();
    } catch (e) {
      console.warn('[passkey] LỖI mở tab mới qua /json/new:', e && e.message);
    }

    const freshWsUrl = freshTab && freshTab.webSocketDebuggerUrl;
    if (freshWsUrl) {
      console.log('[passkey] (2.x) Đã mở tab mới sạch qua /json/new, kết nối WebSocket thô:', freshWsUrl);
      await onStatus('passkey_creating', 'Đang tạo Passkey ảo...');

      return await new Promise((resolveFresh) => {
        const fws = new WebSocketClient(freshWsUrl);
        let fid = 0;
        const fpending = new Map();
        const fsend = (method, params) => new Promise((res) => {
          const myId = ++fid;
          fpending.set(myId, res);
          try { fws.send(JSON.stringify({ id: myId, method, params: params || {} })); }
          catch (_) { fpending.delete(myId); res(null); }
        });
        const fevaluate = async (expr) => {
          const r = await fsend('Runtime.evaluate', { expression: expr, returnByValue: true });
          return r && r.result && r.result.result ? r.result.result.value : undefined;
        };
        const fclickAt = async (x, y) => {
          await fsend('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
          await sleep(60);
          await fsend('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
          await sleep(60);
          await fsend('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        };
        // Tái dùng nguyên bộ snippet V1: clickableTextRectJs + fclickAt, fallback clickOptionByTextJs
        const rawClickLabel = async (labels, tries, scrollBottom) => {
          for (let i = 0; i < tries; i++) {
            if (scrollBottom) { await fevaluate('window.scrollTo(0, document.body.scrollHeight)'); await sleep(400); }
            const r = await fevaluate(clickableTextRectJs(labels));
            if (r && typeof r.x === 'number') { await fclickAt(r.x, r.y); return true; }
            const res = await fevaluate(clickOptionByTextJs(labels));
            if (res && res.indexOf('clicked') === 0) return true;
            await sleep(1200);
          }
          return false;
        };

        let settled = false;
        const settle = (v) => {
          if (!settled) {
            settled = true;
            try { fws.close(); } catch (_) {}
            try { fetch(`http://127.0.0.1:${port}/json/close/${freshTab.id}`).catch(() => {}); } catch (_) {}
            resolveFresh(v);
          }
        };

        fws.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.id && fpending.has(msg.id)) {
              const cb = fpending.get(msg.id);
              fpending.delete(msg.id);
              cb(msg);
            }
          } catch (_) {}
        });

        fws.on('error', (e) => {
          console.warn('[passkey] LỖI WebSocket tab mới:', e && e.message);
          settle({ status: 'error', error: e && e.message });
        });

        fws.on('open', async () => {
          try {
            await fsend('Page.enable');
            await fsend('Runtime.enable');
            await fsend('WebAuthn.enable', { enableUI: false });
            const va = await fsend('WebAuthn.addVirtualAuthenticator', {
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
            if (!authenticatorId) {
              console.warn('[passkey] Tab mới: KHÔNG tạo được authenticator -> hủy.');
              settle({ status: 'error', error: 'Không tạo được authenticator ảo.' });
              return;
            }
            console.log(`[passkey] Tab mới đã sẵn sàng (authId=${authenticatorId}) -> điều hướng.`);
            await fsend('Page.navigate', { url: passkeyPageUrl });

            let loaded = false;
            for (let i = 0; i < 30 && !loaded; i++) {
              await sleep(500);
              const ready = await fevaluate('document.readyState');
              if (ready === 'complete') loaded = true;
            }
            await sleep(1500);

            console.log('[passkey] (3) bấm nút tạo Passkey trên tab mới (click một bước như V1)...');
            const createClicked = await rawClickLabel(PASSKEY_CREATE_LABELS, 8, false);
            if (!createClicked) {
              console.warn('[passkey] Tab mới: KHÔNG bấm được nút tạo Passkey -> hủy.');
              throw failure('create_not_found', 'Không tìm thấy nút tạo Passkey trên trang Google.');
            }
            await sleep(2500); // để ceremony WebAuthn ảo tự hoàn tất

            await rawClickLabel(PASSKEY_CONTINUE_LABELS, 4, false);
            await sleep(1000);
            await rawClickLabel(PASSKEY_DONE_LABELS, 4, false);
            await sleep(1500);

            let creds = [];
            for (let attempt = 0; attempt < 8 && !creds.length; attempt++) {
              console.log(`[passkey] (4) dò credential trên tab mới, lần ${attempt + 1}/8.`);
              const cr = await fsend('WebAuthn.getCredentials', { authenticatorId });
              creds = (cr && cr.result && cr.result.credentials) || [];
              if (!creds.length) await sleep(1000);
            }
            if (!creds.length) {
              console.warn('[passkey] KHÔNG có credential nào được tạo -> hủy.');
              throw failure('no_credentials', 'Không lấy được credential Passkey từ authenticator ảo.');
            }
            const cred = creds[creds.length - 1];
            const blob = Buffer.from(JSON.stringify(cred)).toString('base64');
            console.log('[passkey] ===== HOÀN TẤT TẠO PASSKEY =====');
            await onStatus('passkey_enabled', 'Đã bật Passkey');
            settle({ status: 'success', passkeyBlob: blob });
          } catch (e) {
            console.warn('[passkey] LỖI trên tab mới:', e && e.message);
            settle({ status: 'error', error: e && e.message });
          }
        });
      });
    }
  }

  // Fallback: dành cho môi trường test/mock không có cổng TCP /json/new
  console.log('[passkey] Chạy chế độ fallback Puppeteer CDP Session (môi trường test/mock)...');
  await onStatus('passkey_creating', 'Đang tạo Passkey ảo...');
  const freshPage = await browser.newPage();
  let client = null;
  let authenticatorId = null;

  try {
    if (typeof freshPage.target === 'function' && typeof freshPage.target().createCDPSession === 'function') {
      client = await freshPage.target().createCDPSession();
      await client.send('Page.enable');
      await client.send('Runtime.enable');
      await client.send('WebAuthn.enable', { enableUI: false });
      const va = await client.send('WebAuthn.addVirtualAuthenticator', {
        options: {
          protocol: 'ctap2',
          transport: 'internal',
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      });
      authenticatorId = (va && va.result && va.result.authenticatorId) || (va && va.authenticatorId);
    }

    if (!authenticatorId && typeof freshPage.addVirtualAuthenticator === 'function') {
      const mockAuth = await freshPage.addVirtualAuthenticator();
      authenticatorId = mockAuth && mockAuth.id;
    }

    await freshPage.goto(passkeyPageUrl, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
    await sleep(options.timeoutMs <= 500 ? 50 : 1500);

    const createClicked = await fClickLabel(freshPage, client, PASSKEY_CREATE_LABELS, 4, false, options.timeoutMs);
    if (!createClicked) {
      throw failure('create_not_found', 'Không tìm thấy nút tạo Passkey trên trang Google.');
    }
    await sleep(options.timeoutMs <= 500 ? 50 : 2500);

    await fClickLabel(freshPage, client, PASSKEY_CONTINUE_LABELS, 4, false, options.timeoutMs);
    await sleep(options.timeoutMs <= 500 ? 20 : 1000);
    await fClickLabel(freshPage, client, PASSKEY_DONE_LABELS, 4, false, options.timeoutMs);
    await sleep(options.timeoutMs <= 500 ? 20 : 1500);

    let creds = [];
    if (client && authenticatorId) {
      const maxAttempts = options.timeoutMs <= 500 ? 2 : 8;
      const retryDelay = options.timeoutMs <= 500 ? 10 : 1000;
      for (let attempt = 0; attempt < maxAttempts && !creds.length; attempt++) {
        const cr = await client.send('WebAuthn.getCredentials', { authenticatorId });
        creds = (cr && cr.result && cr.result.credentials) || (cr && cr.credentials) || [];
        if (!creds.length) await sleep(retryDelay);
      }
    } else if (typeof freshPage.getCredentials === 'function') {
      creds = await freshPage.getCredentials();
    }

    if (!creds.length) {
      throw failure('no_credentials', 'Không lấy được credential Passkey từ authenticator ảo.');
    }

    const cred = creds[creds.length - 1];
    const passkeyBlob = Buffer.from(JSON.stringify(cred)).toString('base64');
    await onStatus('passkey_enabled', 'Đã bật Passkey');
    return { status: 'success', passkeyBlob };
  } finally {
    try { await freshPage.close(); } catch (_) {}
  }
});

module.exports = {
  enablePasskey,
  gotoSecurePasskeyPage,
  passReauthChallenge,
  clickBottomPasskeyButton,
  clickModalPasskeyButton,
  clickLabelRobust,
  fClickLabel,
  fclickAt,
  PASSKEY_URL,
  PASSKEY_CREATE_LABELS,
  PASSKEY_CONTINUE_LABELS,
  PASSKEY_DONE_LABELS,
};
