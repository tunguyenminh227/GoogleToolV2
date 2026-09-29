const trace = require('./trace-log');
const { totp, typeField, humanClick, clickAndWaitUrl, stepRecaptcha, stepPassword, stepTotp, classify } = require('./gmail-login');
const t = trace.traced;

const failure = t('passkey.failure', (code, message) => {
  const span = trace.traceIn(`passkey.error.${code}`);
  try { return Object.assign(new Error(message), { passkeyCode: code }); }
  finally { trace.traceOut(span, 'error'); }
});

const PASSKEY_URL = 'https://myaccount.google.com/signinoptions/passkeys';
const PASSKEY_CREATE_LABELS = [
  'create a passkey',
  '+ create a passkey',
  'tạo mã xác thực',
  '+ tạo mã xác thực',
  'tạo khóa truy cập',
  '+ tạo khóa truy cập',
  'tạo passkey',
  '+ tạo passkey',
];
const PASSKEY_CONTINUE_LABELS = ['continue', 'tiếp tục'];
const PASSKEY_DONE_LABELS = ['done', 'xong', 'hoàn tất'];

// Snippet JS từ V1: tìm phần tử khớp text và THỰC SỰ bấm được qua elementFromPoint
const clickableTextRectJs = (needles, preferBottom = false) => `(function(){
  var needles = ${JSON.stringify(needles)};
  var preferBottom = ${Boolean(preferBottom)};
  function norm(s){ return ((s || '')).replace(/[‘’ʼ]/g, "'").replace(/^\\+\\s*/, '').trim().toLowerCase(); }
  var nn = needles.map(norm);
  var all = Array.prototype.slice.call(
    document.querySelectorAll('button, a, [role=button], [role=link], [jsaction], [data-challengetype], div[role=button], span[role=button]'));
  var cands = [];
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var rawText = (el.innerText || el.textContent || '').trim();
    var t = norm(rawText);
    if (!t) continue;
    if (!nn.some(function(n){ return n && (t === n || t.indexOf(n) !== -1); })) continue;
    var r0 = el.getBoundingClientRect();
    if (r0.width <= 1 || r0.height <= 1) continue;
    if (preferBottom) {
      var banner = el.closest('c-wiz, section, [role="region"], div[jsaction]');
      var bannerText = banner ? (banner.innerText || banner.textContent || '').toLowerCase() : '';
      if (bannerText.indexOf('on this device') !== -1 || bannerText.indexOf('trên thiết bị này') !== -1 ||
          bannerText.indexOf('speed up your sign in') !== -1 || bannerText.indexOf('tăng tốc độ đăng nhập') !== -1) {
        continue;
      }
    }
    cands.push({ el: el, t: t, rawText: rawText, y: r0.top + window.scrollY, area: Math.max(1, r0.width) * Math.max(1, r0.height) });
  }
  cands.sort(function(a, b){
    if (preferBottom) {
      var aPlus = a.rawText.indexOf('+') !== -1;
      var bPlus = b.rawText.indexOf('+') !== -1;
      if (aPlus !== bPlus) return bPlus ? 1 : -1;
      return b.y - a.y;
    }
    if (a.t.length !== b.t.length) return a.t.length - b.t.length;
    return a.area - b.area;
  });
  for (var j = 0; j < cands.length; j++) {
    var el2 = cands[j].el;
    try { el2.scrollIntoView({ block: 'center', inline: 'center' }); } catch(e){}
    var r = el2.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) continue;
    var cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) continue;
    var top = document.elementFromPoint(cx, cy);
    if (!top) continue;
    if (top === el2 || el2.contains(top) || (top && top.contains && top.contains(el2))) {
      return { x: cx, y: cy };
    }
  }
  return null;
})()`;

// Snippet JS từ V1: fallback click bằng dispatch Pointer/Mouse/Click event đầy đủ
const clickOptionByTextJs = (needles, preferBottom = false) => `(function(){
  var needles = ${JSON.stringify(needles)};
  var preferBottom = ${Boolean(preferBottom)};
  function norm(s){ return ((s || '')).replace(/[‘’ʼ]/g, "'").replace(/^\\+\\s*/, '').trim().toLowerCase(); }
  var nn = needles.map(norm);
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
  var matches = [];
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (!vis(el)) continue;
    var rawText = (el.innerText || el.textContent || '').trim();
    var t = norm(rawText);
    if (!t) continue;
    if (nn.some(function(n){ return n && (t === n || t.indexOf(n) !== -1); })) {
      if (preferBottom) {
        var banner = el.closest('c-wiz, section, [role="region"], div[jsaction]');
        var bannerText = banner ? (banner.innerText || banner.textContent || '').toLowerCase() : '';
        if (bannerText.indexOf('on this device') !== -1 || bannerText.indexOf('trên thiết bị này') !== -1 ||
            bannerText.indexOf('speed up your sign in') !== -1 || bannerText.indexOf('tăng tốc độ đăng nhập') !== -1) {
          continue;
        }
      }
      var r0 = el.getBoundingClientRect();
      matches.push({ el: el, t: t, rawText: rawText, y: r0.top + window.scrollY });
    }
  }
  if (!matches.length) return 'no-match';
  matches.sort(function(a, b){
    if (preferBottom) {
      var aPlus = a.rawText.indexOf('+') !== -1;
      var bPlus = b.rawText.indexOf('+') !== -1;
      if (aPlus !== bPlus) return bPlus ? 1 : -1;
      return b.y - a.y;
    }
    return a.t.length - b.t.length;
  });
  var match = matches[0].el;
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
      if (ev) { try { el.dispatchEvent(ev); } catch(e){} }
    }
    try { el.click(); } catch(e){}
  }
  var target = match.closest('[jsaction], li, [role=link], [role=button], a, button, [data-challengetype]') || match;
  fire(match);
  if (target !== match) fire(target);
  return 'clicked:' + norm(target.innerText || target.textContent).slice(0, 40);
})()`;

// Thao tác click tọa độ thật bằng CDP Input.dispatchMouseEvent (như V1) hoặc Puppeteer mouse
const fclickAt = t('passkey.clickAt', async (page, client, x, y) => {
  if (client && typeof client.send === 'function') {
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await new Promise(r => setTimeout(r, 60));
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 60));
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    return true;
  }
  if (page && page.mouse && typeof page.mouse.click === 'function') {
    await page.mouse.click(x, y);
    return true;
  }
  return false;
});

// Click nhãn theo luồng V1: thử clickableTextRectJs + fclickAt trước, sau đó clickOptionByTextJs
const fClickLabel = t('passkey.fClickLabel', async (page, client, labels, tries = 8, scrollBottom = false, timeoutMs = 30000, preferBottom = false) => {
  const shortWait = timeoutMs <= 500;
  for (let i = 0; i < tries; i++) {
    if ((scrollBottom || (preferBottom && i >= 1) || i >= 2) && typeof page.evaluate === 'function') {
      try {
        await page.evaluate(() => {
          if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
            window.scrollTo(0, document.body.scrollHeight);
          }
        });
      } catch (_) {}
      await new Promise(r => setTimeout(r, shortWait ? 50 : 300));
    }

    if (typeof page.evaluate === 'function') {
      try {
        const r = await page.evaluate(clickableTextRectJs(labels, preferBottom));
        if (r === true) return true;
        if (r && typeof r.x === 'number') {
          await fclickAt(page, client, r.x, r.y);
          return true;
        }
      } catch (_) {}

      try {
        const res = await page.evaluate(clickOptionByTextJs(labels, preferBottom));
        if (res === true || (typeof res === 'string' && res.indexOf('clicked') === 0)) {
          return true;
        }
      } catch (_) {}
    }

    if (typeof page.evaluateHandle === 'function') {
      try {
        const handle = await page.evaluateHandle((targetLabels, preferBot) => {
          if (typeof document === 'undefined') return null;
          const cleanTargets = targetLabels.map(l => l.toLowerCase().replace(/^\+\s*/, '').trim());
          const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, div[role="button"], span'));
          const matches = [];
          for (let k = 0; k < candidates.length; k++) {
            const el = candidates[k];
            if (el.offsetParent === null && el.getClientRects().length === 0) continue;
            const raw = el.innerText || el.textContent || '';
            const text = raw.toLowerCase().replace(/[\s\n\r\t]+/g, ' ').trim();
            const cleanText = text.replace(/^\+\s*/, '').trim();
            for (let j = 0; j < cleanTargets.length; j++) {
              if (cleanText === cleanTargets[j] || (cleanText.includes(cleanTargets[j]) && cleanText.length < 80)) {
                if (preferBot) {
                  const card = el.closest('c-wiz, section, [role="region"], div[jsaction]');
                  const cardText = card ? (card.innerText || card.textContent || '').toLowerCase() : '';
                  if (cardText.includes('on this device') || cardText.includes('trên thiết bị này') ||
                      cardText.includes('speed up your sign in') || cardText.includes('tăng tốc độ đăng nhập')) {
                    break;
                  }
                }
                const btn = el.closest('button, [role="button"], a') || el;
                const r = btn.getBoundingClientRect();
                matches.push({ el: btn, raw, y: r.top + window.scrollY });
                break;
              }
            }
          }
          if (!matches.length) return null;
          matches.sort((a, b) => {
            if (preferBot) {
              const aPlus = a.raw.includes('+');
              const bPlus = b.raw.includes('+');
              if (aPlus !== bPlus) return bPlus ? 1 : -1;
              return b.y - a.y;
            }
            return 0;
          });
          return matches[0].el;
        }, labels, preferBottom);
        const el = handle && handle.asElement ? handle.asElement() : null;
        if (el) {
          const clicked = await humanClick(page, el, timeoutMs);
          if (clicked) return true;
        }
      } catch (_) {}
    }

    if (shortWait) break;
    await new Promise(r => setTimeout(r, 1200));
  }
  return false;
});

// Chuyên dụng tìm và bấm nút "+ Create a passkey" ở ĐÁY trang
// Tuyệt đối loại bỏ banner trên ("Create a passkey on this device")
const clickBottomPasskeyButton = t('passkey.clickBottomButton', async (page, client, timeoutMs = 30000) => {
  const shortWait = timeoutMs <= 500;
  const maxAttempts = shortWait ? 2 : 8;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // 1. Dọn dẹp nếu có dialog lỗi "Something went wrong" đang hiện
    if (typeof page.evaluate === 'function') {
      try {
        await page.evaluate(() => {
          const dialog = document.querySelector('[role="dialog"], dialog, div[aria-modal="true"]');
          if (dialog) {
            const txt = (dialog.innerText || dialog.textContent || '').toLowerCase();
            if (txt.includes('went wrong') || txt.includes('save your changes') || txt.includes('không thể lưu')) {
              const closeBtn = Array.from(dialog.querySelectorAll('button, [role="button"]')).find(b => {
                const t = (b.innerText || b.textContent || '').toLowerCase().trim();
                return t === 'close' || t === 'đóng' || t.includes('close') || t.includes('đóng');
              });
              if (closeBtn) closeBtn.click();
            }
          }
        });
      } catch (_) {}
    }

    // 2. Cuộn trang xuống đáy
    if (typeof page.evaluate === 'function') {
      try {
        await page.evaluate(() => {
          if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
            window.scrollTo(0, document.body.scrollHeight);
          }
        });
      } catch (_) {}
    }
    await new Promise(r => setTimeout(r, shortWait ? 50 : 500));

    // 3. Tìm và click nút ở dưới cùng (loại bỏ hoàn toàn banner trên)
    if (typeof page.evaluate === 'function') {
      try {
        const found = await page.evaluate(() => {
          const needles = ['create a passkey', 'tạo mã xác thực', 'tạo khóa truy cập', 'tạo passkey'];
          const elements = Array.from(document.querySelectorAll('button, [role="button"], a, input[type="button"], div[role="button"]'));
          const matches = [];

          for (let i = 0; i < elements.length; i++) {
            const el = elements[i];
            if (el.offsetParent === null && el.getClientRects().length === 0) continue;
            const r0 = el.getBoundingClientRect();
            if (r0.width <= 1 || r0.height <= 1) continue;

            // Bỏ qua nếu nằm trong modal/dialog
            if (el.closest('[role="dialog"], dialog, [aria-modal="true"]')) continue;

            // LOẠI TRỪ HOÀN TOÀN banner "on this device" / "trên thiết bị này"
            const parentSection = el.closest('c-wiz, section, [role="region"], div[jsaction]');
            const sectionText = parentSection ? (parentSection.innerText || parentSection.textContent || '').toLowerCase() : '';
            if (sectionText.includes('on this device') || sectionText.includes('trên thiết bị này') ||
                sectionText.includes('speed up your sign in') || sectionText.includes('tăng tốc độ đăng nhập')) {
              continue;
            }

            const raw = (el.innerText || el.textContent || '').toLowerCase().replace(/[\s\n\r\t]+/g, ' ').trim();
            const clean = raw.replace(/^\+\s*/, '').trim();

            const isMatch = needles.some(n => (clean === n || clean.includes(n)) && clean.length < 40);
            if (isMatch) {
              const hasPlus = raw.includes('+') || Boolean(el.querySelector('svg, i, .google-symbols, .material-icons'));
              matches.push({
                el,
                hasPlus,
                raw,
                y: r0.top + window.scrollY,
              });
            }
          }

          if (!matches.length) return null;

          // Sắp xếp: Ưu tiên có dấu +, và Y lớn nhất (ở dưới đáy trang)
          matches.sort((a, b) => {
            if (a.hasPlus !== b.hasPlus) return b.hasPlus ? 1 : -1;
            return b.y - a.y;
          });

          const target = matches[0].el;
          try { target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (_) {}
          const rect = target.getBoundingClientRect();
          const cx = Math.round(rect.left + rect.width / 2);
          const cy = Math.round(rect.top + rect.height / 2);

          return { x: cx, y: cy };
        });

        if (found && typeof found.x === 'number') {
          console.log(`[passkey-trace] 🎯 Đã tìm thấy nút tạo Passkey ở dưới tại (${found.x}, ${found.y}), đang click chuột...`);
          await fclickAt(page, client, found.x, found.y);
          await new Promise(r => setTimeout(r, shortWait ? 50 : 500));
          return true;
        }
      } catch (_) {}
    }

    if (shortWait) break;
    await new Promise(r => setTimeout(r, 1000));
  }

  return false;
});

// Chuyên dụng bấm nút xác nhận "Create a passkey" TRÊN MODAL "Create a passkey for your Google Account"
const clickModalPasskeyButton = t('passkey.clickModalButton', async (page, client, timeoutMs = 30000) => {
  const shortWait = timeoutMs <= 500;
  const maxAttempts = shortWait ? 2 : 25;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (typeof page.evaluate === 'function') {
      try {
        const res = await page.evaluate(() => {
          // 1. Kiểm tra dialog lỗi "Something went wrong" -> bấm Close nếu có
          const errorDialog = Array.from(document.querySelectorAll('[role="dialog"], dialog, [aria-modal="true"]')).find(d => {
            const txt = (d.innerText || d.textContent || '').toLowerCase();
            return txt.includes('went wrong') || txt.includes('save your changes') || txt.includes('không thể lưu');
          });
          if (errorDialog) {
            const closeBtn = Array.from(errorDialog.querySelectorAll('button, [role="button"]')).find(b => {
              const t = (b.innerText || b.textContent || '').toLowerCase().trim();
              return t === 'close' || t === 'đóng' || t.includes('close') || t.includes('đóng');
            });
            if (closeBtn) {
              closeBtn.click();
              return { state: 'error_closed' };
            }
          }

          // 2. Tìm container của Passkey Modal
          // Modal có role="dialog", [aria-modal="true"], dialog, hoặc container có tiêu đề "Create a passkey for your Google Account"
          let modalContainer = null;
          const dialogs = Array.from(document.querySelectorAll('[role="dialog"], dialog, [aria-modal="true"], .modal'));
          for (let i = 0; i < dialogs.length; i++) {
            const d = dialogs[i];
            if (d.offsetParent !== null || d.getClientRects().length > 0) {
              const txt = (d.innerText || d.textContent || '').toLowerCase();
              if (txt.includes('passkey') || txt.includes('khóa truy cập') || txt.includes('mã xác thực') ||
                  txt.includes('cancel') || txt.includes('hủy') || txt.includes('another device')) {
                modalContainer = d;
                break;
              }
            }
          }

          // Nếu chưa tìm thấy modalContainer theo role, tìm container chứa tiêu đề hoặc các nút của modal
          if (!modalContainer) {
            const allElements = Array.from(document.querySelectorAll('div, section, aside'));
            for (let i = 0; i < allElements.length; i++) {
              const el = allElements[i];
              if (el.offsetParent === null && el.getClientRects().length === 0) continue;
              const txt = (el.innerText || el.textContent || '').toLowerCase();
              if ((txt.includes('create a passkey for your google account') ||
                   txt.includes('tạo khóa truy cập cho tài khoản google') ||
                   txt.includes('tạo mã xác thực cho tài khoản google')) &&
                  (txt.includes('cancel') || txt.includes('hủy') || txt.includes('another device') || txt.includes('thiết bị khác'))) {
                modalContainer = el;
                break;
              }
            }
          }

          // 3. Tìm nút "Create a passkey" trên modal (loại trừ Cancel / Use another device / Close / Learn more)
          const excludeWords = ['cancel', 'hủy', 'use another device', 'sử dụng thiết bị khác', 'close', 'đóng', 'learn more', 'tìm hiểu thêm'];
          const targetWords = ['create a passkey', 'tạo mã xác thực', 'tạo khóa truy cập', 'tạo passkey', 'continue', 'tiếp tục'];

          const searchRoot = modalContainer || document;
          // CHỈ tìm button hoặc [role="button"], TUYỆT ĐỐI KHÔNG tìm <a> hoặc <div> để tránh dính link và đoạn văn
          const allButtons = Array.from(searchRoot.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]'));
          const candidates = [];

          for (let i = 0; i < allButtons.length; i++) {
            const btn = allButtons[i];
            if (btn.offsetParent === null && btn.getClientRects().length === 0) continue;
            const rect = btn.getBoundingClientRect();
            if (rect.width <= 1 || rect.height <= 1) continue;

            const text = (btn.innerText || btn.textContent || '').toLowerCase().replace(/[\s\n\r\t]+/g, ' ').trim();
            if (!text) continue;

            // BẮT BUỘC độ dài text <= 30 ký tự để loại bỏ hoàn toàn các khối văn bản / đoạn giải thích
            if (text.length > 30) continue;

            const isExcluded = excludeWords.some(w => text === w || text.startsWith(w));
            if (isExcluded) continue;

            const isTarget = targetWords.some(w => text === w || text.includes(w));
            if (!isTarget) continue;

            // Kiểm tra chắc chắn nút thuộc modal
            if (!modalContainer) {
              const parent = btn.parentElement?.parentElement?.parentElement || btn.parentElement?.parentElement || btn.parentElement;
              const parentText = parent ? (parent.innerText || parent.textContent || '').toLowerCase() : '';
              const isModalChild = parentText.includes('cancel') || parentText.includes('hủy') ||
                                  parentText.includes('another device') || parentText.includes('thiết bị khác') ||
                                  parentText.includes('for your google account') || parentText.includes('cho tài khoản google');
              if (!isModalChild) continue;
            }

            candidates.push({ btn, text, rect });
          }

          if (!candidates.length) return { state: 'waiting' };

          // Ưu tiên khớp chính xác 'create a passkey', hoặc text ngắn nhất
          candidates.sort((a, b) => {
            const aExact = a.text === 'create a passkey' || a.text === 'tạo khóa truy cập' || a.text === 'tạo mã xác thực';
            const bExact = b.text === 'create a passkey' || b.text === 'tạo khóa truy cập' || b.text === 'tạo mã xác thực';
            if (aExact !== bExact) return aExact ? -1 : 1;
            return a.text.length - b.text.length;
          });

          // Nút đích: nút màu xanh trên popup
          const target = candidates[0].btn.closest('button, [role="button"]') || candidates[0].btn;
          try { target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (_) {}
          const targetRect = target.getBoundingClientRect();
          const cx = Math.round(targetRect.left + targetRect.width / 2);
          const cy = Math.round(targetRect.top + targetRect.height / 2);

          return { state: 'found', x: cx, y: cy, buttonText: candidates[0].text };
        });

        if (res && res.state === 'found' && typeof res.x === 'number') {
          console.log(`[passkey-trace] 🎯 Đã tìm thấy nút "${res.buttonText || 'Create a passkey'}" trên modal tại (${res.x}, ${res.y}), đang click chuột 1 lần...`);
          const clicked = await fclickAt(page, client, res.x, res.y);
          if (!clicked && typeof page.evaluate === 'function') {
            await page.evaluate(() => {
              const btn = document.querySelector('[role="dialog"] button, dialog button');
              if (btn) btn.click();
            }).catch(() => {});
          }
          await new Promise(r => setTimeout(r, shortWait ? 50 : 500));
          return { success: true };
        }

        if (res && res.state === 'error_closed') {
          console.warn('[passkey-trace] ⚠️ Đã đóng dialog lỗi "Something went wrong"');
          return { errorClosed: true };
        }
      } catch (_) {}
    }

    if (shortWait) break;
    await new Promise(r => setTimeout(r, 500));
  }

  return { success: false };
});

const clickLabelRobust = t('passkey.clickLabel', async (page, labels, tries = 8, scrollBottom = false, timeoutMs = 30000) => {
  return fClickLabel(page, null, labels, tries, scrollBottom, timeoutMs, false);
});

const passReauthChallenge = t('passkey.passReauth', async (page, account, options) => {
  const currentUrl = page.url();
  const state = typeof classify === 'function' ? classify(currentUrl) : '';

  // 1) Re-auth mật khẩu (/signin/challenge/pwd)
  if (state === 'password' || currentUrl.includes('/signin/challenge/pwd') || currentUrl.includes('/challenge/password')) {
    console.log('[passkey-trace] Phát hiện yêu cầu xác minh lại mật khẩu (challenge/pwd)...');
    if (!account.password) {
      throw failure('missing_password', 'Tài khoản yêu cầu xác minh mật khẩu nhưng profile chưa có mật khẩu.');
    }
    if (typeof options.onStatus === 'function') await options.onStatus('password', 'Đang điền mật khẩu...');
    await stepPassword(page, account, options);
    console.log('[passkey-trace] Điền mật khẩu xác minh = OK');
    return true;
  }

  // 2) Re-auth 2FA Authenticator (/challenge/totp)
  if (state === 'totp' || currentUrl.includes('/challenge/totp')) {
    console.log('[passkey-trace] Phát hiện yêu cầu xác minh lại 2FA (challenge/totp)...');
    if (!account.twofa) {
      throw failure('missing_totp', 'Tài khoản yêu cầu mã 2FA nhưng profile chưa có khóa Authenticator.');
    }
    if (typeof options.onStatus === 'function') await options.onStatus('totp', 'Đang điền mã 2FA...');
    await stepTotp(page, account, options);
    console.log('[passkey-trace] Điền mã 2FA xác minh = OK');
    return true;
  }

  // 3) Re-auth Passkey (/challenge/pk)
  if (state === 'passkey' || currentUrl.includes('/challenge/pk')) {
    console.log('[passkey-trace] Phát hiện yêu cầu xác minh lại Passkey (challenge/pk)... Tự động bấm Continue.');
    if (typeof options.onStatus === 'function') await options.onStatus('passkey', 'Đang xác minh Passkey...');
    await clickAndWaitUrl(page, t('passkey.nextPasskeyContinue', async () => {
      const clicked = await clickLabelRobust(page, PASSKEY_CONTINUE_LABELS, 8, false, options.timeoutMs);
      if (!clicked) {
        throw failure('continue_not_found', 'Không tìm thấy nút Continue trên trang xác minh Passkey.');
      }
    }), options.timeoutMs);
    return true;
  }

  // 4) Xác minh reCAPTCHA (/challenge/recaptcha hoặc có iframe captcha trên màn hình)
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

  // Dùng vòng lặp theo số bước (mỗi bước có timeout riêng), tránh bị hết hạn timer tổng khi giải captcha lâu
  for (let step = 0; step < 15; step++) {
    const url = page.url();
    // Đã tới trang quản lý passkeys và không còn ở màn challenge
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
        await new Promise(r => setTimeout(r, 1200));
        continue;
      }

      console.log('[passkey-trace] 1.x Đã tới trang quản lý Passkey thành công.');
      await new Promise(r => setTimeout(r, 1200));
      return true;
    }

    // Nếu rơi vào trang đăng nhập chính (chưa login)
    if (url.includes('/signin/identifier') || url.includes('/ServiceLogin')) {
      throw failure('not_logged_in', 'Tài khoản chưa đăng nhập Gmail. Vui lòng thực hiện Login gmail trước khi bật Passkey.');
    }

    // Xử lý chuyển hướng trung gian CheckCookie
    if (/CheckCookie/i.test(url)) {
      console.log('[passkey-trace] ⏳ Đang chuyển hướng (CheckCookie)...');
      const waitStart = Date.now();
      while (Date.now() - waitStart < 8000) {
        await new Promise(r => setTimeout(r, 300));
        if (!/CheckCookie/i.test(page.url())) break;
      }
      continue;
    }

    // Nếu bị hỏi re-auth mật khẩu hoặc 2FA hoặc captcha hoặc passkey
    if (url.includes('/challenge/') || (typeof classify === 'function' && classify(url) === 'recaptcha')) {
      const handled = await passReauthChallenge(page, account, opts);
      if (handled) {
        await new Promise(r => setTimeout(r, 1200));
        continue;
      }
    }

    // Kiểm tra thêm nếu trên trang xuất hiện captcha iframe dù url chưa đổi
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
      await new Promise(r => setTimeout(r, 1200));
      continue;
    }

    // Chờ 1 giây xem trang có tự chuyển tiếp hoặc tải thêm không
    await new Promise(r => setTimeout(r, 1000));
  }

  throw failure('timeout', 'Hết thời gian chờ hoặc quá số bước điều hướng tới trang Passkey.');
});

const enablePasskey = t('passkey.enable', async (browser, account, onStatus, input = {}) => {
  const options = { typingDelayMs: 90, timeoutMs: 30000, ...input };

  // 0) Kiểm tra nếu profile đã có passkey lưu sẵn
  if (account.passkey && account.passkey.trim()) {
    console.log('[passkey-trace] 0. Profile đã có Passkey lưu sẵn -> Hoàn tất sớm.');
    await onStatus('passkey_enabled', 'Đã có Passkey');
    return { status: 'already_enabled', passkeyBlob: account.passkey.trim() };
  }

  await onStatus('starting', 'Đang kết nối...');
  const page = (await browser.pages())[0] || await browser.newPage();

  // 1) Vào trang quản lý Passkey trên tab chính và vượt re-auth / captcha nếu cần
  await gotoSecurePasskeyPage(page, account, { ...options, onStatus }, onStatus);

  // Copy URL Passkey từ tab hiện tại sau khi đã vào thành công
  const currentPasskeyUrl = (typeof page.url === 'function' ? page.url() : '') || PASSKEY_URL;
  console.log(`[passkey-trace] 1.y Đã tới trang Passkey. Sao chép URL để mở trên tab mới: ${currentPasskeyUrl}`);

  await onStatus('passkey_creating', 'Đang tạo Passkey ảo...');
  console.log('[passkey-trace] 2. Mở tab mới sạch để đăng ký Virtual Authenticator (gắn CDP)...');

  // 2) Mở tab mới sạch để đăng ký Virtual Authenticator và thực hiện ceremony
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
      console.log(`[passkey-trace] 2.x Virtual Authenticator đã tạo: id=${authenticatorId}`);
    }

    if (!authenticatorId && typeof freshPage.addVirtualAuthenticator === 'function') {
      // Dành cho unit test / mock
      const mockAuth = await freshPage.addVirtualAuthenticator();
      authenticatorId = mockAuth && mockAuth.id;
    }

    console.log(`[passkey-trace] 3. Điều hướng tab mới (gắn CDP) tới URL Passkey đã copy: ${currentPasskeyUrl}...`);
    await freshPage.goto(currentPasskeyUrl, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });

    // Đợi trang load xong hoàn toàn (document.readyState === 'complete' như V1)
    console.log('[passkey-trace] 3.x Đợi trang Passkey trên tab mới load xong hoàn toàn...');
    let loaded = false;
    const maxReadyChecks = options.timeoutMs <= 500 ? 2 : 30;
    const readyInterval = options.timeoutMs <= 500 ? 50 : 500;
    for (let i = 0; i < maxReadyChecks && !loaded; i++) {
      await new Promise(r => setTimeout(r, readyInterval));
      try {
        const ready = await freshPage.evaluate(() => typeof document !== 'undefined' ? document.readyState : 'complete');
        if (ready === 'complete') loaded = true;
      } catch (_) {}
    }
    await new Promise(r => setTimeout(r, options.timeoutMs <= 500 ? 50 : 1500));

    // Kiểm tra nếu freshPage cũng bị hỏi challenge hoặc captcha
    if (freshPage.url().includes('/challenge/') || (typeof classify === 'function' && classify(freshPage.url()) === 'recaptcha')) {
      console.log('[passkey-trace] 3.y Phát hiện challenge trên tab mới -> Xử lý challenge/captcha...');
      await passReauthChallenge(freshPage, account, { ...options, onStatus });
      await new Promise(r => setTimeout(r, 1500));
    }

    console.log('[passkey-trace] 4. Đợi trang load xong, nhấn nút "+ Create a passkey" ở DƯỚI (bỏ qua banner trên)...');
    await new Promise(r => setTimeout(r, options.timeoutMs <= 500 ? 50 : 500));
    let bottomClicked = await clickBottomPasskeyButton(freshPage, client, options.timeoutMs);
    if (!bottomClicked) {
      console.log('[passkey-trace] Thử fallback fClickLabel với preferBottom = true...');
      await new Promise(r => setTimeout(r, options.timeoutMs <= 500 ? 50 : 500));
      bottomClicked = await fClickLabel(freshPage, client, PASSKEY_CREATE_LABELS, 4, true, options.timeoutMs, true);
    }
    if (!bottomClicked) {
      throw failure('create_not_found', 'Không tìm thấy nút tạo Passkey ở dưới trên trang Google.');
    }

    // Delay 500ms sau khi bấm nút dưới để modal hiển thị và render hoàn chỉnh
    await new Promise(r => setTimeout(r, options.timeoutMs <= 500 ? 50 : 500));

    // Sau khi nhấn "+ Create a passkey" ở dưới, Google mở modal "Create a passkey for your Google Account" (Image 2)
    console.log('[passkey-trace] 4.1 Đang chờ modal "Create a passkey for your Google Account" và nhấn nút xanh trên modal...');
    const modalResult = await clickModalPasskeyButton(freshPage, client, options.timeoutMs);
    if (!modalResult || !modalResult.success) {
      console.warn('[passkey-trace] Không bấm được nút trên modal hoặc modal không xuất hiện.');
    }

    // Bước 4.3: Chờ 2.5s để ceremony WebAuthn tự động hoàn tất nhờ automaticPresenceSimulation và Google lưu passkey
    console.log('[passkey-trace] 4.3 Chờ WebAuthn ceremony tự hoàn tất và lưu passkey (2.5s)...');
    await new Promise(r => setTimeout(r, options.timeoutMs <= 500 ? 50 : 2500));

    // Bước 5: Bấm nút Hoàn tất / Xong (Done) hoặc Tiếp tục (Continue) trên popup thành công
    console.log('[passkey-trace] 5. Bấm nút xác nhận Hoàn tất / Xong...');
    await new Promise(r => setTimeout(r, options.timeoutMs <= 500 ? 20 : 500));
    await fClickLabel(freshPage, client, PASSKEY_DONE_LABELS, 4, false, options.timeoutMs, false);
    await new Promise(r => setTimeout(r, options.timeoutMs <= 500 ? 20 : 500));
    await fClickLabel(freshPage, client, PASSKEY_CONTINUE_LABELS, 4, false, options.timeoutMs, false);
    await new Promise(r => setTimeout(r, options.timeoutMs <= 500 ? 20 : 500));

    // Lấy credential vừa tạo (như V1: dò tối đa 8 lần với delay 1s)
    console.log('[passkey-trace] 6. Đọc credential Passkey vừa tạo qua CDP...');
    let creds = [];
    if (client && authenticatorId) {
      const maxAttempts = options.timeoutMs <= 500 ? 2 : 8;
      const retryDelay = options.timeoutMs <= 500 ? 10 : 1000;
      for (let attempt = 0; attempt < maxAttempts && !creds.length; attempt++) {
        console.log(`[passkey-trace] 6.x Dò credential trên tab mới, lần ${attempt + 1}/${maxAttempts}...`);
        const cr = await client.send('WebAuthn.getCredentials', { authenticatorId });
        creds = (cr && cr.result && cr.result.credentials) || (cr && cr.credentials) || [];
        if (!creds.length) await new Promise(r => setTimeout(r, retryDelay));
      }
    } else if (typeof freshPage.getCredentials === 'function') {
      creds = await freshPage.getCredentials();
    }

    if (!creds.length) {
      throw failure('no_credentials', 'Không lấy được credential Passkey từ authenticator ảo.');
    }

    const cred = creds[creds.length - 1];
    const passkeyBlob = Buffer.from(JSON.stringify(cred)).toString('base64');
    console.log('[passkey-trace] 7. Tạo Passkey THÀNH CÔNG!');

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
