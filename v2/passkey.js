const trace = require('./trace-log');
const { totp, typeField, humanClick, clickAndWaitUrl } = require('./gmail-login');
const t = trace.traced;

const failure = t('passkey.failure', (code, message) => {
  const span = trace.traceIn(`passkey.error.${code}`);
  try { return Object.assign(new Error(message), { passkeyCode: code }); }
  finally { trace.traceOut(span, 'error'); }
});

const PASSKEY_URL = 'https://myaccount.google.com/signinoptions/passkeys';
const PASSKEY_CREATE_LABELS = ['create a passkey', 'tạo mã xác thực', 'tạo khóa truy cập', 'tạo passkey'];
const PASSKEY_CONTINUE_LABELS = ['continue', 'tiếp tục'];
const PASSKEY_DONE_LABELS = ['done', 'xong', 'hoàn tất'];

const clickLabelRobust = t('passkey.clickLabel', async (page, labels, tries = 8, scrollBottom = false, timeoutMs = 30000) => {
  for (let attempt = 0; attempt < tries; attempt++) {
    if (scrollBottom && typeof page.evaluate === 'function') {
      try { await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); } catch (_) {}
      await new Promise(r => setTimeout(r, 400));
    }

    if (typeof page.evaluateHandle === 'function') {
      try {
        const handle = await page.evaluateHandle(targetLabels => {
          const targets = targetLabels.map(l => l.toLowerCase());
          const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, div[role="button"], span'));
          for (let i = 0; i < candidates.length; i++) {
            const el = candidates[i];
            if (el.offsetParent === null) continue;
            const text = (el.innerText || el.textContent || '').trim().toLowerCase();
            for (let j = 0; j < targets.length; j++) {
              if (text === targets[j] || (text.includes(targets[j]) && text.length < 80)) {
                return el.closest('button, [role="button"], a') || el;
              }
            }
          }
          return null;
        }, labels);

        const el = handle.asElement();
        if (el) {
          const clicked = await humanClick(page, el, timeoutMs);
          if (clicked) return true;
        }
      } catch (_) {}
    }

    const clicked = await page.evaluate(targetLabels => {
      const targets = targetLabels.map(l => l.toLowerCase());
      const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, div[role="button"], span'));
      for (let i = 0; i < candidates.length; i++) {
        const el = candidates[i];
        if (el.offsetParent === null) continue;
        const text = (el.innerText || el.textContent || '').trim().toLowerCase();
        for (let j = 0; j < targets.length; j++) {
          if (text === targets[j] || (text.includes(targets[j]) && text.length < 80)) {
            const btn = el.closest('button, [role="button"], a') || el;
            btn.click();
            return true;
          }
        }
      }
      return false;
    }, labels);

    if (clicked) return true;
    if (timeoutMs <= 500) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
});

const passReauthChallenge = t('passkey.passReauth', async (page, account, options) => {
  const currentUrl = page.url();

  // 1) Re-auth mật khẩu (/signin/challenge/pwd)
  if (currentUrl.includes('/signin/challenge/pwd') || currentUrl.includes('/challenge/password')) {
    console.log('[passkey-trace] Phát hiện yêu cầu xác minh lại mật khẩu (challenge/pwd)...');
    if (!account.password) {
      throw failure('missing_password', 'Tài khoản yêu cầu xác minh mật khẩu nhưng profile chưa có mật khẩu.');
    }
    const selector = 'input[name="Passwd"][type="password"], input[type="password"]';
    const next = '#passwordNext, button[type="submit"], #next';
    await page.waitForSelector(selector, { visible: true, timeout: options.timeoutMs });
    await typeField(page, selector, account.password, options);
    console.log('[passkey-trace] Điền mật khẩu xác minh = OK');
    await clickAndWaitUrl(page, t('passkey.nextPassword', async () => {
      if (typeof page.click === 'function') {
        try { await page.click(next); return; } catch (_) {}
      }
      await page.keyboard.press('Enter');
    }), options.timeoutMs);
    return true;
  }

  // 2) Re-auth 2FA Authenticator (/challenge/totp)
  if (currentUrl.includes('/challenge/totp')) {
    console.log('[passkey-trace] Phát hiện yêu cầu xác minh lại 2FA (challenge/totp)...');
    if (!account.twofa) {
      throw failure('missing_totp', 'Tài khoản yêu cầu mã 2FA nhưng profile chưa có khóa Authenticator.');
    }
    const selector = 'input[name="totpPin"], input[id="totpPin"], input[type="tel"]';
    const next = '#totpNext, button[type="submit"], #next';
    await page.waitForSelector(selector, { visible: true, timeout: options.timeoutMs });
    const code = totp(account.twofa);
    await typeField(page, selector, code, options);
    console.log('[passkey-trace] Điền mã 2FA xác minh = OK');
    await clickAndWaitUrl(page, t('passkey.nextTotp', async () => {
      if (typeof page.click === 'function') {
        try { await page.click(next); return; } catch (_) {}
      }
      await page.keyboard.press('Enter');
    }), options.timeoutMs);
    return true;
  }

  // 3) Re-auth Passkey (/challenge/pk)
  if (currentUrl.includes('/challenge/pk')) {
    console.log('[passkey-trace] Phát hiện yêu cầu xác minh lại Passkey (challenge/pk)... Tự động bấm Continue.');
    await clickAndWaitUrl(page, t('passkey.nextPasskeyContinue', async () => {
      const clicked = await clickLabelRobust(page, PASSKEY_CONTINUE_LABELS, 8, false, options.timeoutMs);
      if (!clicked) {
        throw failure('continue_not_found', 'Không tìm thấy nút Continue trên trang xác minh Passkey.');
      }
    }), options.timeoutMs);
    return true;
  }

  return false;
});

const gotoSecurePasskeyPage = t('passkey.gotoSecurePage', async (page, account, options) => {
  console.log('[passkey-trace] 1. Điều hướng tới trang Passkey...');
  await page.goto(PASSKEY_URL, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });

  const start = Date.now();
  while (Date.now() - start < options.timeoutMs) {
    const url = page.url();
    // Đã tới trang quản lý passkeys và không còn ở màn challenge
    if (url.includes('signinoptions/passkeys') && !url.includes('/challenge/')) {
      console.log('[passkey-trace] 1.x Đã tới trang quản lý Passkey thành công.');
      await new Promise(r => setTimeout(r, 1200));
      return true;
    }

    // Nếu bị hỏi re-auth mật khẩu hoặc 2FA
    if (url.includes('/challenge/')) {
      const handled = await passReauthChallenge(page, account, options);
      if (handled) {
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
    }

    // Nếu rơi vào trang đăng nhập chính (chưa login)
    if (url.includes('/signin/identifier') || url.includes('/ServiceLogin')) {
      throw failure('not_logged_in', 'Tài khoản chưa đăng nhập Gmail. Vui lòng thực hiện Login gmail trước khi bật Passkey.');
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  throw failure('timeout', 'Hết thời gian chờ điều hướng tới trang Passkey.');
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

  // 1) Vào trang quản lý Passkey trên tab chính và vượt re-auth nếu cần
  await gotoSecurePasskeyPage(page, account, options);

  await onStatus('passkey_creating', 'Đang tạo Passkey ảo...');
  console.log('[passkey-trace] 2. Mở tab mới sạch để đăng ký Virtual Authenticator (tránh phát hiện DevTools)...');

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
      authenticatorId = va && va.authenticatorId;
      console.log(`[passkey-trace] 2.x Virtual Authenticator đã tạo: id=${authenticatorId}`);
    }

    if (!authenticatorId && typeof freshPage.addVirtualAuthenticator === 'function') {
      // Dành cho unit test / mock
      const mockAuth = await freshPage.addVirtualAuthenticator();
      authenticatorId = mockAuth && mockAuth.id;
    }

    console.log('[passkey-trace] 3. Điều hướng tab mới tới trang Passkey...');
    await freshPage.goto(PASSKEY_URL, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
    await new Promise(r => setTimeout(r, 1500));

    console.log('[passkey-trace] 4. Bấm nút "Create a passkey" / "Tạo khóa truy cập"...');
    const createClicked = await clickLabelRobust(freshPage, PASSKEY_CREATE_LABELS, 8, false, options.timeoutMs);
    if (!createClicked) {
      throw failure('create_not_found', 'Không tìm thấy nút tạo Passkey trên trang Google.');
    }

    // Chờ 2.5s để ceremony WebAuthn tự động hoàn tất nhờ automaticPresenceSimulation
    console.log('[passkey-trace] 4.x Chờ WebAuthn ceremony tự hoàn tất...');
    await new Promise(r => setTimeout(r, 2500));

    // Bấm Tiếp tục / Continue (nếu có modal xác nhận)
    console.log('[passkey-trace] 5. Bấm nút xác nhận Tiếp tục / Hoàn tất...');
    await clickLabelRobust(freshPage, PASSKEY_CONTINUE_LABELS, 4, false, options.timeoutMs);
    await new Promise(r => setTimeout(r, 1000));
    await clickLabelRobust(freshPage, PASSKEY_DONE_LABELS, 4, false, options.timeoutMs);
    await new Promise(r => setTimeout(r, 1500));

    // Lấy credential vừa tạo
    console.log('[passkey-trace] 6. Đọc credential Passkey vừa tạo qua CDP...');
    let creds = [];
    if (client && authenticatorId) {
      const maxAttempts = options.timeoutMs <= 500 ? 2 : 8;
      const retryDelay = options.timeoutMs <= 500 ? 10 : 1000;
      for (let attempt = 0; attempt < maxAttempts && !creds.length; attempt++) {
        const cr = await client.send('WebAuthn.getCredentials', { authenticatorId });
        creds = (cr && cr.credentials) || [];
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
  clickLabelRobust,
  PASSKEY_URL,
  PASSKEY_CREATE_LABELS,
  PASSKEY_CONTINUE_LABELS,
  PASSKEY_DONE_LABELS,
};
