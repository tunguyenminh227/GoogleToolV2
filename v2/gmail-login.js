const crypto = require('node:crypto');
const trace = require('./trace-log');
const TwoCaptchaSolver = require('./twoCaptcha');
const t = trace.traced;

const failure = t('gmail.failure', (code, message) => {
  const span = trace.traceIn(`gmail.error.${code}`);
  try { return Object.assign(new Error(message), { loginCode: code }); }
  finally { trace.traceOut(span, 'error'); }
});
const classify = t('gmail.classify', value => {
  let url;
  try {
    url = new URL(value);
  } catch {
    return 'manual';
  }
  const path = url.pathname;
  const full = url.href;
  switch (true) {
    case url.protocol !== 'https:':
      return 'manual';
    case url.hostname === 'mail.google.com' && (full.includes('/mail/u/0/#inbox') || /^\/mail(\/|$)/.test(path) || url.hash.includes('inbox') || path === '/'):
      return 'inbox';
    case url.hostname === 'myaccount.google.com':
      return 'inbox';
    case /\/CheckCookie/i.test(path):
      return 'transition';
    case url.hostname !== 'accounts.google.com':
      return 'manual';
    case /^\/v3\/signin\/rejected\/?$/.test(path):
      return 'rejected';
    case /\/challenge\/(pwd|password)/.test(path):
      return 'password';
    case /\/challenge\/totp/.test(path):
      return 'totp';
    case /\/challenge\/kpe/.test(path):
      return 'recovery';
    case /\/challenge\/selection/.test(path):
      return 'selection';
    case /\/challenge\/recaptcha/.test(path):
      return 'recaptcha';
    case /\/challenge\/iap/.test(path):
      return 'verify_phone';
    case /\/challenge\/skotp/.test(path):
      return 'skotp';
    case /\/challenge\/pk/.test(path):
      return 'passkey';
    case /\/identifier|\/ServiceLogin/.test(path):
      return 'email';
    default:
      return 'manual';
  }
});

const totp = t('gmail.totp', (secret, now = Date.now()) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const normalized = String(secret || '').replace(/\s+/g, '').replace(/=+$/, '').toUpperCase();
  if (!/^[A-Z2-7]{16,}$/.test(normalized)) throw failure('missing_totp', 'Khóa Authenticator không hợp lệ hoặc chưa có.');
  let bits = 0, buffer = 0;
  const bytes = [];
  for (const char of normalized) {
    buffer = (buffer << 5) | alphabet.indexOf(char); bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((buffer >>> bits) & 255); }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30000)));
  const digest = crypto.createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = digest[19] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
});

// Subscribe BEFORE clicking; only a main-frame URL change completes this step.
const clickAndWaitUrl = t('gmail.clickAndWaitUrl', async (page, click, timeoutMs) => {
  const before = page.url();
  console.log('[login-trace] ⏳ Đăng ký theo dõi URL trước khi nhấn "Tiếp theo" (Next)...');
  let timer, onNavigation, onLoad, onClose, onError, pollInterval;
  let resolved = false;

  const changed = new Promise(t('gmail.subscribeUrl', (resolve, reject) => {
    const checkAndResolve = () => {
      if (resolved) return;
      try {
        const current = typeof page.url === 'function' ? page.url() : '';
        if (current && current !== before) {
          resolved = true;
          console.log('[login-trace] 🚀 URL đã thay đổi thành công sau khi nhấn "Tiếp theo" (Next) -> chuyển bước kế tiếp.');
          resolve();
        }
      } catch (_) {}
    };

    onNavigation = t('gmail.urlChanged', frame => {
      if (frame === page.mainFrame()) {
        checkAndResolve();
      }
    });
    onLoad = t('gmail.pageLoaded', () => {
      checkAndResolve();
    });
    onClose = t('gmail.pageClosed', () => {
      if (!resolved) reject(failure('closed', 'Trình duyệt đã đóng.'));
    });
    onError = t('gmail.pageError', () => {
      if (!resolved) reject(failure('page_error', 'Trang đăng nhập gặp lỗi.'));
    });

    page.on('framenavigated', onNavigation);
    if (typeof page.on === 'function') {
      try { page.on('load', onLoad); } catch (_) {}
      try { page.on('domcontentloaded', onLoad); } catch (_) {}
    }
    page.on('close', onClose);
    page.on('error', onError);

    // Bổ sung polling chu kỳ ngắn phòng trường hợp pushState / SPA không bắn framenavigated
    pollInterval = setInterval(checkAndResolve, timeoutMs <= 500 ? 50 : 200);

    timer = setTimeout(t('gmail.urlTimeout', async () => {
      if (resolved) return;
      checkAndResolve();
      if (resolved) return;
      console.error('[login-trace] ❌ Hết thời gian chờ: URL không đổi sau khi nhấn "Tiếp theo" (Next).');
      let pageMsg = '';
      try {
        if (typeof page.evaluate === 'function') {
          const res = await page.evaluate(() => {
            const sel = '[aria-live="assertive"], div[jsname="B1fBne"], .Ekjuhf, div[role="alert"], div.o6cuMc, .dEOOab';
            const els = [...document.querySelectorAll(sel)];
            for (const el of els) {
              const txt = (el.innerText || el.textContent || '').trim();
              if (txt && !el.hidden && el.offsetParent !== null) return txt;
            }
            return '';
          });
          if (typeof res === 'string') pageMsg = res;
        }
      } catch (_) {}
      const errMsg = pageMsg ? `Lỗi: ${pageMsg.slice(0, 100)}` : 'URL không đổi sau Next (kiểm tra mật khẩu/tài khoản).';
      reject(failure('url_unchanged', errMsg));
    }), timeoutMs);
  }));

  try {
    console.log('[login-trace] 🖱️ Đang nhấn nút "Tiếp theo" (Next)...');
    await Promise.all([
      changed,
      (async () => {
        await click();
        try {
          if (!resolved && typeof page.url === 'function' && page.url() !== before) {
            resolved = true;
            console.log('[login-trace] 🚀 URL đã thay đổi ngay sau click -> chuyển bước kế tiếp.');
          }
        } catch (_) {}
      })()
    ]);
    console.log('[login-trace] 🆗 Thao tác nhấn "Tiếp theo" (Next) hoàn tất.');
  }
  finally {
    clearTimeout(timer);
    clearInterval(pollInterval);
    page.removeListener('framenavigated', onNavigation);
    if (typeof page.removeListener === 'function') {
      try { page.removeListener('load', onLoad); } catch (_) {}
      try { page.removeListener('domcontentloaded', onLoad); } catch (_) {}
    }
    page.removeListener('close', onClose);
    page.removeListener('error', onError);
  }
});

const assertAccounts = t('gmail.assertAccounts', page => {
  if (new URL(page.url()).origin !== 'https://accounts.google.com') throw failure('unsafe_page', 'Đã rời trang đăng nhập Google; dừng nhập thông tin.');
});

const waitForSelectorSafe = t('gmail.waitForSelectorSafe', async (page, selector, options = {}) => {
  const timeoutMs = options?.timeoutMs || 30000;
  const start = Date.now();
  const retryDelay = timeoutMs <= 500 ? 10 : 350;
  while (Date.now() - start < timeoutMs) {
    try {
      const remaining = Math.max(timeoutMs <= 500 ? 50 : 1000, timeoutMs - (Date.now() - start));
      return await page.waitForSelector(selector, { visible: true, timeout: remaining });
    } catch (err) {
      if (Date.now() - start >= timeoutMs) break;
      const msg = ((err && err.message) || '').toLowerCase();
      if (msg.includes('target closed') && page.isClosed && page.isClosed()) {
        throw failure('closed', 'Trình duyệt đã đóng.');
      }
      console.log(`[login-trace] ⏳ Đang đợi trang ổn định sau chuyển hướng (${selector})...`);
      await new Promise(r => setTimeout(r, retryDelay));
    }
  }
  throw failure('timeout', `Hết thời gian chờ phần tử ${selector}`);
});

const typeField = t('gmail.typeField', async (page, selector, value, options) => {
  if (!value) throw failure('missing_data', 'Thiếu thông tin cho bước đăng nhập hiện tại.');
  await waitForSelectorSafe(page, selector, options);
  assertAccounts(page);

  if (options.timeoutMs > 500) {
    await new Promise(r => setTimeout(r, 150));
  }

  await page.click(selector, { clickCount: 3 });
  await page.keyboard.press('Backspace');

  if (options.timeoutMs > 500) {
    await page.evaluate(sel => {
      const el = document.querySelector(sel);
      if (el && el.value) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(el, '');
        else el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, selector);
    await new Promise(r => setTimeout(r, 80));
  }

  for (const character of value) {
    assertAccounts(page);
    await page.keyboard.type(character, { delay: options.typingDelayMs });
  }

  if (options.timeoutMs > 500) {
    await new Promise(r => setTimeout(r, 150));
    const checkResult = await page.evaluate((sel, expectedLen) => {
      const el = document.querySelector(sel);
      if (!el) return { found: false, match: false, len: 0 };
      const val = el.value || '';
      return { found: true, match: val.length === expectedLen, len: val.length };
    }, selector, value.length);

    if (checkResult.found && !checkResult.match) {
      console.log(`[login-trace] ⚠️ Phát hiện nhập bị thiếu ký tự (${checkResult.len}/${value.length}). Đang xóa và gõ lại...`);
      await page.focus(selector);
      await page.evaluate(sel => {
        const el = document.querySelector(sel);
        if (el) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(el, '');
          else el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, selector);
      await new Promise(r => setTimeout(r, 150));

      for (const character of value) {
        assertAccounts(page);
        await page.keyboard.type(character, { delay: Math.max(options.typingDelayMs, 90) });
      }
      await new Promise(r => setTimeout(r, 150));

      const finalLen = await page.evaluate(sel => (document.querySelector(sel)?.value || '').length, selector);
      if (finalLen !== value.length) {
        console.log('[login-trace] ⚠️ Gõ lại vẫn thiếu ký tự -> Kích hoạt cơ chế đồng bộ trực tiếp giá trị vào ô...');
        await page.evaluate((sel, val) => {
          const el = document.querySelector(sel);
          if (!el) return;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(el, val);
          else el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, selector, value);
      }
    }
  }
});

const getRecaptchaCoord = t('gmail.getRecaptchaCoord', async page => {
  try {
    const coord = await page.evaluate(`(function() {
      var iframes = Array.from(document.querySelectorAll('iframe'));
      var iframe = iframes.find(function(f) {
        var src = (f.src || '').toLowerCase();
        var title = (f.title || '').toLowerCase();
        return src.indexOf('recaptcha/api2/anchor') !== -1 || title.indexOf('recaptcha') !== -1;
      }) || document.querySelector('iframe[src*="recaptcha"]');
      if (!iframe || iframe.offsetParent === null) return null;
      var r = iframe.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return {
        x: Math.round(r.left + 28),
        y: Math.round(r.top + (r.height / 2)),
        left: Math.round(r.left),
        top: Math.round(r.top)
      };
    })()`);
    if (!coord) return null;
    if (typeof page.frames === 'function') {
      const frames = page.frames();
      const anchorFrame = frames.find(f => {
        const u = (f.url && f.url()) || '';
        return u.includes('recaptcha') && (u.includes('anchor') || u.includes('api2'));
      });
      if (anchorFrame) {
        try {
          const elCoord = await anchorFrame.evaluate(`(function() {
            var el = document.querySelector('#recaptcha-anchor, .recaptcha-checkbox');
            if (!el) return null;
            var r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return null;
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          })()`);
          if (elCoord) {
            coord.x = Math.round(coord.left + elCoord.x);
            coord.y = Math.round(coord.top + elCoord.y);
          }
        } catch (_) {}
      }
    }
    return coord;
  } catch (_) {
    return null;
  }
});

const waitCheckboxReady = t('gmail.waitCheckboxReady', async (page, timeoutMs) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (classify(page.url()) !== 'recaptcha') return null;

    try {
      const coord = await getRecaptchaCoord(page);
      if (coord && typeof coord.x === 'number' && typeof coord.y === 'number' && coord.x > 0 && coord.y > 0) {
        return coord;
      }
    } catch (_) {}

    await new Promise(r => setTimeout(r, 200));
  }
  return null;
});

const clickRecaptchaNext = t('gmail.clickRecaptchaNext', async page => {
  assertAccounts(page);
  const sels = [
    '#recaptchaNext button',
    '#recaptchaNext [role="button"]',
    '#recaptchaNext',
    '#identifierNext button',
    '#identifierNext [role="button"]',
    '#identifierNext',
    '#next button',
    '#next',
    'button[type="submit"]',
    'button.VfPpkd-LgbsSe',
  ];
  for (const sel of sels) {
    try {
      if (typeof page.$ === 'function') {
        const el = await page.$(sel);
        if (el) {
          const isVisible = await page.evaluate(node => node.offsetParent !== null && !node.disabled, el);
          if (isVisible) {
            await humanClick(page, el);
            return;
          }
        }
      } else {
        await page.click(sel);
        return;
      }
    } catch (_) {}
  }
  try {
    if (typeof page.evaluate === 'function') {
      const clicked = await page.evaluate(() => {
        const targets = ['tiếp theo', 'next', 'xác nhận', 'confirm', 'tiếp tục'];
        const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'));
        for (const b of buttons) {
          if (b.offsetParent === null || b.disabled) continue;
          const text = (b.innerText || b.textContent || b.value || '').trim().toLowerCase();
          for (const t of targets) {
            if (text === t || (text.includes(t) && text.length < 30)) {
              b.click();
              return true;
            }
          }
        }
        return false;
      });
      if (clicked) return;
    }
  } catch (_) {}
  try {
    await page.click('#recaptchaNext');
  } catch (_) {}
});

const stepRecaptcha = t('gmail.stepRecaptcha', async (page, options) => {
  const solver = options.solver || new TwoCaptchaSolver({ apiKey: options.twoCaptchaApiKey });
  const evaluate = t('gmail.evaluate', script => page.evaluate(script));
  const navigationFinished = Symbol('navigationFinished');
  const recaptchaTimeoutMs = options.timeoutMs <= 500 ? options.timeoutMs : Math.max(options.timeoutMs || 30000, 120000);

  if (classify(page.url()) !== 'recaptcha') return;

  // 1. Chờ nút ô vuông reCAPTCHA thực sự xuất hiện trên màn hình
  console.log('[login-trace] 9.1 Đang chờ ô vuông reCAPTCHA xuất hiện...');
  const coord = await waitCheckboxReady(page, options.timeoutMs);
  if (classify(page.url()) !== 'recaptcha') return;
  if (!coord) {
    throw failure('manual', 'Không tìm thấy ô vuông reCAPTCHA trên trang.');
  }

  // 2. Chờ iframe sẵn sàng và gắn event listeners
  console.log('[login-trace] 9.1 Đã phát hiện ô vuông reCAPTCHA hiển thị, chuẩn bị bấm...');
  const humanDelay = options.timeoutMs <= 500 ? 5 : 1500;
  await new Promise(r => setTimeout(r, humanDelay));
  // 3. Hàm click chuột thật tại toạ độ checkbox
  const clickAt = t('gmail.clickAt', async (x, y) => {
    const freshCoord = (await getRecaptchaCoord(page)) || { x, y };
    console.log(`[TwoCaptcha] 🖱️ Bấm tích vào ô reCAPTCHA tại toạ độ: ${Math.round(freshCoord.x)} ${Math.round(freshCoord.y)}`);
    await page.mouse.click(freshCoord.x, freshCoord.y, { delay: 100 });
  });

  // 4. Gọi giải và bypass qua module twoCaptcha.js (tham khảo từ V1)
  let navigated = false;
  const onCheckboxNavigation = t('gmail.checkboxNavigation', frame => {
    if (frame === page.mainFrame() && classify(page.url()) !== 'recaptcha') navigated = true;
  });
  page.on('framenavigated', onCheckboxNavigation);

  const checkboxEvaluate = t('gmail.checkboxEvaluate', async script => {
    if (navigated) throw navigationFinished;
    try {
      const result = await evaluate(script);
      if (navigated) throw navigationFinished;
      return result;
    } catch (error) {
      if (navigated) throw navigationFinished;
      throw error;
    }
  });

  let result;
  try {
    if (typeof solver.solveAndBypass === 'function') {
      const spanSolve = trace.traceIn('gmail.recaptcha.solve');
      try {
        result = await solver.solveAndBypass({ evaluate: checkboxEvaluate, clickAt, autoClickNext: false, page });
        if (!result || !result.success) {
          throw failure('recaptcha_failed', result?.error || 'Giải CAPTCHA thất bại.');
        }
      } finally {
        trace.traceOut(spanSolve, result && result.success ? 'ok' : 'error');
      }
    } else {
      // Fallback cho mock solver trong unit test
      await clickAt(coord.x, coord.y);
      const isVerified = await solver.waitForCheckState(checkboxEvaluate, options.timeoutMs <= 500 ? 100 : 4000, 150);
      if (!isVerified) {
        const cap = await solver.detect(checkboxEvaluate);
        if (!cap || !cap.detected) throw failure('manual', 'Không nhận diện được CAPTCHA để giải tự động.');
        const spanSolve = trace.traceIn('gmail.recaptcha.solve');
        let solveResult;
        try {
          solveResult = await solver.solveRecaptchaV2({
            siteKey: cap.siteKey || cap.sitekey,
            pageUrl: cap.pageUrl || page.url(),
            invisible: cap.invisible,
            dataS: cap.dataS,
            heartbeat: () => evaluate('1'),
          });
          if (!solveResult || !solveResult.success) throw failure('recaptcha_failed', solveResult?.error || 'Giải CAPTCHA thất bại.');
        } finally {
          trace.traceOut(spanSolve, solveResult && solveResult.success ? 'ok' : 'error');
        }
        //try { if (page.keyboard && typeof page.keyboard.press === 'function') await page.keyboard.press('Escape'); } catch (_) {}
        await solver.injectToken(checkboxEvaluate, solveResult.token);
        //try { if (page.keyboard && typeof page.keyboard.press === 'function') await page.keyboard.press('Escape'); } catch (_) {}
      }
      result = { success: true, autoRedirected: classify(page.url()) !== 'recaptcha' };
    }
  } catch (error) {
    if (error === navigationFinished) return;
    throw error;
  } finally {
    page.removeListener('framenavigated', onCheckboxNavigation);
  }

  // 5. Kiểm tra xem sau khi nhận callback trang đã tự động điều chuyển chưa (giống V1)
  if (classify(page.url()) !== 'recaptcha' || result.autoRedirected) {
    console.log('[login-trace] 🚀 Google đã tự động chuyển tiếp sau khi giải CAPTCHA!');
    return;
  }

  // 6. reCAPTCHA đã hoàn tất xác minh mà URL chưa đổi -> Bấm Tiếp theo và chờ URL đổi theo AGENTS.md
  console.log('[login-trace] ➡️ reCAPTCHA đã hoàn tất xác minh -> Bấm "Tiếp theo" (Next) để chuyển bước...');
  await clickAndWaitUrl(page, t('gmail.nextAfterRecaptcha', async () => {
    await clickRecaptchaNext(page);
  }), recaptchaTimeoutMs);
});
const handleRecaptcha = stepRecaptcha;

const openLoginPage = t('gmail.openLoginPage', async (page, options) => {
  console.log('[login-trace] 4. Bắt đầu điều hướng tab + flow login Gmail.');
  const start = new URL('https://accounts.google.com/ServiceLogin');
  start.searchParams.set('service', 'mail');
  start.searchParams.set('continue', 'https://mail.google.com/mail/');
  await page.goto(start.href, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
});

const stepEmail = t('gmail.stepEmail', async (page, account, options) => {
  console.log('[login-trace] 9. Bước EMAIL: gõ email -> Tiếp theo.');
  const selector = '#identifierId';
  const next = '#identifierNext';
  await waitForSelectorSafe(page, selector, options);
  await typeField(page, selector, account.email, options);
  console.log('[login-trace] 9.x điền email = OK');
  await waitForSelectorSafe(page, next, options);
  await clickAndWaitUrl(page, t('gmail.next', () => { assertAccounts(page); return page.click(next); }), options.timeoutMs);
});

const stepPassword = t('gmail.stepPassword', async (page, account, options) => {
  console.log('[login-trace] 10. Bước MẬT KHẨU: gõ mật khẩu -> Tiếp theo.');
  const selector = 'input[name="Passwd"], input[type="password"], input[name="password"]';
  const nextSelectors = [
    '#passwordNext button',
    '#passwordNext [role="button"]',
    '#passwordNext',
    'button[type="submit"]',
    '#next',
    'button.VfPpkd-LgbsSe',
  ];
  await waitForSelectorSafe(page, selector, options);
  await typeField(page, selector, account.password, options);
  console.log('[login-trace] 10.x điền mật khẩu = OK');

  let chosenNext = '#passwordNext';
  for (const sel of nextSelectors) {
    try {
      if (typeof page.$ === 'function') {
        const el = await page.$(sel);
        if (el) {
          const vis = await page.evaluate(n => n.offsetParent !== null && !n.disabled, el);
          if (vis) { chosenNext = sel; break; }
        }
      } else {
        chosenNext = sel;
        break;
      }
    } catch (_) {}
  }

  await waitForSelectorSafe(page, chosenNext, options);
  await clickAndWaitUrl(page, t('gmail.next', () => { assertAccounts(page); return page.click(chosenNext); }), options.timeoutMs);
});

const stepRecovery = t('gmail.stepRecovery', async (page, account, options) => {
  console.log('[login-trace] 11. Bước EMAIL KHÔI PHỤC: điền email khôi phục -> Tiếp theo.');
  const selector = 'input[name="knowledgePreregisteredEmailResponse"]';
  const next = '#knowledgePreregisteredEmailNext';
  await waitForSelectorSafe(page, selector, options);
  await typeField(page, selector, account.recoveryMail, options);
  console.log('[login-trace] 11.x điền email khôi phục = OK');
  await waitForSelectorSafe(page, next, options);
  await clickAndWaitUrl(page, t('gmail.next', () => { assertAccounts(page); return page.click(next); }), options.timeoutMs);
});

const stepTotp = t('gmail.stepTotp', async (page, account, options) => {
  console.log('[login-trace] 11. Bước 2FA: sinh mã TOTP -> điền mã Authenticator -> Tiếp theo.');
  const selector = 'input[name="totpPin"]';
  const next = '#totpNext';
  await waitForSelectorSafe(page, selector, options);
  await typeField(page, selector, totp(account.twofa), options);
  console.log('[login-trace] 11.x điền mã 2FA = OK');
  await waitForSelectorSafe(page, next, options);
  await clickAndWaitUrl(page, t('gmail.next', () => { assertAccounts(page); return page.click(next); }), options.timeoutMs);
});

const closeSelectionBrowser = t('gmail.closeSelectionBrowser', async page => {
  if (typeof page.browser === 'function') {
    await page.browser().close();
  }
});

const humanClick = t('gmail.humanClick', async (page, el, timeoutMs = 30000) => {
  const info = await page.evaluate(node => {
    node.scrollIntoView({ block: 'center', inline: 'center' });
    var r = node.getBoundingClientRect();
    return {
      tag: node.tagName,
      text: (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' '),
      rect: { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height }
    };
  }, el);

  if (info.rect.width > 0 && info.rect.height > 0 && page.mouse && typeof page.mouse.click === 'function') {
    if (typeof page.mouse.move === 'function') {
      if (timeoutMs > 500) {
        await page.mouse.move(info.rect.x, info.rect.y, { steps: 20 });
        await new Promise(r => setTimeout(r, 120 + Math.floor(Math.random() * 80)));
      } else {
        await page.mouse.move(info.rect.x, info.rect.y);
      }
    }
    const delay = timeoutMs > 500 ? (80 + Math.floor(Math.random() * 60)) : 50;
    await page.mouse.click(info.rect.x, info.rect.y, { delay });
    return true;
  }

  if (typeof el.click === 'function') {
    await el.click();
    return true;
  }

  await page.evaluate(node => { node.click(); }, el);
  return true;
});

const stepSelection = t('gmail.stepSelection', async (page, account, options, onStatus) => {
  console.log('[login-trace] 11. Bước CHỌN PHƯƠNG THỨC XÁC MINH (challenge/selection)...');

  const startWait = Date.now();
  let authenticatorFound = false;
  const maxWait = Math.min(options.timeoutMs, 20000);

  while (Date.now() - startWait < maxWait) {
    authenticatorFound = await page.evaluate(() => {
      var targets = [
        'get a verification code from the google authenticator app',
        'google authenticator',
        'authenticator app',
        'authenticator',
        'nhận mã xác minh từ ứng dụng google authenticator',
        'ứng dụng google authenticator'
      ];
      var dt = document.querySelector('[data-challengetype="6"]');
      if (dt && dt.offsetParent !== null) return true;

      var candidates = Array.from(document.querySelectorAll('li, div[role="link"], div[role="button"], button, [data-challengetype]'));
      for (var i = 0; i < candidates.length; i++) {
        var el = candidates[i];
        if (el.offsetParent === null) continue;
        var text = (el.innerText || el.textContent || '').trim().toLowerCase();
        for (var j = 0; j < targets.length; j++) {
          if (text.includes(targets[j])) return true;
        }
      }
      return false;
    });

    if (authenticatorFound) break;
    if (options.timeoutMs <= 500) break;
    await new Promise(r => setTimeout(r, 300));
  }

  // Thu thập danh sách các tùy chọn trên trang selection để log chẩn đoán
  try {
    const availableOptions = await page.evaluate(() => {
      var candidates = Array.from(document.querySelectorAll('li, div[role="link"], div[role="button"], button, [data-challengetype]'));
      return candidates
        .filter(function(el) { return el.offsetParent !== null; })
        .map(function(el) {
          return {
            tag: el.tagName,
            challengeType: el.getAttribute('data-challengetype'),
            text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ')
          };
        })
        .filter(function(o) { return o.text.length > 0 && o.text.length < 120; });
    });
    console.log('[login-trace] 11.x Danh sách các tùy chọn trên trang selection:', JSON.stringify(availableOptions));
  } catch (_) {}

  if (!authenticatorFound && account.passkey) {
    console.log('[login-trace] 11.x Authenticator không có nhưng profile có Passkey -> Kiểm tra tùy chọn Passkey trên trang selection...');
    const passkeyOptionFound = await page.evaluate(() => {
      var targets = ['use your passkey', 'dùng khóa truy cập', 'passkey', 'khóa truy cập'];
      var dt = document.querySelector('[data-challengetype="39"]');
      if (dt && dt.offsetParent !== null) return true;
      var candidates = Array.from(document.querySelectorAll('li, div[role="link"], div[role="button"], button, [data-challengetype]'));
      for (var i = 0; i < candidates.length; i++) {
        var el = candidates[i];
        if (el.offsetParent === null) continue;
        var text = (el.innerText || el.textContent || '').trim().toLowerCase();
        for (var j = 0; j < targets.length; j++) {
          if (text.includes(targets[j])) return true;
        }
      }
      return false;
    });

    if (passkeyOptionFound) {
      console.log('[login-trace] 11.x Đã tìm thấy tùy chọn Passkey trên trang selection -> Tiến hành chọn...');
      await clickAndWaitUrl(page, t('gmail.selectPasskey', async () => {
        assertAccounts(page);
        await page.evaluate(() => {
          var targets = ['use your passkey', 'dùng khóa truy cập', 'passkey', 'khóa truy cập'];
          var dt = document.querySelector('[data-challengetype="39"]');
          if (dt && dt.offsetParent !== null) { dt.click(); return; }
          var candidates = Array.from(document.querySelectorAll('li, div[role="link"], div[role="button"], button, [data-challengetype]'));
          for (var i = 0; i < candidates.length; i++) {
            var el = candidates[i];
            if (el.offsetParent === null) continue;
            var text = (el.innerText || el.textContent || '').trim().toLowerCase();
            for (var j = 0; j < targets.length; j++) {
              if (text.includes(targets[j])) {
                const btn = el.closest('li, div[role="link"], div[role="button"], button') || el;
                btn.click();
                return;
              }
            }
          }
        });
      }), options.timeoutMs);
      return;
    }
  }

  if (!authenticatorFound) {
    console.warn('[login-trace] 11.x Không tìm thấy dòng "Get a verification code from the Google Authenticator app" -> Đóng trình duyệt và báo lỗi.');
    if (typeof onStatus === 'function') {
      await onStatus('manual', 'Không có tùy chọn Google Authenticator trong danh sách xác minh; đã đóng trình duyệt.');
    }
    await closeSelectionBrowser(page);
    throw failure('no_authenticator', 'Không có tùy chọn Google Authenticator trong danh sách xác minh; đã đóng trình duyệt.');
  }

  console.log('[login-trace] 11.x Đã tìm thấy tùy chọn Google Authenticator -> Tiến hành chọn...');
  if (options.timeoutMs > 1000) {
    await new Promise(r => setTimeout(r, 500 + Math.floor(Math.random() * 300)));
  }

  await clickAndWaitUrl(page, t('gmail.selectAuthenticator', async () => {
    assertAccounts(page);

    if (typeof page.evaluateHandle === 'function') {
      try {
        const handle = await page.evaluateHandle(() => {
          var targets = [
            'get a verification code from the google authenticator app',
            'google authenticator',
            'authenticator app',
            'authenticator',
            'nhận mã xác minh từ ứng dụng google authenticator',
            'ứng dụng google authenticator'
          ];
          var dt = document.querySelector('[data-challengetype="6"]');
          if (dt && dt.offsetParent !== null) return dt;

          var candidates = Array.from(document.querySelectorAll('li, div[role="link"], div[role="button"], button, [data-challengetype]'));
          for (var i = 0; i < candidates.length; i++) {
            var el = candidates[i];
            if (el.offsetParent === null) continue;
            var text = (el.innerText || el.textContent || '').trim().toLowerCase();
            for (var j = 0; j < targets.length; j++) {
              if (text.includes(targets[j])) {
                return el.closest('li, div[role="link"], div[role="button"], button') || el;
              }
            }
          }
          return null;
        });

        const el = handle.asElement();
        if (el) {
          await humanClick(page, el, options.timeoutMs);
          return;
        }
      } catch (_) {}
    }

    const clicked = await page.evaluate(() => {
      var targets = [
        'get a verification code from the google authenticator app',
        'google authenticator',
        'authenticator app',
        'authenticator',
        'nhận mã xác minh từ ứng dụng google authenticator',
        'ứng dụng google authenticator'
      ];
      var dt = document.querySelector('[data-challengetype="6"]');
      if (dt && dt.offsetParent !== null) {
        dt.click();
        return true;
      }
      var candidates = Array.from(document.querySelectorAll('li, div[role="link"], div[role="button"], button, [data-challengetype]'));
      for (var i = 0; i < candidates.length; i++) {
        var el = candidates[i];
        if (el.offsetParent === null) continue;
        var text = (el.innerText || el.textContent || '').trim().toLowerCase();
        for (var j = 0; j < targets.length; j++) {
          if (text.includes(targets[j])) {
            el.click();
            return true;
          }
        }
      }
      return false;
    });

    if (!clicked && typeof page.click === 'function') {
      await page.click('[data-challengetype="6"]');
    }
  }), options.timeoutMs);
});

const clickTryAnotherWay = t('gmail.clickTryAnotherWay', async (page, timeoutMs = 10000) => {
  console.log('[login-trace] 11.x Bắt đầu tìm nút "Try another way"... URL hiện tại:', page.url());
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (typeof page.evaluateHandle === 'function') {
      try {
        const handle = await page.evaluateHandle(() => {
          var targets = [
            'try another way',
            'thử cách khác',
            'andere option wählen',
            'probar otra manera',
            'essayer une autre méthode'
          ];

          // Priority 1: Direct button, [role="button"], or a
          var buttons = Array.from(document.querySelectorAll('button, [role="button"], a'));
          for (var i = 0; i < buttons.length; i++) {
            var b = buttons[i];
            if (b.offsetParent === null) continue;
            var bText = (b.innerText || b.textContent || '').trim().toLowerCase();
            for (var t = 0; t < targets.length; t++) {
              if (bText === targets[t] || (bText.indexOf(targets[t]) !== -1 && bText.length < 50)) {
                return b;
              }
            }
          }

          // Priority 2: Leaf span/div text whose closest ancestor is a button/link
          var leaves = Array.from(document.querySelectorAll('span, div[jsname], p'));
          for (var j = 0; j < leaves.length; j++) {
            var l = leaves[j];
            if (l.offsetParent === null) continue;
            if (l.querySelector('button, [role="button"], a')) continue;
            var lText = (l.innerText || l.textContent || '').trim().toLowerCase();
            for (var k = 0; k < targets.length; k++) {
              if (lText === targets[k] || (lText.indexOf(targets[k]) !== -1 && lText.length < 50)) {
                var parentBtn = l.closest('button, [role="button"], a');
                return parentBtn || l;
              }
            }
          }
          return null;
        });

        const el = handle.asElement();
        if (el) {
          console.log('[login-trace] 11.x Đã tìm thấy nút "Try another way", thực hiện click tự nhiên...');
          await humanClick(page, el, timeoutMs);
          console.log('[login-trace] 11.x Đã thực hiện click "Try another way" thành công!');
          return true;
        }
      } catch (err) {
        console.warn('[login-trace] 11.x Lỗi khi tìm/click qua handle:', err.message);
      }
    }

    const fallbackClicked = await page.evaluate(() => {
      var targets = [
        'try another way',
        'thử cách khác',
        'andere option wählen',
        'probar otra manera',
        'essayer une autre méthode'
      ];
      var buttons = Array.from(document.querySelectorAll('button, [role="button"], a'));
      for (var i = 0; i < buttons.length; i++) {
        var b = buttons[i];
        if (b.offsetParent === null) continue;
        var bText = (b.innerText || b.textContent || '').trim().toLowerCase();
        for (var t = 0; t < targets.length; t++) {
          if (bText === targets[t] || (bText.indexOf(targets[t]) !== -1 && bText.length < 50)) {
            b.click();
            return true;
          }
        }
      }
      return false;
    });

    if (fallbackClicked) {
      console.log('[login-trace] 11.x Đã click nút qua evaluate fallback.');
      return true;
    }

    if (timeoutMs <= 500) break;
    await new Promise(r => setTimeout(r, 500));
  }

  try {
    const pageDump = await page.evaluate(() => {
      var allButtons = Array.from(document.querySelectorAll('button, [role="button"], a')).map(function(el) {
        return { tag: el.tagName, text: (el.innerText || el.textContent || '').trim(), cls: el.className };
      });
      return { url: window.location.href, buttons: allButtons };
    });
    console.warn('[login-trace] 11.x Không tìm thấy nút "Try another way". DOM buttons:', JSON.stringify(pageDump));
  } catch (_) {}

  return false;
});

const stepSkotp = t('gmail.stepSkotp', async (page, account, options) => {
  console.log('[login-trace] 11. Bước SECURITY CODE (challenge/skotp)...');
  const securityCode = account.securityCode || account.security_code || '';

  if (securityCode) {
    console.log('[login-trace] 11.x Profile có Security code -> Tiến hành nhập...');
    await page.evaluate(() => {
      var targets = ['get a one-time security code', 'nhận mã bảo mật một lần', 'security code', 'mã bảo mật'];
      var candidates = Array.from(document.querySelectorAll('button, [role="button"], [role="link"], li, a, div[data-challengetype]'));
      for (var i = 0; i < candidates.length; i++) {
        var el = candidates[i];
        if (el.offsetParent === null) continue;
        var text = (el.innerText || el.textContent || '').trim().toLowerCase();
        for (var j = 0; j < targets.length; j++) {
          if (text.indexOf(targets[j]) !== -1) {
            var clickable = el.closest('button, [role="button"], li, a') || el;
            clickable.click();
            return;
          }
        }
      }
    });

    const inputSelectors = [
      'input[name="Pin"]',
      'input[name="pin"]',
      'input[type="tel"]',
      'input[id*="Pin"]',
      'input[id*="pin"]',
      'input[autocomplete="one-time-code"]',
      'input[name="totpPin"]',
      'input[type="text"]'
    ];

    let foundSel = null;
    if (typeof page.$ !== 'function') {
      foundSel = inputSelectors[0];
    } else {
      const startWait = Date.now();
      while (Date.now() - startWait < options.timeoutMs) {
        for (const sel of inputSelectors) {
          try {
            const el = await page.$(sel);
            if (el && await page.evaluate(node => node.offsetParent !== null && !node.disabled && !node.readOnly, el)) {
              foundSel = sel;
              break;
            }
          } catch (_) {}
        }
        if (foundSel) break;
        await new Promise(r => setTimeout(r, 200));
      }
    }

    if (!foundSel) throw failure('manual', 'Không tìm thấy ô nhập Security code.');

    await typeField(page, foundSel, securityCode, options);
    console.log('[login-trace] 11.x điền Security code = OK');

    const nextSelectors = [
      '#idvPreregisteredPhoneNext button',
      '#idvPreregisteredPhoneNext',
      '#totpNext button',
      '#totpNext',
      '#next button',
      '#next',
      'button[type="submit"]',
    ];

    let nextBtn = null;
    if (typeof page.$ === 'function') {
      for (const sel of nextSelectors) {
        try {
          const el = await page.$(sel);
          if (el && await page.evaluate(node => node.offsetParent !== null && !node.disabled, el)) {
            nextBtn = sel;
            break;
          }
        } catch (_) {}
      }
    } else {
      nextBtn = nextSelectors[0];
    }

    await clickAndWaitUrl(page, t('gmail.nextSecurityCode', async () => {
      assertAccounts(page);
      if (nextBtn) {
        await page.click(nextBtn);
      } else {
        await page.keyboard.press('Enter');
      }
    }), options.timeoutMs);
  } else {
    console.log('[login-trace] 11.x Profile không có Security code -> Chuẩn bị nhấn nút "Try another way"...');
    if (options.timeoutMs > 2000) {
      console.log('[login-trace] 11.x Chờ tự nhiên để trang và botguard ổn định...');
      await new Promise(r => setTimeout(r, 1500 + Math.floor(Math.random() * 500)));
    }
    await clickAndWaitUrl(page, t('gmail.tryAnotherWay', async () => {
      assertAccounts(page);
      const clicked = await clickTryAnotherWay(page, options.timeoutMs);
      if (!clicked) {
        throw failure('manual', 'Không tìm thấy nút "Try another way" trên trang.');
      }
    }), options.timeoutMs);
  }
});

const stepInbox = t('gmail.stepInbox', async (page, account, options) => {
  try {
    await page.waitForSelector('[role="main"], [aria-label="Primary"], [aria-label="Chính"]', { visible: true, timeout: Math.min(options.timeoutMs, 5000) });
  } catch (_) {}
  if (classify(page.url()) !== 'inbox') throw failure('manual', 'Cần kiểm tra trang Gmail thủ công.');
  const matchesAccount = await page.evaluate(email => {
    const wanted = (email || '').toLowerCase();
    const href = window.location.href.toLowerCase();
    if (href.includes('mail.google.com/mail/u/0/#inbox') || href.includes('#inbox')) return true;
    if (document.title && document.title.toLowerCase().includes(wanted)) return true;
    return [...document.querySelectorAll('[data-email], a[aria-label], button[aria-label], div[aria-label]')].some(node => {
      const de = (node.getAttribute('data-email') || '').toLowerCase();
      const al = (node.getAttribute('aria-label') || '').toLowerCase();
      return de === wanted || al.includes(wanted);
    });
  }, account.email);
  if (!matchesAccount) throw failure('manual', 'Đã mở Gmail nhưng chưa xác nhận được đúng tài khoản của profile. Hãy kiểm tra thủ công.');
  console.log('[login-trace] 12. Đã vào hộp thư Gmail thành công!');
  return { status: 'success' };
});

const clickPasskeyContinue = t('gmail.clickPasskeyContinue', async (page, timeoutMs = 15000) => {
  console.log('[login-trace] 9.5 Bắt đầu tìm và tự động bấm nút "Continue" / "Tiếp tục"...');
  const start = Date.now();
  const clickLabels = ['continue', 'tiếp tục', 'continuer', 'continuar', 'weiter', 'siguiente'];

  while (Date.now() - start < timeoutMs) {
    if (typeof page.evaluateHandle === 'function') {
      try {
        const handle = await page.evaluateHandle(targetLabels => {
          const targets = targetLabels.map(l => l.toLowerCase());

          // 1. Ưu tiên tìm theo ID hoặc selector đặc trưng của nút Next/Continue Google
          const idSelectors = [
            '#passkeyNext',
            '#passkeyNext button',
            '#next',
            '#next button',
            'button[type="submit"]',
            '[data-idomclass*="passkey"]',
            'div[jsname="LgbsSe"]'
          ];
          for (const sel of idSelectors) {
            const el = document.querySelector(sel);
            if (el && el.offsetParent !== null) {
              const text = (el.innerText || el.textContent || '').trim().toLowerCase();
              if (!text || targets.some(t => text.includes(t))) {
                return el.closest('button, [role="button"], a') || el;
              }
            }
          }

          // 2. Tìm theo text của candidates (button, role="button", a, div[role="button"], span)
          const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, div[role="button"], span'));
          for (let i = 0; i < candidates.length; i++) {
            const el = candidates[i];
            if (el.offsetParent === null) continue;
            const text = (el.innerText || el.textContent || '').trim().toLowerCase();
            for (let j = 0; j < targets.length; j++) {
              if (text === targets[j] || (text.includes(targets[j]) && text.length < 50)) {
                return el.closest('button, [role="button"], a, div[role="button"]') || el;
              }
            }
          }
          return null;
        }, clickLabels);

        const el = handle.asElement();
        if (el) {
          console.log('[login-trace] 9.5 Đã tìm thấy nút Continue, thực hiện click tự nhiên qua humanClick...');
          const clicked = await humanClick(page, el, timeoutMs);
          if (clicked) {
            console.log('[login-trace] 9.5 Đã click nút Continue thành công qua humanClick!');
            return true;
          }
        }
      } catch (err) {
        console.warn('[login-trace] 9.5 Lỗi khi tìm/click Continue qua evaluateHandle:', err.message);
      }
    }

    // Fallback: evaluate click
    if (typeof page.evaluate === 'function') {
      try {
        const fallbackClicked = await page.evaluate(targetLabels => {
          const targets = targetLabels.map(l => l.toLowerCase());
          const idSelectors = ['#passkeyNext', '#passkeyNext button', '#next', '#next button', 'button[type="submit"]'];
          for (const sel of idSelectors) {
            const el = document.querySelector(sel);
            if (el && el.offsetParent !== null) {
              el.click();
              return true;
            }
          }
          const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, div[role="button"], span'));
          for (let i = 0; i < candidates.length; i++) {
            const el = candidates[i];
            if (el.offsetParent === null) continue;
            const text = (el.innerText || el.textContent || '').trim().toLowerCase();
            for (let j = 0; j < targets.length; j++) {
              if (text === targets[j] || (text.includes(targets[j]) && text.length < 50)) {
                const btn = el.closest('button, [role="button"], a, div[role="button"]') || el;
                btn.click();
                return true;
              }
            }
          }
          return false;
        }, clickLabels);

        if (fallbackClicked) {
          console.log('[login-trace] 9.5 Đã bấm nút Continue qua evaluate click!');
          return true;
        }
      } catch (_) {}
    }

    if (timeoutMs <= 500) break;
    await new Promise(r => setTimeout(r, 600));
  }

  console.warn('[login-trace] 9.5 Không tìm thấy nút "Continue" trên trang.');
  return false;
});

const signInViaFreshPasskeyTab = t('gmail.signInViaFreshPasskeyTab', async (page, passkeyBlob, options = {}) => {
  const blob = (passkeyBlob || '').trim();
  if (!blob) return false;
  let cred;
  try {
    cred = JSON.parse(Buffer.from(blob, 'base64').toString('utf8'));
  } catch (err) {
    console.warn('[passkey-login] Không thể giải mã passkey blob base64:', err.message);
    return false;
  }

  const browser = typeof page.browser === 'function' ? page.browser() : null;
  if (!browser || typeof browser.newPage !== 'function') {
    console.warn('[passkey-login] Browser không hỗ trợ newPage -> hủy.');
    return false;
  }

  const challengeUrl = typeof page.url === 'function' ? page.url() : '';
  console.log('[passkey-login] Mở tab mới sạch để gắn CDP Virtual Authenticator...');

  let freshPage = null;
  let client = null;
  try {
    freshPage = await browser.newPage();
    let authenticatorId = null;

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
      authenticatorId = va && va.authenticatorId;
      if (!authenticatorId) {
        console.warn('[passkey-login] Tab mới: Không tạo được virtual authenticator -> hủy.');
        return false;
      }
      await client.send('WebAuthn.addCredential', { authenticatorId, credential: cred });
      console.log(`[passkey-login] Tab mới đã sẵn sàng (authId=${authenticatorId}) -> Điều hướng.`);
    } else if (typeof freshPage.addVirtualAuthenticator === 'function') {
      const mockAuth = await freshPage.addVirtualAuthenticator(cred);
      authenticatorId = mockAuth && mockAuth.id;
    }

    if (typeof freshPage.goto === 'function') {
      await freshPage.goto(challengeUrl, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs || 30000 }).catch(() => {});
    }

    if (typeof freshPage.evaluate === 'function') {
      try {
        if (typeof freshPage.waitForFunction === 'function') {
          await freshPage.waitForFunction(() => document.readyState === 'complete', { timeout: 10000 });
        }
      } catch (_) {}
    }

    console.log('[passkey-login] Tab mới: Tìm và tự động bấm nút "Continue" / "Tiếp tục"...');
    await clickPasskeyContinue(freshPage, Math.min(options.timeoutMs || 30000, 15000));

    const timeout = Math.min(options.timeoutMs || 30000, 30000);
    const startWait = Date.now();
    let success = false;
    const pollDelay = options.timeoutMs <= 500 ? 50 : 500;
    while (Date.now() - startWait < timeout) {
      const cur = typeof freshPage.url === 'function' ? freshPage.url() : '';
      if (typeof cur === 'string' && (cur.includes('mail.google.com/mail') || cur.includes('CheckCookie') || cur.includes('myaccount.google.com'))) {
        success = true;
        break;
      }
      await new Promise(r => setTimeout(r, pollDelay));
    }

    console.log(`[passkey-login] Kết quả xác thực trên tab mới: ${success ? 'THÀNH CÔNG' : 'thất bại/hết giờ'}.`);
    return success;
  } catch (e) {
    console.warn('[passkey-login] LỖI trên tab mới:', e && e.message);
    return false;
  } finally {
    if (client && typeof client.detach === 'function') {
      try { await client.detach(); } catch (_) {}
    }
    if (freshPage && typeof freshPage.close === 'function') {
      try { await freshPage.close(); } catch (_) {}
    }
  }
});

const stepPasskey = t('gmail.stepPasskey', async (page, account, options) => {
  console.log('[login-trace] 9.5 Bước PASSKEY (challenge/pk)...');
  const passkey = account.passkey;
  if (passkey && passkey.trim()) {
    console.log('[login-trace] 9.5 Profile có Passkey -> Thử xác thực qua tab mới gắn CDP Virtual Authenticator...');
    const ok = await signInViaFreshPasskeyTab(page, passkey, options);
    if (ok) {
      console.log('[login-trace] 9.5.x Xác thực Passkey thành công -> Điều hướng tab chính về hộp thư Gmail...');
      await page.goto('https://mail.google.com/mail/', { waitUntil: 'domcontentloaded', timeout: options.timeoutMs }).catch(() => {});
      return;
    }
    console.warn('[login-trace] 9.5.x Xác thực Passkey qua tab mới không thành công -> Thử thao tác trên tab chính...');
  } else {
    console.log('[login-trace] 9.5 Profile không có Passkey cấu hình sẵn -> Tự động bấm nút "Continue" trên trang hiện tại...');
  }

  if (options.timeoutMs > 2000) {
    await new Promise(r => setTimeout(r, 800 + Math.floor(Math.random() * 400)));
  }

  // 1) Tự động bấm nút "Continue" trước
  let continueSuccess = false;
  try {
    const continueTimeout = Math.min(options.timeoutMs, 8000);
    await clickAndWaitUrl(page, t('gmail.clickContinuePasskey', async () => {
      assertAccounts(page);
      const clicked = await clickPasskeyContinue(page, continueTimeout);
      if (!clicked) {
        throw failure('not_found', 'Không tìm thấy nút Continue trên trang Passkey.');
      }
    }), continueTimeout);
    continueSuccess = true;
  } catch (err) {
    console.log('[login-trace] 9.5 Đã bấm Continue hoặc hết giờ chờ URL đổi sau Continue:', err.message);
  }

  if (continueSuccess) {
    console.log('[login-trace] 9.5 URL đã đổi thành công sau khi bấm nút Continue!');
    return;
  }

  // 2) Nếu sau khi bấm Continue mà vẫn ở trang Passkey (chưa đổi URL), fallback bấm "Try another way"
  if (classify(page.url()) === 'passkey') {
    console.log('[login-trace] 9.5 URL vẫn ở trang Passkey -> Thử nhấn "Try another way"...');
    await clickAndWaitUrl(page, t('gmail.tryAnotherWayPasskey', async () => {
      assertAccounts(page);
      const clicked = await clickTryAnotherWay(page, options.timeoutMs);
      if (!clicked) {
        throw failure('manual', 'Không tìm thấy nút "Try another way" trên trang Passkey.');
      }
    }), options.timeoutMs);
  }
});

const PASSWORD_VISIBLE = `(() => {
  const input = document.querySelector('input[name="Passwd"][type="password"]');
  if (!input || input.disabled || input.readOnly) return false;
  const rect = input.getBoundingClientRect();
  const style = getComputedStyle(input);
  if (rect.width <= 0 || rect.height <= 0 || style.visibility !== 'visible' || Number(style.opacity) === 0) return false;
  const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
  return x >= 0 && y >= 0 && x < innerWidth && y < innerHeight && document.elementFromPoint(x, y) === input;
})()`;
const closeWithoutPassword = t('gmail.closeWithoutPassword', async (page, options) => {
  await page.waitForSelector('input[name="Passwd"][type="password"]', { visible: true, timeout: options.timeoutMs });
  const ready = await page.waitForFunction(PASSWORD_VISIBLE, { timeout: options.timeoutMs, polling: 'raf' });
  if (ready) await ready.dispose();
  if (classify(page.url()) !== 'password') throw failure('manual', 'Trang đã rời bước mật khẩu; dừng tự đóng.');
  // Requested grace period before closing, not a wait for navigation.
  await new Promise(t('gmail.closeWithoutPassword.timer', resolve => {
    setTimeout(t('gmail.closeWithoutPassword.elapsed', resolve), 3000);
  }));
  if (classify(page.url()) !== 'password' || !await page.evaluate(PASSWORD_VISIBLE)) {
    throw failure('manual', 'Ô mật khẩu không còn hiển thị; giữ trình duyệt để kiểm tra.');
  }
  await page.browser().close();
});

const closeRejectedBrowser = t('gmail.closeRejectedBrowser', async page => {
  await page.browser().close();
});

const closeVerifyPhoneBrowser = t('gmail.closeVerifyPhoneBrowser', async page => {
  await page.browser().close();
});

const closeTimedOutBrowser = t('gmail.closeTimedOutBrowser', async page => {
  await page.browser().close();
});

const closeSuccessBrowser = t('gmail.closeSuccessBrowser', async (page, options = {}) => {
  if (options.timeoutMs > 500) {
    await new Promise(r => setTimeout(r, 1000));
  }
  if (typeof page?.browser === 'function') {
    const b = page.browser();
    if (b && typeof b.close === 'function') {
      await b.close();
    }
  }
});

const login = t('gmail.login', async (page, account, onStatus, input = {}) => {
  const options = { typingDelayMs: 90, timeoutMs: 30000, ...input };
  if (!Number.isInteger(options.typingDelayMs) || options.typingDelayMs < 1 || options.typingDelayMs > 1000) throw failure('config', 'Độ trễ gõ phải từ 1 đến 1000 ms.');
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120000) throw failure('config', 'Timeout đăng nhập không hợp lệ.');
  try {
    await onStatus('starting');
    if (page.url() && classify(page.url()) === 'inbox') {
      const result = await stepInbox(page, account, options);
      await onStatus('success');
      console.log('[login-trace] 12. Profile đã ở sẵn trang Gmail inbox -> đóng profile.');
      await closeSuccessBrowser(page, options);
      return result;
    }
    await openLoginPage(page, options);
    for (let step = 0; step < 10; step++) {
      const state = classify(page.url());
      if (state === 'rejected') {
        await onStatus('rejected', 'Google đã từ chối đăng nhập (signin/rejected).');
        await closeRejectedBrowser(page);
        throw failure('rejected', 'Google đã từ chối đăng nhập (signin/rejected).');
      }
      if (state === 'verify_phone') {
        await onStatus('verify_phone', 'Google yêu cầu xác minh số điện thoại (verify phone).');
        await closeVerifyPhoneBrowser(page);
        throw failure('verify_phone', 'Google yêu cầu xác minh số điện thoại (verify phone).');
      }
      if (state === 'transition') {
        console.log('[login-trace] ⏳ Đang chuyển hướng (CheckCookie)... chờ điều hướng tới hộp thư...');
        const startWait = Date.now();
        while (Date.now() - startWait < Math.min(options.timeoutMs, 10000)) {
          await new Promise(r => setTimeout(r, 300));
          const nextState = classify(page.url());
          if (nextState !== 'transition') break;
        }
        continue;
      }
      await onStatus(state);
      if (state === 'inbox') {
        const result = await stepInbox(page, account, options);
        await onStatus('success');
        console.log('[login-trace] 12. Flow login xong -> đóng profile.');
        await closeSuccessBrowser(page, options);
        return result;
      }
      if (state === 'manual') throw failure('manual', 'Cần thao tác thủ công trên trình duyệt (CAPTCHA, chọn tài khoản hoặc xác minh khác).');
      if (state === 'selection') {
        await stepSelection(page, account, options, onStatus);
        continue;
      }
      if (state === 'recaptcha') {
        console.warn('[login-trace] ⚠️ CẢNH BÁO: Phát hiện trang yêu cầu giải CAPTCHA (reCAPTCHA v2)!');
        await stepRecaptcha(page, options);
        continue;
      }
      if (state === 'email') {
        await stepEmail(page, account, options);
        continue;
      }
      if (state === 'password') {
        if (!account.password) {
          await onStatus('password_reached', 'Chờ mật khẩu');
          await closeWithoutPassword(page, options);
          return { status: 'password_reached' };
        }
        await stepPassword(page, account, options);
        continue;
      }
      if (state === 'recovery') {
        await stepRecovery(page, account, options);
        continue;
      }
      if (state === 'totp') {
        await stepTotp(page, account, options);
        continue;
      }
      if (state === 'skotp') {
        await stepSkotp(page, account, options);
        continue;
      }
      if (state === 'passkey') {
        await stepPasskey(page, account, options);
        continue;
      }
      throw failure('unknown_state', 'Trạng thái đăng nhập không xác định.');
    }
    throw failure('step_limit', 'Quá số bước đăng nhập; cần kiểm tra thủ công.');
  } catch (error) {
    if (error.loginCode === 'url_unchanged' || error.name === 'TimeoutError') {
      await onStatus('error', error.message || 'Hết thời gian chờ đăng nhập.');
      try { await closeTimedOutBrowser(page); }
      catch { throw failure('timeout_close_failed', 'Hết thời gian chờ đăng nhập nhưng chưa đóng được trình duyệt.'); }
      throw failure('timeout', error.message || 'Hết thời gian chờ đăng nhập; đã đóng trình duyệt và nhượng slot.');
    }
    if (error.loginCode) throw error;
    // Puppeteer exceptions may contain URLs or DOM values: never forward them.
    console.error('[login-trace] ❌ Lỗi ngoại lệ:', error?.message);
    throw failure('browser_error', 'Không hoàn tất bước đăng nhập. Kiểm tra trình duyệt và log của profile.');
  }
});

module.exports = {
  login,
  classify,
  totp,
  clickAndWaitUrl,
  typeField,
  handleRecaptcha,
  stepRecaptcha,
  openLoginPage,
  stepEmail,
  stepPassword,
  stepRecovery,
  stepTotp,
  stepSelection,
  stepSkotp,
  stepPasskey,
  signInViaFreshPasskeyTab,
  clickPasskeyContinue,
  stepInbox,
  closeSuccessBrowser,
  humanClick,
};
