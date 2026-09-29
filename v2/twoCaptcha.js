/**
 * twoCaptcha.js - Module giải và tự động bypass Captcha qua dịch vụ 2Captcha
 * Hỗ trợ Node.js 18+ / Electron (sử dụng native fetch, không cần cài thêm thư viện phụ)
 */

const DEFAULT_API_KEY = process.env.TWO_CAPTCHA_API_KEY || 'b5840eb6f75d59207b66669269a51981';

// JS Script nhận diện Captcha trên trang web (dùng cho page.evaluate hoặc CDP evaluate)
const CHECK_CAPTCHA_JS = `(function(){
  var iframe = document.querySelector('iframe[src*="recaptcha"], iframe[title*="reCAPTCHA" i]');
  var hasRecaptcha = !!(iframe || document.querySelector('.g-recaptcha'));
  var imgCaptchaEl = document.querySelector('#captchaimg, img[src*="Captcha" i]');
  var hasImgCaptcha = !!(imgCaptchaEl && (imgCaptchaEl.offsetWidth > 0 || imgCaptchaEl.offsetHeight > 0 || (imgCaptchaEl.getClientRects && imgCaptchaEl.getClientRects().length > 0)));
  var text = ((document.body && document.body.innerText) || '').toLowerCase();
  var hasCaptchaText = text.indexOf('không phải là rô-bốt') !== -1 ||
                       text.indexOf('not a robot') !== -1 ||
                       text.indexOf('recaptcha') !== -1 ||
                       text.indexOf('xác nhận bạn không phải là rô-bốt') !== -1 ||
                       text.indexOf('confirm you’re not a robot') !== -1 ||
                       text.indexOf('confirm you\\'re not a robot') !== -1;
  var isCaptchaUrl = location.href.indexOf('challenge/recaptcha') !== -1 || location.href.indexOf('challenge/kav') !== -1;
  if (hasRecaptcha || hasImgCaptcha || (isCaptchaUrl && hasCaptchaText) || (hasCaptchaText && hasRecaptcha)) {
    var sitekey = '';
    var isInvisible = false;
    var dataS = '';

    // 1. Kiểm tra qua iframe recaptcha
    if (iframe && iframe.src) {
      try {
        var u = new URL(iframe.src);
        sitekey = u.searchParams.get('k') || '';
        if (u.searchParams.get('size') === 'invisible') {
          isInvisible = true;
        }
        dataS = u.searchParams.get('s') || '';
      } catch(e){}
    }

    // 2. Kiểm tra qua phần tử DOM g-recaptcha hoặc [data-sitekey]
    var el = document.querySelector('.g-recaptcha, [data-sitekey]');
    if (el) {
      if (!sitekey) sitekey = el.getAttribute('data-sitekey') || '';
      if (el.getAttribute('data-size') === 'invisible') {
        isInvisible = true;
      }
      if (!dataS) dataS = el.getAttribute('data-s') || '';
    }

    // 3. Phân biệt rõ ràng giữa Checkbox v2 và Invisible v2
    var hasAnchor = !!document.querySelector('iframe[src*="recaptcha/api2/anchor"], iframe[title*="reCAPTCHA" i]');
    if (hasAnchor) {
      isInvisible = false;
    } else if (!isInvisible && document.querySelector('.grecaptcha-badge')) {
      isInvisible = true;
    }

    return {
      detected: true,
      type: hasRecaptcha ? (isInvisible ? 'reCAPTCHA v2 (invisible)' : 'reCAPTCHA v2 (checkbox/iframe)') : (hasImgCaptcha ? 'Ảnh Captcha (captchaimg)' : 'Màn hình xác minh Bot'),
      sitekey: sitekey || '',
      siteKey: sitekey || '',
      invisible: isInvisible,
      dataS: dataS || '',
      pageUrl: location.href || '',
      userAgent: (typeof navigator !== 'undefined' && navigator.userAgent) || ''
    };
  }
  return { detected: false, invisible: false };
})()`;

// JS Script tìm toạ độ ô vuông checkbox reCAPTCHA "Tôi không phải là người máy"
const CHECKBOX_COORD_JS = `(function() {
  var iframe = document.querySelector('iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha"], iframe[title*="reCAPTCHA" i]');
  if (!iframe || iframe.offsetParent === null) return null;
  var r = iframe.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  return { x: r.left + 28, y: r.top + (r.height / 2) };
})()`;

// JS Script kiểm tra trạng thái chi tiết của ô reCAPTCHA checkbox (loading -> check)
const GET_CHECKBOX_STATE_JS = `(function() {
  // Trạng thái trả về: 'checked' | 'loading' | 'unchecked' | 'unknown'

  // 1. Quét các iframe reCAPTCHA (ưu tiên iframe anchor của checkbox)
  var iframes = document.querySelectorAll('iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha"], iframe[title*="reCAPTCHA" i]');
  for (var i = 0; i < iframes.length; i++) {
    try {
      var iframe = iframes[i];
      var doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
      if (doc) {
        var anchor = doc.querySelector('#recaptcha-anchor') || doc.querySelector('.recaptcha-checkbox');
        if (anchor) {
          var ariaChecked = anchor.getAttribute('aria-checked');
          var cls = (anchor.className || '').toLowerCase();

          // A. Icon "Check" (tích xanh thành công)
          if (ariaChecked === 'true' || cls.indexOf('recaptcha-checkbox-checked') !== -1) {
            return 'checked';
          }

          // Kiểm tra icon checkmark hiển thị
          var checkmark = doc.querySelector('.recaptcha-checkbox-checkmark');
          if (checkmark && (checkmark.offsetWidth > 0 || checkmark.offsetHeight > 0)) {
            var st = window.getComputedStyle ? window.getComputedStyle(checkmark) : null;
            if (st && st.display !== 'none' && st.visibility !== 'hidden' && parseFloat(st.opacity || '1') > 0) {
              return 'checked';
            }
          }

          // Kiểm tra text trạng thái ẩn cho screen reader (Google luôn cập nhật thẻ này)
          var statusEl = doc.querySelector('#recaptcha-accessible-status, .rc-anchor-aria-status');
          var statusText = (statusEl ? (statusEl.innerText || statusEl.textContent || '') : '').toLowerCase();
          if (statusText.indexOf('verified') !== -1 || statusText.indexOf('đã được xác minh') !== -1 || statusText.indexOf('bạn đã xác minh') !== -1) {
            return 'checked';
          }

          // B. Icon Loading (spinner đang quay / đang xác minh)
          var spinner = doc.querySelector('.recaptcha-checkbox-spinner');
          var isSpinning = cls.indexOf('recaptcha-checkbox-clear') !== -1 ||
                           cls.indexOf('spinner') !== -1 ||
                           cls.indexOf('loading') !== -1 ||
                           anchor.getAttribute('aria-disabled') === 'true' ||
                           (statusText.indexOf('progress') !== -1 || statusText.indexOf('tiến hành') !== -1 || statusText.indexOf('verifying') !== -1 || statusText.indexOf('checking') !== -1);

          if (!isSpinning && spinner) {
            var spStyle = window.getComputedStyle ? window.getComputedStyle(spinner) : null;
            if (spStyle && spStyle.display !== 'none' && spStyle.visibility !== 'hidden' && parseFloat(spStyle.opacity || '1') > 0) {
              if (cls.indexOf('unchecked') === -1 || anchor.getAttribute('aria-disabled') === 'true') {
                isSpinning = true;
              }
            }
          }

          if (isSpinning) {
            return 'loading';
          }

          return 'unchecked';
        }
      }
    } catch(e) {
      // Bị chặn cross-origin -> dùng fallback bên dưới
    }
  }

  // 2. Fallback kiểm tra trạng thái xác minh trên trang chính
  // A. Kiểm tra window.grecaptcha.getResponse() - chỉ có giá trị khi Google đã xác minh xong (hiện icon Check)
  try {
    if (window.grecaptcha && typeof window.grecaptcha.getResponse === 'function') {
      var r = window.grecaptcha.getResponse();
      if (r && r.length > 0) {
        return 'checked';
      }
    }
  } catch(e) {}

  // 3. Nếu chưa verified, kiểm tra xem có bảng chọn ảnh (bframe / challenge) đang mở không
  var bframe = document.querySelector('iframe[src*="recaptcha/api2/bframe"], iframe[title*="challenge" i]');
  if (bframe && bframe.offsetParent !== null) {
    var bStyle = window.getComputedStyle ? window.getComputedStyle(bframe) : null;
    if (bStyle && bStyle.display !== 'none' && bStyle.visibility !== 'hidden' && parseFloat(bStyle.opacity || '1') > 0 && bframe.offsetHeight > 50) {
      return 'challenge';
    }
  }

  return 'unknown';
})()`;

// JS Script kiểm tra reCAPTCHA đã hoàn tất xác minh (tích xanh / mở khóa nút Next)
const IS_VERIFIED_JS = `(function() {
  var s = ${GET_CHECKBOX_STATE_JS};
  return s === 'checked';
})()`;

// JS Script tìm và bấm nút "Tiếp theo" / "Next" / "Submit"
const CLICK_NEXT_JS = `(function(){
  function fireClick(el) {
    if (!el) return;
    try {
      var rect = el.getBoundingClientRect();
      var clientX = rect.left + rect.width / 2;
      var clientY = rect.top + rect.height / 2;
      var opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: clientX, clientY: clientY };
      try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch(e){}
      try { el.dispatchEvent(new MouseEvent('mousedown', opts)); } catch(e){}
      try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch(e){}
      try { el.dispatchEvent(new MouseEvent('mouseup', opts)); } catch(e){}
      try { el.click(); } catch(e){}
    } catch(e) {
      try { el.click(); } catch(e2){}
    }
  }

  var sels = [
    '#identifierNext button', '#identifierNext [role="button"]', '#identifierNext',
    '#recaptchaNext button', '#recaptchaNext [role="button"]', '#recaptchaNext',
    '#passwordNext button', '#passwordNext [role="button"]', '#passwordNext',
    '#recaptcha-demo-submit', 'button[type="submit"]', 'input[type="submit"]'
  ];
  for (var i = 0; i < sels.length; i++) {
    var el = document.querySelector(sels[i]);
    if (el && el.offsetParent !== null && !el.disabled && el.getAttribute('aria-disabled') !== 'true') {
      fireClick(el);
      return 'clicked-id:' + sels[i];
    }
  }

  var nodes = Array.prototype.slice.call(document.querySelectorAll('button, [role="button"], input[type="submit"]'));
  var targets = ['tiếp theo', 'next', 'xác nhận', 'confirm', 'submit', 'gửi', 'suivant', 'weiter'];
  for (var j = 0; j < nodes.length; j++) {
    var b = nodes[j];
    if (b.offsetParent === null || b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
    var s = ((b.innerText || b.textContent || b.value || '')).trim().toLowerCase();
    for (var k = 0; k < targets.length; k++) {
      if (s === targets[k] || s.indexOf(targets[k]) === 0) {
        fireClick(b);
        return 'clicked-text:' + targets[k];
      }
    }
  }
  return 'not-found';
})()`;

// Tạo JS Script để inject token và trigger callback trên trang web
function getInjectScript(token) {
  return `(function(token) {
    try {
      // 1. Đóng bảng hình ảnh challenge (bframe) nếu đang mở để tránh xung đột session với reCAPTCHA
      try {
        var ev = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true });
        document.dispatchEvent(ev);
        window.dispatchEvent(ev);
      } catch(e) {}

      // 2. Điền token vào các trường g-recaptcha-response
      var els = document.querySelectorAll('[name="g-recaptcha-response"], #g-recaptcha-response');
      var injected = false;
      for (var i = 0; i < els.length; i++) {
        // TUYỆT ĐỐI KHÔNG dùng .innerHTML vì accounts.google.com kích hoạt Trusted Types (TrustedHTML)
        els[i].value = token;
        try {
          els[i].dispatchEvent(new Event('input', { bubbles: true }));
          els[i].dispatchEvent(new Event('change', { bubbles: true }));
        } catch(e) {}
        injected = true;
      }

      // 3. Kích hoạt callback reCAPTCHA an toàn (tránh gọi nhầm vào RPC handler nội bộ của Google)
      var called = false;

      // Ưu tiên 1: Tìm qua thuộc tính data-callback trên thẻ HTML
      var container = document.querySelector('[data-callback]');
      if (container) {
        var cbName = container.getAttribute('data-callback');
        if (cbName && typeof window[cbName] === 'function') {
          try {
            window[cbName](token);
            called = true;
          } catch(e) {}
        }
      }

      // Ưu tiên 2: Quét đệ quy trong window.___grecaptcha_cfg.clients theo chuẩn 2Captcha
      if (!called && typeof window.___grecaptcha_cfg !== 'undefined' && window.___grecaptcha_cfg.clients) {
        var clients = window.___grecaptcha_cfg.clients;
        var findCallback = function(obj, depth) {
          if (!obj || depth > 5) return null;
          for (var key in obj) {
            try {
              if (key === 'callback') {
                if (typeof obj[key] === 'function') return obj[key];
                if (typeof obj[key] === 'string' && typeof window[obj[key]] === 'function') return window[obj[key]];
              }
              if (typeof obj[key] === 'object' && obj[key] !== null) {
                var found = findCallback(obj[key], depth + 1);
                if (found) return found;
              }
            } catch(e) {}
          }
          return null;
        };

        for (var cid in clients) {
          var client = clients[cid];
          if (!client || typeof client !== 'object') continue;
          var cb = findCallback(client, 0);
          if (typeof cb === 'function') {
            try {
              cb(token);
              called = true;
              break;
            } catch(errCb) {}
          }
        }
      }

      if (called) return 'callback-called';
      if (injected) return 'token-injected';
      return 'no-element-found';
    } catch(err) {
      return 'error: ' + (err && err.message);
    }
  })(${JSON.stringify(token)})`;
}

class TwoCaptchaSolver {
  /**
   * @param {string|Object} [apiKey='b5840eb6f75d59207b66669269a51981'] - API Key từ 2captcha
   * @param {Object} [options] - Cấu hình tùy chọn
   * @param {number} [options.initialDelay=15000] - Thời gian chờ lần đầu trước khi poll (ms)
   * @param {number} [options.pollingInterval=5000] - Chu kỳ kiểm tra kết quả (ms)
   * @param {number} [options.timeout=120000] - Thời gian chờ tối đa (ms)
   */
  constructor(apiKey = DEFAULT_API_KEY, options = {}) {
    if (typeof apiKey === 'object' && apiKey !== null) {
      options = apiKey;
      apiKey = options.apiKey || DEFAULT_API_KEY;
    }

    this.apiKey = apiKey || DEFAULT_API_KEY;
    this.initialDelay = options.initialDelay || 15000;
    this.pollingInterval = options.pollingInterval || 5000;
    this.timeout = options.timeout || 120000;
    this.baseUrl = 'https://2captcha.com';
  }

  /**
   * Chờ một khoảng thời gian
   * @private
   */
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Hàm static kiểm tra số dư tài khoản
   * @param {string} [apiKey] - Tùy chọn, mặc định lấy API Key hệ thống
   * @returns {Promise<number>} Số dư (USD)
   */
  static async getBalance(apiKey = DEFAULT_API_KEY) {
    const key = apiKey || DEFAULT_API_KEY;
    const url = `https://2captcha.com/res.php?key=${key}&action=getbalance&json=1`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.status === 1) {
      return parseFloat(data.request);
    }
    throw new Error(`[TwoCaptcha] Lỗi lấy số dư: ${data.request}`);
  }

  /**
   * Kiểm tra số dư tài khoản (USD) của instance hiện tại
   * @returns {Promise<number>}
   */
  async getBalance() {
    return TwoCaptchaSolver.getBalance(this.apiKey);
  }

  /**
   * Giải Google reCAPTCHA v2 qua 2Captcha API
   * @param {Object} params
   * @param {string} params.siteKey - data-sitekey của Google reCAPTCHA
   * @param {string} params.pageUrl - URL trang web chứa captcha
   * @param {boolean} [params.invisible=false] - True nếu là invisible reCAPTCHA
   * @param {string} [params.dataS] - Giá trị data-s (nếu có)
   * @param {string} [params.userAgent] - User-Agent của profile trình duyệt
   * @returns {Promise<{ success: boolean, token?: string, requestId?: string, error?: string }>}
   */
  async solveRecaptchaV2({ siteKey, pageUrl, invisible = false, dataS = null, userAgent = null, heartbeat = null } = {}) {
    try {
      if (!siteKey || !pageUrl) {
        return {
          success: false,
          error: 'Thiếu siteKey hoặc pageUrl bắt buộc để giải reCAPTCHA'
        };
      }

      // 1. Tạo task gửi lên in.php
      console.log(`[TwoCaptcha] 📤 Đang gửi task giải reCAPTCHA lên 2Captcha...`);
      let submitUrl = `${this.baseUrl}/in.php?key=${this.apiKey}&method=userrecaptcha&googlekey=${siteKey}&pageurl=${encodeURIComponent(pageUrl)}&json=1`;
      
      if (invisible) {
        submitUrl += '&invisible=1';
      }
      if (dataS) {
        submitUrl += `&data-s=${encodeURIComponent(dataS)}`;
      }
      if (userAgent) {
        submitUrl += `&userAgent=${encodeURIComponent(userAgent)}`;
      }

      const submitRes = await fetch(submitUrl);
      const submitData = await submitRes.json();

      if (submitData.status !== 1) {
        console.error(`[TwoCaptcha] ❌ Lỗi tạo task 2Captcha: ${submitData.request}`);
        return {
          success: false,
          error: `Lỗi tạo task 2Captcha: ${submitData.request}`
        };
      }

      const requestId = submitData.request;
      console.log(`[TwoCaptcha] ⏳ Tạo task 2Captcha thành công! Request ID: ${requestId}. Đang đợi giải mã (chờ tối thiểu ${Math.round(this.initialDelay / 1000)}s)...`);
      const startTime = Date.now();

      // 2. Chờ delay ban đầu (giữ WebSocket CDP sống qua heartbeat)
      const delayStart = Date.now();
      while (Date.now() - delayStart < this.initialDelay) {
        const chunk = Math.min(2500, this.initialDelay - (Date.now() - delayStart));
        await this._sleep(chunk);
        if (typeof heartbeat === 'function') {
          try { await heartbeat(); } catch(e) {}
        }
      }

      // 3. Polling kiểm tra kết quả qua res.php
      const resUrl = `${this.baseUrl}/res.php?key=${this.apiKey}&action=get&id=${requestId}&json=1`;

      while (Date.now() - startTime < this.timeout) {
        if (typeof heartbeat === 'function') {
          try { await heartbeat(); } catch(e) {}
        }
        const checkRes = await fetch(resUrl);
        const checkData = await checkRes.json();

        if (checkData.status === 1) {
          console.log(`[TwoCaptcha] ✅ 2Captcha đã giải xong reCAPTCHA thành công!`);
          return {
            success: true,
            token: checkData.request,
            requestId: requestId,
            error: null
          };
        }

        if (checkData.request === 'CAPCHA_NOT_READY') {
          const pollStart = Date.now();
          while (Date.now() - pollStart < this.pollingInterval) {
            const chunk = Math.min(2500, this.pollingInterval - (Date.now() - pollStart));
            await this._sleep(chunk);
            if (typeof heartbeat === 'function') {
              try { await heartbeat(); } catch(e) {}
            }
          }
          continue;
        }

        return {
          success: false,
          requestId: requestId,
          error: `2Captcha trả về lỗi: ${checkData.request}`
        };
      }

      return {
        success: false,
        requestId: requestId,
        error: `Quá thời gian chờ (Timeout ${this.timeout / 1000}s) nhưng captcha chưa giải xong`
      };
    } catch (err) {
      return {
        success: false,
        error: `Ngoại lệ khi giải captcha: ${err.message || String(err)}`
      };
    }
  }

  // Alias tương thích cách gõ tên hàm
  async solveRecapchaV2(params) {
    return this.solveRecaptchaV2(params);
  }

  async solveCaptchaV2(params) {
    return this.solveRecaptchaV2(params);
  }

  /**
   * Phát hiện và lấy thông tin siteKey, pageUrl, invisible từ trang web
   * @param {Function} evaluate - Hàm evaluate của CDP hoặc Puppeteer
   * @returns {Promise<{ detected: boolean, type?: string, siteKey?: string, sitekey?: string, pageUrl?: string, invisible?: boolean, dataS?: string }>}
   */
  async detect(evaluate) {
    if (typeof evaluate !== 'function') {
      throw new Error('[TwoCaptcha] Cần truyền hàm evaluate');
    }
    return await evaluate(CHECK_CAPTCHA_JS);
  }

  // Alias tương thích
  async getCaptchaInfo(evaluate) {
    return this.detect(evaluate);
  }

  /**
   * Chèn token đã giải vào trang web và gọi callback reCAPTCHA
   * @param {Function} evaluate - Hàm evaluate của CDP hoặc Puppeteer
   * @param {string} token - Chuỗi token g-recaptcha-response
   * @returns {Promise<string>}
   */
  async injectToken(evaluate, token) {
    if (typeof evaluate !== 'function') {
      throw new Error('[TwoCaptcha] Cần truyền hàm evaluate');
    }
    return await evaluate(getInjectScript(token));
  }

  /**
   * Bấm vào ô vuông checkbox "Tôi không phải là người máy" qua click chuột thật
   * @param {Function} evaluate - Hàm evaluate của CDP
   * @param {Function} clickAt - Hàm click chuột thật tại toạ độ (x, y)
   * @param {boolean} [waitCheck=false] - Tự động đợi icon loading -> icon Check
   * @returns {Promise<boolean>}
   */
  async clickCheckbox(evaluate, clickAt, waitCheck = false) {
    if (typeof evaluate !== 'function' || typeof clickAt !== 'function') {
      return false;
    }
    const boxCoord = await evaluate(CHECKBOX_COORD_JS);
    if (boxCoord && typeof boxCoord.x === 'number') {
      console.log('[TwoCaptcha] 🖱️ Bấm tích vào ô reCAPTCHA tại toạ độ:', Math.round(boxCoord.x), Math.round(boxCoord.y));
      await clickAt(boxCoord.x, boxCoord.y);
      if (waitCheck) {
        return await this.waitForCheckState(evaluate);
      }
      return true;
    }
    return false;
  }

  /**
   * Kiểm tra trực tiếp frame anchor của reCAPTCHA xem đã có tích xanh chưa
   * Vượt qua hạn chế cross-origin giữa accounts.google.com và www.google.com
   * @param {Object} page - Puppeteer page
   * @returns {Promise<boolean>}
   */
  async isAnchorChecked(page) {
    if (!page || typeof page.frames !== 'function') return false;
    try {
      const frames = page.frames();
      const anchorFrame = frames.find(f => {
        const u = (f.url && f.url()) || '';
        return u.includes('recaptcha') && u.includes('anchor');
      });
      if (anchorFrame && typeof anchorFrame.evaluate === 'function') {
        const checked = await anchorFrame.evaluate(() => {
          const anchor = document.querySelector('#recaptcha-anchor, .recaptcha-checkbox');
          if (!anchor) return false;
          const ariaChecked = anchor.getAttribute('aria-checked');
          const cls = (anchor.className || '').toLowerCase();
          if (ariaChecked === 'true' || cls.includes('recaptcha-checkbox-checked')) return true;
          const statusEl = document.querySelector('#recaptcha-accessible-status, .rc-anchor-aria-status');
          const statusText = (statusEl ? (statusEl.innerText || statusEl.textContent || '') : '').toLowerCase();
          return statusText.includes('verified') || statusText.includes('đã được xác minh') || statusText.includes('bạn đã xác minh');
        });
        if (checked === true) return true;
      }
    } catch (_) {}
    return false;
  }

  /**
   * Chờ quy trình sau khi bấm ô checkbox:
   * 1. Nhận diện icon loading (spinner) bắt đầu quay
   * 2. Chờ icon loading kết thúc và icon "Check" (tích xanh) xuất hiện
   * 
   * @param {Function} evaluate - Hàm evaluate của CDP hoặc Puppeteer
   * @param {number} [maxTimeoutMs=10000] - Thời gian chờ tối đa (ms)
   * @param {number} [intervalMs=150] - Chu kỳ kiểm tra (ms)
   * @param {boolean} [abortOnChallenge=true] - Dừng sớm nếu Google mở bảng ảnh
   * @param {Object} [page=null] - Puppeteer page để kiểm tra anchor frame cross-origin
   * @returns {Promise<boolean>}
   */
  async waitForCheckState(evaluate, maxTimeoutMs = 100000, intervalMs = 150, abortOnChallenge = true, page = null) {
    if (typeof evaluate !== 'function') return false;
    const start = Date.now();
    let sawLoading = false;
    console.log('[TwoCaptcha] ⏳ Đang theo dõi ô tích: chờ icon Loading -> icon "Check"...');

    while (Date.now() - start < maxTimeoutMs) {
      if (page && await this.isAnchorChecked(page)) {
        console.log(`[TwoCaptcha] ✅ Đã xuất hiện icon "Check" (tích xanh trên anchor frame sau ${Date.now() - start}ms)!`);
        return true;
      }

      const state = await evaluate(GET_CHECKBOX_STATE_JS);

      if (state === 'checked') {
        if (sawLoading) {
          console.log(`[TwoCaptcha] ✅ Đã xuất hiện icon "Check" (tích xanh hoàn tất sau khi loading, tổng: ${Date.now() - start}ms)!`);
        } else {
          console.log(`[TwoCaptcha] ✅ Đã xuất hiện icon "Check" (tích xanh xác minh thành công sau ${Date.now() - start}ms)!`);
        }
        return true;
      }

      if (abortOnChallenge && state === 'challenge') {
        console.warn(`[TwoCaptcha] 📸 Phát hiện Google mở bảng chọn ảnh (Image Challenge) sau ${Date.now() - start}ms!`);
        return false;
      }

      if (state === 'loading') {
        if (!sawLoading) {
          sawLoading = true;
          console.log(`[TwoCaptcha] 🔄 Đã phát hiện icon Loading (spinner đang quay sau ${Date.now() - start}ms)...`);
        }
      }

      await this._sleep(intervalMs);
    }

    console.warn(`[TwoCaptcha] ⚠️ Hết thời gian chờ (${maxTimeoutMs}ms), chưa thấy icon Check.`);
    return false;
  }

  /**
   * Chờ trạng thái reCAPTCHA xác minh xong (icon Check / mở khoá nút Tiếp theo)
   * @param {Function} evaluate - Hàm evaluate của CDP
   * @param {number} [maxTimeoutMs=10000] - Thời gian chờ tối đa (ms)
   * @param {number} [intervalMs=150] - Chu kỳ kiểm tra (ms)
   * @returns {Promise<boolean>}
   */
  async waitForVerified(evaluate, maxTimeoutMs = 10000, intervalMs = 150) {
    return await this.waitForCheckState(evaluate, maxTimeoutMs, intervalMs);
  }

  /**
   * Bấm nút "Tiếp theo" / "Next" / "Submit" trên trang web
   * @param {Function} evaluate - Hàm evaluate của CDP hoặc Puppeteer
   * @param {number} [maxAttempts=20] - Số lần thử tối đa
   * @param {number} [intervalMs=500] - Chu kỳ thử lại giữa các lần (ms)
   * @returns {Promise<boolean>} Trả về true nếu đã bấm thành công
   */
  async clickNext(evaluate, maxAttempts = 20, intervalMs = 500) {
    if (typeof evaluate !== 'function') {
      throw new Error('[TwoCaptcha] Cần truyền hàm evaluate vào clickNext');
    }
    for (let i = 0; i < maxAttempts; i++) {
      const ready = await evaluate('document.readyState');
      if (ready === 'complete' || ready === 'interactive') {
        const res = await evaluate(CLICK_NEXT_JS);
        if (res && res.startsWith('clicked')) {
          console.log(`[TwoCaptcha] ➡️ Đã bấm nút Tiếp theo (${res})!`);
          return true;
        }
      }
      await this._sleep(intervalMs);
    }
    console.warn('[TwoCaptcha] ⚠️ Không tìm thấy hoặc chưa bấm được nút Tiếp theo.');
    return false;
  }

  /**
   * Lấy thông tin nút hành động (#recaptcha-verify-button) trong bảng chọn ảnh reCAPTCHA (bframe)
   * @param {Object} page - Đối tượng Page của Puppeteer
   * @param {number} [maxWaitMs=4000] - Thời gian tối đa chờ iframe hiển thị và load nút
   * @returns {Promise<{ frame: Object, found: boolean, text: string, type: 'skip' | 'verify' | 'other', disabled: boolean } | null>}
   */
  async getChallengeButtonInfo(page, maxWaitMs = 4000) {
    if (!page || typeof page.frames !== 'function') return null;
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      let bframe = null;
      try {
        const frames = page.frames();
        bframe = frames.find(f => {
          const u = f.url() || '';
          return u.includes('recaptcha/api2/bframe') || u.includes('recaptcha/enterprise/bframe');
        });
      } catch (_) {}

      if (bframe) {
        try {
          const info = await bframe.evaluate(() => {
            const btn = document.querySelector('#recaptcha-verify-button') || document.querySelector('.rc-button-default');
            if (!btn) return null;
            const text = (btn.innerText || btn.textContent || btn.value || btn.getAttribute('aria-label') || '').trim();
            const lower = text.toLowerCase();
            const isSkip = lower.includes('skip') || lower.includes('bỏ qua') || lower.includes('bo qua');
            const isVerify = lower.includes('verify') || lower.includes('xác minh') || lower.includes('xac minh');
            return {
              found: true,
              text,
              type: isSkip ? 'skip' : (isVerify ? 'verify' : 'other'),
              disabled: !!(btn.disabled || btn.getAttribute('aria-disabled') === 'true')
            };
          });
          if (info && info.text) {
            return { frame: bframe, ...info };
          }
        } catch (_) {}
      }
      await this._sleep(200);
    }
    return null;
  }

  /**
   * Bấm nút hành động (#recaptcha-verify-button) trong challenge frame
   * @param {Object} frame - Đối tượng Frame Puppeteer của bframe
   * @returns {Promise<boolean>}
   */
  async clickChallengeVerifyButton(frame) {
    if (!frame) return false;
    let clicked = false;
    try {
      if (typeof frame.click === 'function') {
        await frame.click('#recaptcha-verify-button');
        clicked = true;
      }
    } catch (_) {}
    if (!clicked) {
      try {
        clicked = await frame.evaluate(() => {
          const btn = document.querySelector('#recaptcha-verify-button') || document.querySelector('.rc-button-default');
          if (btn) {
            const opts = { bubbles: true, cancelable: true, composed: true, view: window };
            try { btn.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (_) {}
            try { btn.dispatchEvent(new MouseEvent('mousedown', opts)); } catch (_) {}
            try { btn.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (_) {}
            try { btn.dispatchEvent(new MouseEvent('mouseup', opts)); } catch (_) {}
            btn.click();
            return true;
          }
          return false;
        });
      } catch (_) {}
    }
    return clicked;
  }

  /**
   * Xử lý luồng khi nút trong iframe là "SKIP":
   * 1. Bấm nút SKIP
   * 2. Chờ phản hồi:
   *    - TH A: Iframe tự động tắt + ô checkbox xuất hiện tích xanh -> Bấm Next nếu autoClickNext, trả về { bypassedNaturally: true, skipBypassed: true }
   *    - TH B: Iframe load lại và nút chuyển thành "Verify" -> Trả về { proceedToSolve: true } để chuyển sang gọi 2Captcha giải
   *    - TH C: Nút vẫn là "SKIP" -> Tiếp tục bấm SKIP (tối đa maxSkips lần)
   */
  async handleSkipFlow({ page, evaluate, autoClickNext = false, initialBtn = null, maxSkips = 5 } = {}) {
    let currentBtn = initialBtn || await this.getChallengeButtonInfo(page, 2000);
    let skipsDone = 0;

    while (currentBtn && currentBtn.type === 'skip' && skipsDone < maxSkips) {
      skipsDone++;
      console.log(`[TwoCaptcha] ⏭️ Phát hiện nút "${currentBtn.text}" (SKIP) trong iframe (lần ${skipsDone}/${maxSkips}) -> Bấm nút SKIP...`);

      if (currentBtn.frame) {
        await this.clickChallengeVerifyButton(currentBtn.frame);
      }

      console.log(`[TwoCaptcha] ⏳ Đang theo dõi phản hồi sau khi nhấn SKIP...`);
      const startPoll = Date.now();
      let stateOutcome = null; // 'checked' | 'verify' | 'skip' | 'timeout'

      while (Date.now() - startPoll < 7000) {
        await this._sleep(300);

        // 0. Kiểm tra nếu URL đã thay đổi rời khỏi reCAPTCHA
        if (page && typeof page.url === 'function') {
          try {
            const curUrl = page.url();
            if (!curUrl.includes('challenge/recaptcha') && !curUrl.includes('challenge/kav')) {
              console.log('[TwoCaptcha] 🚀 Trang đã tự động chuyển hướng sau khi SKIP!');
              return {
                handled: true,
                success: true,
                detected: true,
                autoRedirected: true
              };
            }
          } catch (_) {}
        }

        // 1. Kiểm tra TH A: Iframe tự động tắt + tích xanh
        let isChecked = false;
        if (page) {
          isChecked = await this.isAnchorChecked(page);
        }
        if (!isChecked) {
          try {
            const state = await evaluate(GET_CHECKBOX_STATE_JS);
            if (state === 'checked') isChecked = true;
          } catch (_) {}
        }

        if (isChecked) {
          console.log(`[TwoCaptcha] 🎉 Sau khi nhấn SKIP, ô reCAPTCHA đã xuất hiện tích xanh!`);
          stateOutcome = 'checked';
          break;
        }

        // 2. Kiểm tra xem iframe còn mở và nút trong iframe đã đổi sang "Verify" chưa
        const nextBtn = await this.getChallengeButtonInfo(page, 500);
        if (nextBtn && nextBtn.found && !nextBtn.disabled) {
          if (nextBtn.type === 'verify') {
            console.log(`[TwoCaptcha] 🔍 Sau khi nhấn SKIP, iframe đã load lại và nút chuyển thành "Verify" ("${nextBtn.text}")!`);
            currentBtn = nextBtn;
            stateOutcome = 'verify';
            break;
          } else if (nextBtn.type === 'skip') {
            currentBtn = nextBtn;
            stateOutcome = 'skip';
            await this._sleep(600);
            break;
          }
        }
      }

      // Nếu hết poll mà không tìm thấy nextBtn (có thể bframe đã biến mất và xuất hiện tích xanh)
      if (!stateOutcome && page) {
        if (typeof page.url === 'function' && !page.url().includes('challenge/recaptcha') && !page.url().includes('challenge/kav')) {
          return { handled: true, success: true, detected: true, autoRedirected: true };
        }
        if (await this.isAnchorChecked(page)) {
          stateOutcome = 'checked';
        }
      }

      if (stateOutcome === 'checked') {
        if (autoClickNext) {
          await this.clickNext(evaluate);
        }
        return {
          handled: true,
          success: true,
          detected: true,
          bypassedNaturally: true,
          skipBypassed: true
        };
      }

      if (stateOutcome === 'verify') {
        return {
          handled: true,
          proceedToSolve: true,
          buttonText: currentBtn ? currentBtn.text : 'Verify'
        };
      }
    }

    return { handled: false, proceedToSolve: true };
  }

  /**
   * Hàm trọn gói: Tự động giải Captcha và bypass theo CHIẾN LƯỢC 2 (Thông minh & Tiết kiệm chi phí):
   * 1. BƯỚC 1: Thử bấm ô tích reCAPTCHA trước
   * 2. Chờ Google phản hồi (~3.5s):
   *    - Nếu Google cho tích xanh (1-Click Pass) ➔ THÀNH CÔNG NGAY, KHÔNG TỐN TIỀN 2CAPTCHA!
   *    - Nếu Google bắt chọn ảnh (challenge) hoặc không xanh ➔ Chuyển sang Bước 1.5 kiểm tra nút iframe.
   * 3. BƯỚC 1.5: Kiểm tra nút trong iframe challenge là "Verify" hay "SKIP"
   *    - Nếu "SKIP" -> bấm SKIP, nếu tự tắt + tích xanh -> bypass thành công; nếu load lại nút "Verify" -> chuyển Bước 2.
   *    - Nếu "Verify" -> chuyển sang Bước 2 gọi 2Captcha.
   * 4. BƯỚC 2: Gọi 2Captcha giải lấy token ➔ In log Captcha result ngay lập tức.
   * 5. BƯỚC 3: Inject token & kích hoạt callback để bypass bảng ảnh / mở khóa nút Tiếp theo.
   * 6. (Tùy chọn) Bấm Tiếp theo nếu autoClickNext = true.
   * 
   * @param {Object} params
   * @param {Function} params.evaluate - Hàm evaluate của CDP
   * @param {Function} [params.clickAt] - Hàm clickAt chuột thật của CDP
   * @param {Object} [params.cap] - Thông tin captcha (nếu đã detect trước đó)
   * @param {boolean} [params.autoClickNext=false] - Tự động bấm Tiếp theo sau khi giải xong
   * @param {string} [params.userAgent] - User-Agent tùy chọn của profile
   * @param {Object} [params.page] - Đối tượng Page của Puppeteer để tương tác iframe challenge
   * @returns {Promise<{ success: boolean, detected: boolean, token?: string, requestId?: string, error?: string, bypassedNaturally?: boolean, skipBypassed?: boolean }>}
   */
  async solveAndBypass({ evaluate, clickAt = null, cap = null, autoClickNext = false, userAgent = null, page = null } = {}) {
    if (!cap) {
      cap = await this.detect(evaluate);
    }
    if (!cap || !cap.detected) {
      return { success: true, detected: false };
    }

    const siteKey = cap.siteKey || cap.sitekey;

    // =========================================================================
    // BƯỚC 1: THỬ VẬN MAY MIỄN PHÍ (Bấm ô tích trước nếu là Checkbox v2)
    // =========================================================================
    if (clickAt && !cap.invisible) {
      console.log(`[TwoCaptcha] 🖱️ Bước 1: Thử bấm ô tích reCAPTCHA trước xem Google có cho tích xanh miễn phí không...`);
      await this.clickCheckbox(evaluate, clickAt);

      console.log(`[TwoCaptcha] ⏳ Đang theo dõi phản hồi từ Google (tối đa 3.5s)...`);
      const freePass = await this.waitForCheckState(evaluate, 10000, 150, true, page);
      if (freePass) {
        console.log(`[TwoCaptcha] 🎉 TUYỆT VỜI: Google đã tự động cấp tích xanh (1-Click Pass)!`);
        console.log(`[TwoCaptcha] 💰 Tiết kiệm thành công 100% chi phí giải 2Captcha!`);
        if (autoClickNext) {
          await this.clickNext(evaluate);
        }
        return {
          success: true,
          detected: true,
          bypassedNaturally: true
        };
      }

      console.log(`[TwoCaptcha] ⚠️ Không qua được 1-Click (xuất hiện bảng chọn ảnh hoặc cần token) -> Tiếp tục kiểm tra iframe...`);
    }

    // =========================================================================
    // BƯỚC 1.5: KIỂM TRA NÚT TRONG IFRAME CHALLENGE ("Verify" hay "SKIP")
    // =========================================================================
    if (page && typeof page.frames === 'function') {
      console.log(`[TwoCaptcha] 🔍 Kiểm tra nút trong bảng xác minh hình ảnh (bframe)...`);
      const btnInfo = await this.getChallengeButtonInfo(page, 4000);
      if (btnInfo && btnInfo.text) {
        console.log(`[TwoCaptcha] 🔘 Tìm thấy nút trong iframe: "${btnInfo.text}" (loại: ${btnInfo.type})`);

        if (btnInfo.type === 'skip') {
          const skipResult = await this.handleSkipFlow({ page, evaluate, autoClickNext, initialBtn: btnInfo });
          if (skipResult && (skipResult.bypassedNaturally || skipResult.autoRedirected || skipResult.success)) {
            return skipResult;
          }
          console.log(`[TwoCaptcha] 🔑 Đã sẵn sàng nút "Verify" sau khi SKIP -> Gửi cho 2Captcha giải...`);
        } else if (btnInfo.type === 'verify') {
          console.log(`[TwoCaptcha] 🎯 Nút trong iframe là "Verify" -> Gửi cho 2Captcha giải như hiện tại...`);
        }
      }
    }

    // Kiểm tra nhanh trước khi gọi 2Captcha: xem trang đã được tích xanh hoặc chuyển URL chưa
    if (page) {
      if (typeof page.url === 'function' && !page.url().includes('challenge/recaptcha') && !page.url().includes('challenge/kav')) {
        console.log('[TwoCaptcha] 🚀 Trang đã chuyển hướng, không cần gửi 2Captcha!');
        return { success: true, detected: true, autoRedirected: true };
      }
      if (await this.isAnchorChecked(page)) {
        console.log('[TwoCaptcha] ✅ Ô reCAPTCHA đã có tích xanh, không cần gửi 2Captcha!');
        if (autoClickNext) await this.clickNext(evaluate);
        return { success: true, detected: true, bypassedNaturally: true };
      }
    }

    // =========================================================================
    // BƯỚC 2: GỌI 2CAPTCHA KHI CẦN THIẾT
    // =========================================================================
    console.log(`[TwoCaptcha] 🔑 Bắt đầu gửi giải ${cap.type} qua 2Captcha (Sitekey: ${siteKey})...`);

    let ua = userAgent || cap.userAgent || null;
    if (!ua && typeof evaluate === 'function') {
      try {
        ua = await evaluate('(typeof navigator !== "undefined" && navigator.userAgent) || ""');
      } catch (_) {}
    }
    if (ua) {
      console.log(`[TwoCaptcha] 🌐 Gửi kèm User-Agent của profile lên 2Captcha: ${ua}`);
    }

    const solveResult = await this.solveRecaptchaV2({
      siteKey: siteKey,
      pageUrl: cap.pageUrl,
      invisible: cap.invisible,
      dataS: cap.dataS,
      userAgent: ua,
      heartbeat: typeof evaluate === 'function' ? () => evaluate('1') : null
    });

    if (!solveResult.success) {
      return {
        success: false,
        detected: true,
        error: solveResult.error,
        requestId: solveResult.requestId
      };
    }

    // In log kết quả Captcha ngay khi vừa nhận được token từ 2Captcha (trước khi inject)
    console.warn(`[login-trace] ⚠️ Captcha result: ${solveResult.token} , requestID: ${solveResult.requestId}`);

    // =========================================================================
    // BƯỚC 3: INJECT TOKEN VÀ KÍCH HOẠT CALLBACK
    // =========================================================================
    console.log(`[TwoCaptcha] 💉 Inject token vào trang web...`);
    const injectRes = await this.injectToken(evaluate, solveResult.token);
    console.log(`[TwoCaptcha] 💉 Kết quả inject: ${injectRes}`);

    // Theo dõi: Khi callback kích hoạt thành công, Google Login thường TỰ ĐỘNG chuyển trang
    // sang bước nhập mật khẩu (/signin/challenge/pwd) hoặc đóng bảng ảnh.
    console.log(`[TwoCaptcha] ⏳ Chờ Google nhận callback và tự động điều chuyển...`);
    let autoRedirected = false;
    let challengeClosed = false;

    for (let i = 0; i < 500; i++) {
      await this._sleep(200);
      const status = await evaluate(`(function() {
        var href = location.href || '';
        function isDoneUrl(h) {
          try {
            var u = new URL(h);
            if (u.hostname === 'mail.google.com' || u.hostname === 'myaccount.google.com') return true;
            var p = u.pathname.toLowerCase();
            if (p.indexOf('/signin/challenge/recaptcha') !== -1) return false;
            if (p.indexOf('/signin/challenge/pwd') !== -1) return true;
            if (p.indexOf('/signin/challenge/pk') !== -1) return true;
            if (p.indexOf('/signin/challenge/totp') !== -1) return true;
            if (p.indexOf('/signin/challenge/ipp') !== -1) return true;
            if (p.indexOf('/signin/challenge/iap') !== -1) return true;
            if (p.indexOf('/signin/challenge/skotp') !== -1) return true;
          } catch(e){}
          return false;
        }
        var isPwdUrl = isDoneUrl(href);
        var hasPwdField = !href.includes('challenge/recaptcha') && !!document.querySelector('input[type="password"], input[name="Passwd"], input[name="totpPin"]');
        var bframe = document.querySelector('iframe[src*="recaptcha/api2/bframe"], iframe[title*="challenge" i]');
        var bOpen = false;
        if (bframe && bframe.offsetParent !== null) {
          var s = window.getComputedStyle ? window.getComputedStyle(bframe) : null;
          bOpen = s && s.visibility !== 'hidden' && s.display !== 'none' && parseFloat(s.opacity || '1') > 0 && bframe.offsetHeight > 50;
        }
        return { isPwdUrl: isPwdUrl, hasPwdField: hasPwdField, bOpen: bOpen, href: href };
      })()`);

      if (status) {
        if (!status.bOpen && !challengeClosed) {
          challengeClosed = true;
          console.log(`[TwoCaptcha] ✅ Bảng xác minh hình ảnh đã đóng thành công!`);
        } else if (status.bOpen) {
          // Bắn phím Escape để đóng bảng ảnh sau khi đã inject token
          // try {
          //   await evaluate(`(function(){
          //     var ev = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true });
          //     document.dispatchEvent(ev);
          //     window.dispatchEvent(ev);
          //   })()`);
          // } catch(e){}
        }

        if (status.isPwdUrl || status.hasPwdField) {
          autoRedirected = true;
          console.log(`[TwoCaptcha] 🚀 Google đã tự động chuyển tiếp tới màn hình tiếp theo (${status.href})!`);
          break;
        }
      }
    }

    // Nếu chưa tự chuyển, kiểm tra lại một lần nữa
    if (!autoRedirected) {
      await this._sleep(800);
      try {
        const checkAgain = await evaluate(`(function() {
          var href = location.href || '';
          try {
            var u = new URL(href);
            if (u.hostname === 'mail.google.com' || u.hostname === 'myaccount.google.com') return true;
            var p = u.pathname.toLowerCase();
            if (p.indexOf('/signin/challenge/recaptcha') !== -1) return false;
            if (p.indexOf('/signin/challenge/pwd') !== -1) return true;
            if (p.indexOf('/signin/challenge/pk') !== -1) return true;
            if (p.indexOf('/signin/challenge/totp') !== -1) return true;
            if (p.indexOf('/signin/challenge/iap') !== -1) return true;
            if (p.indexOf('/signin/challenge/skotp') !== -1) return true;
          } catch(e){}
          var hasPwdField = !href.includes('challenge/recaptcha') && !!document.querySelector('input[type="password"], input[name="Passwd"]');
          return hasPwdField;
        })()`);
        if (checkAgain) {
          autoRedirected = true;
          console.log(`[TwoCaptcha] 🚀 Google đã tự động chuyển tiếp sau khi đồng bộ!`);
        }
      } catch(e) {}
    }

    // =========================================================================
    // BƯỚC 4: TỰ ĐỘNG BẤM TIẾP THEO (nếu trang chưa tự chuyển)
    // =========================================================================
    if (!autoRedirected) {
      console.log(`[TwoCaptcha] ➡️ Trang chưa tự chuyển`);
      //await this.clickNext(evaluate);
    }

    return {
      success: true,
      detected: true,
      autoRedirected: autoRedirected,
      token: solveResult.token,
      requestId: solveResult.requestId
    };
  }

  /**
   * Báo cáo token sai (được hoàn lại tiền trên 2captcha)
   * @param {string} requestId
   */
  async reportBad(requestId) {
    const url = `${this.baseUrl}/res.php?key=${this.apiKey}&action=reportbad&id=${requestId}&json=1`;
    const res = await fetch(url);
    return await res.json();
  }

  /**
   * Báo cáo token đúng
   * @param {string} requestId
   */
  async reportGood(requestId) {
    const url = `${this.baseUrl}/res.php?key=${this.apiKey}&action=reportgood&id=${requestId}&json=1`;
    const res = await fetch(url);
    return await res.json();
  }
}

// Gắn các hằng số và script vào class
TwoCaptchaSolver.CHECK_CAPTCHA_JS = CHECK_CAPTCHA_JS;
TwoCaptchaSolver.CHECKBOX_COORD_JS = CHECKBOX_COORD_JS;
TwoCaptchaSolver.GET_CHECKBOX_STATE_JS = GET_CHECKBOX_STATE_JS;
TwoCaptchaSolver.IS_VERIFIED_JS = IS_VERIFIED_JS;
TwoCaptchaSolver.CLICK_NEXT_JS = CLICK_NEXT_JS;
TwoCaptchaSolver.getInjectScript = getInjectScript;

module.exports = TwoCaptchaSolver;
module.exports.TwoCaptchaSolver = TwoCaptchaSolver;
module.exports.checkCaptchaJs = CHECK_CAPTCHA_JS;
