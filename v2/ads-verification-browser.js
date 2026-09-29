const trace = require('./trace-log');
const t = trace.traced;

const cleanCustomerId = t('adsVerifyBrowser.cleanCustomerId', id => {
  if (!id) return '';
  return String(id).replace(/\D/g, '');
});

const formatCustomerId = t('adsVerifyBrowser.formatCustomerId', id => {
  const clean = cleanCustomerId(id);
  if (clean.length === 10) {
    return `${clean.slice(0, 3)}-${clean.slice(3, 6)}-${clean.slice(6, 10)}`;
  }
  return id || '';
});

/**
 * Lấy tab đang hiển thị (visible) hoặc tab đầu tiên của trình duyệt
 */
const getActiveOrFirstPage = t('adsVerifyBrowser.getActiveOrFirstPage', async browser => {
  const pages = await browser.pages();
  let page = pages[0];
  for (const candidate of pages) {
    try {
      if (await candidate.evaluate(() => document.visibilityState === 'visible')) {
        page = candidate;
        break;
      }
    } catch (_) {}
  }
  if (!page) {
    page = await browser.newPage();
  }
  await page.bringToFront();
  return page;
});

/**
 * Điều hướng tab hiện tại tới URL https://ads.google.com/
 */
const navigateToAds = t('adsVerifyBrowser.navigateToAds', async (page, timeoutMs = 45000) => {
  console.log('[ads-verify] 🌐 Điều hướng tab hiện tại tới https://ads.google.com/...');
  await page.goto('https://ads.google.com/', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await new Promise(r => setTimeout(r, 1500));
});

/**
 * Kiểm tra xem trang có bị chuyển hướng tới trang đăng nhập Google không
 */
const checkGoogleLoginRedirect = t('adsVerifyBrowser.checkGoogleLoginRedirect', page => {
  const url = page.url() || '';
  if (url.includes('accounts.google.com/signin') ||
      url.includes('accounts.google.com/v3/signin') ||
      url.includes('accounts.google.com/ServiceLogin')) {
    throw new Error('Profile chưa đăng nhập Gmail. Vui lòng Login gmail trước khi xác minh Google Ads.');
  }
});

/**
 * Tìm và bấm nút "Bắt đầu ngay" / "Start now" trên trang chủ Google Ads
 */
const clickStartNow = t('adsVerifyBrowser.clickStartNow', async (page, maxWaitMs = 12000) => {
  const currentUrl = page.url() || '';
  if (currentUrl.includes('/aw/') || currentUrl.includes('/um/identity') || currentUrl.includes('/selectaccount')) {
    console.log('[ads-verify] ⏭️ Trình duyệt đã chuyển thẳng vào giao diện Ads hoặc chọn tài khoản, bỏ qua nút Bắt đầu ngay.');
    return true;
  }

  console.log('[ads-verify] 🔍 Đang tìm nút "Bắt đầu ngay" / "Start now"...');
  const startLabels = ['bắt đầu ngay', 'start now', 'bắt đầu', 'get started', 'đăng nhập', 'sign in'];
  const startTime = Date.now();
  let clicked = false;

  while (Date.now() - startTime < maxWaitMs) {
    clicked = await page.evaluate(labels => {
      // 1. Selector tiêu chuẩn của Google Ads landing page
      const ctaSelectors = [
        'a[data-g-action="Start now"]',
        'a[data-g-action="get-started"]',
        'a[data-g-label*="start" i]',
        'a.header__cta',
        '.glue-header__cta-link',
        'a[href*="signup"]',
        'a[href*="start"]',
        'a[href*="get-started"]'
      ];
      for (const sel of ctaSelectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) {
          el.scrollIntoView({ block: 'center' });
          el.click();
          return true;
        }
      }

      // 2. Tìm theo văn bản hoặc aria-label
      const candidates = Array.from(document.querySelectorAll('a, button, [role="button"], div[role="button"]'));
      for (const el of candidates) {
        if (el.offsetParent === null) continue;
        const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim().toLowerCase();
        for (const label of labels) {
          if (text === label || (text.includes(label) && text.length < 40)) {
            el.scrollIntoView({ block: 'center' });
            el.click();
            return true;
          }
        }
      }
      return false;
    }, startLabels).catch(() => false);

    if (clicked) {
      console.log('[ads-verify] 🖱️ Đã nhấn nút "Bắt đầu ngay" / "Start now"!');
      break;
    }
    await new Promise(r => setTimeout(r, 600));
  }

  if (!clicked) {
    console.log('[ads-verify] ⚠️ Không thấy nút "Bắt đầu ngay" (có thể trang tự chuyển tiếp).');
  }

  return clicked;
});

/**
 * Chờ trang chọn tài khoản Google Ads / danh sách MCC xuất hiện,
 * nhập MCC và click chọn tài khoản/MCC đó.
 */
const selectMccAccount = t('adsVerifyBrowser.selectMccAccount', async (page, mccId, maxWaitMs = 25000) => {
  const cleanMcc = cleanCustomerId(mccId);
  const formattedMcc = formatCustomerId(mccId);

  if (!cleanMcc) {
    throw new Error('Chưa cung cấp ID MCC hợp lệ.');
  }

  console.log(`[ads-verify] ⏳ Đang chờ giao diện chọn tài khoản để nhập và chọn MCC: ${formattedMcc} (${cleanMcc})...`);
  const startTime = Date.now();
  let selected = false;

  while (Date.now() - startTime < maxWaitMs) {
    checkGoogleLoginRedirect(page);

    const currentUrl = page.url() || '';
    if (currentUrl.includes(`ocid=${cleanMcc}`) || currentUrl.includes(`ascid=${cleanMcc}`)) {
      console.log(`[ads-verify] ✅ Đã ở sẵn trong tài khoản MCC ${formattedMcc}.`);
      return { success: true, matchedMcc: formattedMcc, alreadyInMcc: true };
    }

    selected = await page.evaluate(({ clean, formatted }) => {
      // 1. Kiểm tra có ô tìm kiếm (search input) để gõ MCC không
      const searchInputs = Array.from(document.querySelectorAll(
        'input[placeholder*="Tìm" i], input[placeholder*="Search" i], ' +
        'input[aria-label*="Tìm" i], input[aria-label*="Search" i], ' +
        'input[type="search"], input.search-input, material-input input'
      ));

      let typed = false;
      for (const input of searchInputs) {
        if (input.offsetParent !== null && !input.disabled) {
          if (!input.value || (!input.value.includes(clean) && !input.value.includes(formatted))) {
            input.focus();
            input.value = formatted;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            typed = true;
          }
        }
      }

      // 2. Tìm phần tử trong danh sách chứa MCC (cả dạng format và số liền)
      const allElements = Array.from(document.querySelectorAll(
        'tr, li, [role="row"], [role="button"], [role="link"], div.account-item, div.item, a, button, span, div'
      ));

      for (const el of allElements) {
        if (el.offsetParent === null) continue;
        const text = (el.innerText || el.textContent || '').trim();
        if (text.includes(clean) || text.includes(formatted)) {
          // Tìm phần tử có thể click được (clickable container hoặc chính nó)
          const clickable = el.closest('[role="button"], [role="row"], [role="link"], tr, li, button, a') || el;
          clickable.scrollIntoView({ block: 'center' });
          clickable.click();
          return true;
        }
      }

      return typed ? 'typed' : false;
    }, { clean: cleanMcc, formatted: formattedMcc }).catch(() => false);

    if (selected === true) {
      console.log(`[ads-verify] 🎯 Đã tìm thấy và nhấn chọn tài khoản MCC: ${formattedMcc}!`);
      break;
    }

    await new Promise(r => setTimeout(r, 800));
  }

  if (selected !== true) {
    throw new Error(`Không tìm thấy hoặc không thể chọn tài khoản MCC ${formattedMcc} trên giao diện.`);
  }

  // Chờ ngắn để click có hiệu lực chuyển trang
  await new Promise(r => setTimeout(r, 2000));
  return { success: true, matchedMcc: formattedMcc };
});

/**
 * Quy trình trọn gói:
 * 1. Mở / sử dụng tab hiện tại của profile
 * 2. Điều hướng URL tới: https://ads.google.com/
 * 3. Tìm và nhấn nút "Bắt đầu ngay" (Start now)
 * 4. Nhập MCC và chọn -> Dừng lại ở đây ("Làm tới đây thôi")
 */
const startVerificationFlow = t('adsVerifyBrowser.startVerificationFlow', async (browser, { id = null, mccId = null } = {}) => {
  console.log(`[ads-verify] 🚀 Bắt đầu luồng xác minh tài khoản trên trình duyệt cho profile ${id || ''}...`);

  // 1. Sử dụng tab hiện tại
  const page = await getActiveOrFirstPage(browser);

  // 2. Điều hướng tới https://ads.google.com/
  await navigateToAds(page);
  checkGoogleLoginRedirect(page);

  // 3. Tìm và nhấn nút "Bắt đầu ngay"
  await clickStartNow(page);

  // Chờ điều hướng sau khi nhấn nút
  await new Promise(r => setTimeout(r, 2000));
  checkGoogleLoginRedirect(page);

  // 4. Nhập MCC và chọn
  const selectResult = await selectMccAccount(page, mccId);

  console.log(`[ads-verify] 🏁 Đã hoàn thành bước chọn MCC ${selectResult.matchedMcc}.`);
  return {
    ok: true,
    mccId: selectResult.matchedMcc,
    status: 'mcc_selected'
  };
});

/**
 * Tìm và nhấn vào biểu tượng kính lúp (Search icon / .customer-search-button)
 * trong menu tài khoản Google Ads breadcrumbs
 */
const clickSearchMagnifier = t('adsVerifyBrowser.clickSearchMagnifier', async (page, maxWaitMs = 10000) => {
  console.log('[ads-verify] 🔍 Đang tìm và nhấn vào kính lúp (Search icon)...');
  const startTime = Date.now();
  let clicked = false;

  while (Date.now() - startTime < maxWaitMs) {
    clicked = await page.evaluate(() => {
      const selectors = [
        'awsm-breadcrumbs-popup .customer-search-button',
        '.customer-search-button',
        'awsm-customer-search .search-icon',
        'button[aria-label*="Search customers" i]',
        'div[aria-label*="Search customers" i]',
        '[aria-label*="Search customers" i]'
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) {
          el.scrollIntoView({ block: 'center' });
          el.click();
          return true;
        }
      }
      return false;
    }).catch(() => false);

    if (clicked) {
      console.log('[ads-verify] 🎯 Đã click vào kính lúp thành công.');
      break;
    }
    await new Promise(r => setTimeout(r, 600));
  }

  return clicked;
});

/**
 * Focus ô tìm kiếm tài khoản và gõ ID tài khoản từng ký tự kèm độ trễ
 */
const typeCustomerIdInSearch = t('adsVerifyBrowser.typeCustomerIdInSearch', async (page, customerId, typingDelayMs = 80) => {
  const formatted = formatCustomerId(customerId);
  if (!formatted) {
    throw new Error('Chưa cung cấp ID tài khoản để tìm kiếm.');
  }

  console.log('[ads-verify] ⌨️ Đang focus ô tìm kiếm tài khoản...');
  const focused = await page.evaluate(() => {
    const input = document.querySelector('awsm-customer-search input.input-area, material-input.search-input input, input.input-area') ||
                  (document.activeElement && document.activeElement.tagName === 'INPUT' ? document.activeElement : null);
    if (!input) return false;
    input.focus();
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }).catch(() => false);

  if (!focused) {
    throw new Error('Không tìm thấy ô tìm kiếm tài khoản.');
  }

  console.log('[ads-verify] ⌨️ Đang nhập ID tài khoản vào ô tìm kiếm...');
  if (page.keyboard && typeof page.keyboard.type === 'function') {
    for (const char of formatted) {
      await page.keyboard.type(char, { delay: typingDelayMs });
    }
  } else {
    await page.evaluate(text => {
      const input = document.querySelector('awsm-customer-search input.input-area, material-input.search-input input, input.input-area') || document.activeElement;
      if (input) {
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, formatted);
  }

  await new Promise(r => setTimeout(r, 300));
  return { success: true, typedId: formatted };
});

/**
 * Chờ kết quả tìm kiếm tài khoản hiển thị và mở tài khoản trong cửa sổ mới
 */
const waitForSearchResultAndOpenInNewWindow = t('adsVerifyBrowser.waitForSearchResultAndOpenInNewWindow', async (page, customerId, maxWaitMs = 15000, browser = null) => {
  const formatted = formatCustomerId(customerId);
  const clean = cleanCustomerId(customerId);
  console.log(`[ads-verify] ⏳ Đang chờ kết quả tìm kiếm hiển thị cho tài khoản: ${formatted || clean || 'bất kỳ'}...`);

  const startTime = Date.now();
  let foundAccount = null;

  while (Date.now() - startTime < maxWaitMs) {
    foundAccount = await page.evaluate(({ formattedTarget, cleanTarget }) => {
      const items = Array.from(document.querySelectorAll('awsm-customer-item, .customer-item, [role="menuitemradio"]'));
      for (const item of items) {
        if (item.offsetParent === null) continue;
        const text = (item.innerText || item.textContent || '');
        const cleanText = text.replace(/\D/g, '');

        const match = (!cleanTarget) || text.includes(formattedTarget) || (cleanTarget.length >= 4 && cleanText.includes(cleanTarget));
        if (match) {
          const a = item.matches('a') ? item : item.querySelector('a[href], a');
          const href = a ? (a.getAttribute('href') || a.href) : null;
          const rect = item.getBoundingClientRect();
          const name = item.querySelector('.customer-name')?.innerText?.trim() || '';
          const idText = item.querySelector('.customer-id')?.innerText?.trim() || '';

          return {
            found: true,
            href,
            name,
            idText,
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
          };
        }
      }
      return null;
    }, { formattedTarget: formatted, cleanTarget: clean }).catch(() => null);

    if (foundAccount && foundAccount.found) {
      console.log(`[ads-verify] 🎯 Đã tìm thấy kết quả tài khoản: "${foundAccount.name}" (${foundAccount.idText})`);
      break;
    }

    await new Promise(r => setTimeout(r, 500));
  }

  if (!foundAccount || !foundAccount.found) {
    throw new Error(`Không tìm thấy kết quả tìm kiếm cho tài khoản ${formatted || clean}.`);
  }

  let fullTargetUrl = 'https://ads.google.com/aw/overview';
  if (foundAccount.href) {
    try {
      fullTargetUrl = new URL(foundAccount.href, 'https://ads.google.com').href;
    } catch (_) {
      fullTargetUrl = foundAccount.href;
    }
  }

  console.log(`[ads-verify] 🚀 Đang mở tài khoản trong cửa sổ mới: ${fullTargetUrl}...`);
  let openedInWindow = false;

  if (browser && typeof browser.newPage === 'function') {
    const newPage = await browser.newPage();
    await newPage.goto(fullTargetUrl).catch(() => {});
    openedInWindow = true;
  } else if (page && typeof page.evaluate === 'function') {
    await page.evaluate(url => {
      window.open(url, '_blank');
    }, fullTargetUrl).catch(() => {});
    openedInWindow = true;
  }

  return {
    success: true,
    account: foundAccount,
    openedUrl: fullTargetUrl,
    openedInWindow
  };
});

module.exports = {
  cleanCustomerId,
  formatCustomerId,
  getActiveOrFirstPage,
  navigateToAds,
  checkGoogleLoginRedirect,
  clickStartNow,
  selectMccAccount,
  clickSearchMagnifier,
  typeCustomerIdInSearch,
  waitForSearchResultAndOpenInNewWindow,
  startVerificationFlow,
};


