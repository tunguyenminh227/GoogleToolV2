const crypto = require('node:crypto');
const trace = require('./trace-log');
const TwoCaptchaSolver = require('../twoCaptcha');
const t = trace.traced;

const failure = t('gmail.failure', (code, message) => {
  const span = trace.traceIn(`gmail.error.${code}`);
  try { return Object.assign(new Error(message), { loginCode: code }); }
  finally { trace.traceOut(span, 'error'); }
});
const classify = t('gmail.classify', value => {
  const url = new URL(value);
  const path = url.pathname;
  switch (true) {
    case url.protocol !== 'https:':
      return 'manual';
    case url.hostname === 'mail.google.com' && /^\/mail\//.test(path):
      return 'inbox';
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
  let timer, onNavigation, onClose, onError;
  const changed = new Promise(t('gmail.subscribeUrl', (resolve, reject) => {
    onNavigation = t('gmail.urlChanged', frame => {
      if (frame === page.mainFrame() && page.url() !== before) {
        console.log('[login-trace] 🚀 URL đã thay đổi thành công sau khi nhấn "Tiếp theo" (Next) -> chuyển bước kế tiếp.');
        resolve();
      }
    });
    onClose = t('gmail.pageClosed', () => reject(failure('closed', 'Trình duyệt đã đóng.')));
    onError = t('gmail.pageError', () => reject(failure('page_error', 'Trang đăng nhập gặp lỗi.')));
    page.on('framenavigated', onNavigation); page.on('close', onClose); page.on('error', onError);
    timer = setTimeout(t('gmail.urlTimeout', () => {
      console.error('[login-trace] ❌ Hết thời gian chờ: URL không đổi sau khi nhấn "Tiếp theo" (Next).');
      reject(failure('url_unchanged', 'URL không đổi sau Next. Kiểm tra lỗi trên trang; luồng đã dừng.'));
    }), timeoutMs);
  }));
  try {
    console.log('[login-trace] 🖱️ Đang nhấn nút "Tiếp theo" (Next)...');
    await Promise.all([changed, click()]);
    console.log('[login-trace] 🆗 Thao tác nhấn "Tiếp theo" (Next) hoàn tất.');
  }
  finally {
    clearTimeout(timer); page.removeListener('framenavigated', onNavigation);
    page.removeListener('close', onClose); page.removeListener('error', onError);
  }
});

const assertAccounts = t('gmail.assertAccounts', page => {
  if (new URL(page.url()).origin !== 'https://accounts.google.com') throw failure('unsafe_page', 'Đã rời trang đăng nhập Google; dừng nhập thông tin.');
});
const typeField = t('gmail.typeField', async (page, selector, value, options) => {
  if (!value) throw failure('missing_data', 'Thiếu thông tin cho bước đăng nhập hiện tại.');
  await page.waitForSelector(selector, { visible: true, timeout: options.timeoutMs });
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
        result = await solver.solveAndBypass({ evaluate: checkboxEvaluate, clickAt, autoClickNext: false });
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

  // Nếu chưa tự chuyển, bấm nút "Tiếp theo" (Next) và chờ URL đổi (tạm thời comment lại)
  // console.log('[login-trace] ➡️ Trang chưa tự chuyển -> Bấm Tiếp theo sau khi giải CAPTCHA...');
  // await clickAndWaitUrl(page, t('gmail.next', async () => {
  //   assertAccounts(page);
  //   let clicked = false;
  //   if (solver && typeof solver.clickNext === 'function') {
  //     const clickRes = await solver.clickNext(evaluate);
  //     if (clickRes && clickRes !== 'not-found') clicked = true;
  //   }
  //   if (!clicked) {
  //     const fallbackSels = ['#identifierNext button', '#identifierNext', '#recaptchaNext button', '#recaptchaNext', 'button[type="submit"]'];
  //     for (const sel of fallbackSels) {
  //       try {
  //         const el = await page.$(sel);
  //         if (el) {
  //           await page.click(sel);
  //           clicked = true;
  //           break;
  //         }
  //       } catch (_) {}
  //     }
  //   }
  // }), recaptchaTimeoutMs);
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
  await page.waitForSelector(selector, { visible: true, timeout: options.timeoutMs });
  await typeField(page, selector, account.email, options);
  console.log('[login-trace] 9.x điền email = OK');
  await page.waitForSelector(next, { visible: true, timeout: options.timeoutMs });
  await clickAndWaitUrl(page, t('gmail.next', () => { assertAccounts(page); return page.click(next); }), options.timeoutMs);
});

const stepPassword = t('gmail.stepPassword', async (page, account, options) => {
  console.log('[login-trace] 10. Bước MẬT KHẨU: gõ mật khẩu -> Tiếp theo.');
  const selector = 'input[name="Passwd"]';
  const next = '#passwordNext';
  await page.waitForSelector(selector, { visible: true, timeout: options.timeoutMs });
  await typeField(page, selector, account.password, options);
  console.log('[login-trace] 10.x điền mật khẩu = OK');
  await page.waitForSelector(next, { visible: true, timeout: options.timeoutMs });
  await clickAndWaitUrl(page, t('gmail.next', () => { assertAccounts(page); return page.click(next); }), options.timeoutMs);
});

const stepRecovery = t('gmail.stepRecovery', async (page, account, options) => {
  console.log('[login-trace] 11. Bước EMAIL KHÔI PHỤC: điền email khôi phục -> Tiếp theo.');
  const selector = 'input[name="knowledgePreregisteredEmailResponse"]';
  const next = '#knowledgePreregisteredEmailNext';
  await page.waitForSelector(selector, { visible: true, timeout: options.timeoutMs });
  await typeField(page, selector, account.recoveryMail, options);
  console.log('[login-trace] 11.x điền email khôi phục = OK');
  await page.waitForSelector(next, { visible: true, timeout: options.timeoutMs });
  await clickAndWaitUrl(page, t('gmail.next', () => { assertAccounts(page); return page.click(next); }), options.timeoutMs);
});

const stepTotp = t('gmail.stepTotp', async (page, account, options) => {
  console.log('[login-trace] 11. Bước 2FA: sinh mã TOTP -> điền mã Authenticator -> Tiếp theo.');
  const selector = 'input[name="totpPin"]';
  const next = '#totpNext';
  await page.waitForSelector(selector, { visible: true, timeout: options.timeoutMs });
  await typeField(page, selector, totp(account.twofa), options);
  console.log('[login-trace] 11.x điền mã 2FA = OK');
  await page.waitForSelector(next, { visible: true, timeout: options.timeoutMs });
  await clickAndWaitUrl(page, t('gmail.next', () => { assertAccounts(page); return page.click(next); }), options.timeoutMs);
});

const stepSelection = t('gmail.stepSelection', async (page, account, options) => {
  console.log('[login-trace] 11. Bước CHỌN PHƯƠNG THỨC XÁC MINH (2FA hoặc Email khôi phục)...');
  const selector = account.twofa ? '[data-challengetype="6"]' : account.recoveryMail ? '[data-challengetype="12"]' : null;
  if (!selector) throw failure('missing_data', 'Chưa có dữ liệu cho phương thức xác minh.');
  await page.waitForSelector(selector, { visible: true, timeout: options.timeoutMs });
  await clickAndWaitUrl(page, t('gmail.selectChallenge', () => { assertAccounts(page); return page.click(selector); }), options.timeoutMs);
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
          const info = await page.evaluate(node => {
            node.scrollIntoView({ block: 'center', inline: 'center' });
            var r = node.getBoundingClientRect();
            return {
              tag: node.tagName,
              text: (node.innerText || node.textContent || '').trim(),
              cls: node.className,
              rect: { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height }
            };
          }, el);

          console.log(`[login-trace] 11.x Tìm thấy nút "Try another way": <${info.tag}> text="${info.text}" rect=(${Math.round(info.rect.x)}, ${Math.round(info.rect.y)})`);

          if (info.rect.width > 0 && info.rect.height > 0 && page.mouse && typeof page.mouse.click === 'function') {
            console.log(`[login-trace] 11.x Di chuyển chuột và click toạ độ (${Math.round(info.rect.x)}, ${Math.round(info.rect.y)})...`);
            await page.mouse.move(info.rect.x, info.rect.y);
            await new Promise(r => setTimeout(r, 100));
            await page.mouse.click(info.rect.x, info.rect.y, { delay: 100 });
          }

          try {
            await el.click();
          } catch (_) {}

          await page.evaluate(node => {
            try { node.click(); } catch(e){}
          }, el);

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
    console.log('[login-trace] 11.x Profile không có Security code -> Nhấn nút "Try another way"...');
    await clickAndWaitUrl(page, t('gmail.tryAnotherWay', async () => {
      assertAccounts(page);
      const clicked = await clickTryAnotherWay(page);
      if (!clicked) {
        throw failure('manual', 'Không tìm thấy nút "Try another way" trên trang.');
      }
    }), options.timeoutMs);
  }
});

const stepInbox = t('gmail.stepInbox', async (page, account, options) => {
  await page.waitForSelector('[role="main"]', { visible: true, timeout: options.timeoutMs });
  if (classify(page.url()) !== 'inbox') throw failure('manual', 'Cần kiểm tra trang Gmail thủ công.');
  const matchesAccount = await page.evaluate(email => {
    const wanted = email.toLowerCase();
    return [...document.querySelectorAll('[data-email], a[aria-label]')].some(node =>
      (node.getAttribute('data-email') || '').toLowerCase() === wanted ||
      (node.getAttribute('aria-label') || '').toLowerCase().includes(`(${wanted})`));
  }, account.email);
  if (!matchesAccount) throw failure('manual', 'Đã mở Gmail nhưng chưa xác nhận được đúng tài khoản của profile. Hãy kiểm tra thủ công.');
  console.log('[login-trace] 12. Đã vào hộp thư Gmail thành công!');
  return { status: 'success' };
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

const login = t('gmail.login', async (page, account, onStatus, input = {}) => {
  const options = { typingDelayMs: 90, timeoutMs: 30000, ...input };
  if (!Number.isInteger(options.typingDelayMs) || options.typingDelayMs < 1 || options.typingDelayMs > 1000) throw failure('config', 'Độ trễ gõ phải từ 1 đến 1000 ms.');
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120000) throw failure('config', 'Timeout đăng nhập không hợp lệ.');
  try {
    await onStatus('starting');
    await openLoginPage(page, options);
    for (let step = 0; step < 10; step++) {
      const state = classify(page.url());
      if (state === 'rejected') {
        await closeRejectedBrowser(page);
        throw failure('rejected', 'Google đã từ chối đăng nhập (signin/rejected).');
      }
      if (state === 'verify_phone') {
        await closeVerifyPhoneBrowser(page);
        throw failure('verify_phone', 'Google yêu cầu xác minh số điện thoại (verify phone).');
      }
      await onStatus(state);
      if (state === 'inbox') {
        const result = await stepInbox(page, account, options);
        await onStatus('success');
        console.log('[login-trace] 12. Flow login xong -> hoàn tất.');
        return result;
      }
      if (state === 'manual') throw failure('manual', 'Cần thao tác thủ công trên trình duyệt (CAPTCHA, chọn tài khoản hoặc xác minh khác).');
      if (state === 'selection') {
        await stepSelection(page, account, options);
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
          await closeWithoutPassword(page, options);
          await onStatus('password_reached');
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
      throw failure('unknown_state', 'Trạng thái đăng nhập không xác định.');
    }
    throw failure('step_limit', 'Quá số bước đăng nhập; cần kiểm tra thủ công.');
  } catch (error) {
    if (error.loginCode === 'url_unchanged' || error.name === 'TimeoutError') {
      await onStatus('error');
      try { await closeTimedOutBrowser(page); }
      catch { throw failure('timeout_close_failed', 'Hết thời gian chờ đăng nhập nhưng chưa đóng được trình duyệt.'); }
      throw failure('timeout', 'Hết thời gian chờ đăng nhập; đã đóng trình duyệt và nhường slot.');
    }
    if (error.loginCode) throw error;
    // Puppeteer exceptions may contain URLs or DOM values: never forward them.
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
  stepInbox,
};
