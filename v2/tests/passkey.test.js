const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { traced: t } = require('../trace-log');
const {
  enablePasskey,
  passReauthChallenge,
  gotoSecurePasskeyPage,
  PASSKEY_URL,
} = require('../passkey');

const createFakeBrowser = t('test.fakeBrowser', (opts = {}) => {
  const browser = new EventEmitter();
  let authenticatorId = 'auth-virtual-123';
  const credentials = [{ credentialId: 'cred-abc-123', isResidentCredential: true }];

  const mainPage = new EventEmitter();
  mainPage.currentUrl = opts.initialUrl || 'https://myaccount.google.com/signinoptions/passkeys';
  mainPage.url = t('fake.mainUrl', () => mainPage.currentUrl);
  mainPage.goto = t('fake.mainGoto', async url => {
    mainPage.currentUrl = opts.gotoRedirectUrl || url;
  });
  mainPage.bringToFront = t('fake.mainBringToFront', async () => {});
  mainPage.evaluate = t('fake.mainEvaluate', async fn => {
    if (typeof fn === 'function') return fn();
    return true;
  });
  mainPage.waitForSelector = t('fake.mainWaitForSelector', async () => {});
  mainPage.typed = [];
  mainPage.keyboard = {
    press: t('fake.mainPress', async () => {}),
    type: t('fake.mainType', async char => { mainPage.typed.push(char); }),
  };

  const freshPage = new EventEmitter();
  freshPage.currentUrl = 'about:blank';
  freshPage.url = t('fake.freshUrl', () => freshPage.currentUrl);
  freshPage.goto = t('fake.freshGoto', async url => { freshPage.currentUrl = url; });
  freshPage.evaluate = t('fake.freshEvaluate', async (fn, arg) => {
    if (opts.createButtonMissing) return false;
    if (typeof fn === 'function') return true;
    return true;
  });
  freshPage.evaluateHandle = t('fake.freshEvaluateHandle', async () => ({
    asElement: () => null,
  }));
  freshPage.close = t('fake.freshClose', async () => { freshPage.closed = true; });

  const cdpSession = {
    send: t('fake.cdpSend', async (method, params) => {
      if (method === 'WebAuthn.addVirtualAuthenticator') {
        return { authenticatorId };
      }
      if (method === 'WebAuthn.getCredentials') {
        if (opts.noCredentials) return { credentials: [] };
        return { credentials };
      }
      return {};
    }),
  };

  freshPage.target = t('fake.freshTarget', () => ({
    createCDPSession: t('fake.createCDPSession', async () => cdpSession),
  }));

  browser.pages = t('fake.browserPages', async () => [mainPage]);
  browser.newPage = t('fake.browserNewPage', async () => freshPage);

  return { browser, mainPage, freshPage, cdpSession };
});

test('enablePasskey skips if account already has passkey', t('test.passkeyAlreadyEnabled', async () => {
  const { browser } = createFakeBrowser();
  const statuses = [];
  const status = (code, text) => statuses.push({ code, text });
  const result = await enablePasskey(browser, { email: 'user@gmail.com', passkey: 'existing-passkey-blob' }, status);
  assert.equal(result.status, 'already_enabled');
  assert.equal(result.passkeyBlob, 'existing-passkey-blob');
  assert.deepEqual(statuses, [{ code: 'passkey_enabled', text: 'Đã có Passkey' }]);
}));

test('enablePasskey successfully creates virtual passkey and saves credential', t('test.passkeySuccess', async () => {
  const { browser, freshPage } = createFakeBrowser();
  const statuses = [];
  const status = (code, text) => statuses.push({ code, text });

  const result = await enablePasskey(
    browser,
    { email: 'test@gmail.com', password: 'pwd', twofa: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' },
    status,
    { timeoutMs: 500, typingDelayMs: 1 }
  );

  assert.equal(result.status, 'success');
  assert.ok(result.passkeyBlob);
  const parsedCred = JSON.parse(Buffer.from(result.passkeyBlob, 'base64').toString('utf8'));
  assert.equal(parsedCred.credentialId, 'cred-abc-123');
  assert.equal(freshPage.closed, true);
  assert.deepEqual(statuses, [
    { code: 'starting', text: 'Đang kết nối...' },
    { code: 'passkey_creating', text: 'Đang tạo Passkey ảo...' },
    { code: 'passkey_enabled', text: 'Đã bật Passkey' },
  ]);
}));

test('enablePasskey fails if user is not logged in', t('test.passkeyNotLoggedIn', async () => {
  const { browser } = createFakeBrowser({ gotoRedirectUrl: 'https://accounts.google.com/ServiceLogin' });
  const statuses = [];
  const status = (code, text) => statuses.push({ code, text });

  await assert.rejects(
    enablePasskey(browser, { email: 'user@gmail.com' }, status, { timeoutMs: 300 }),
    err => err.passkeyCode === 'not_logged_in'
  );
}));

test('enablePasskey fails if create button not found', t('test.passkeyCreateNotFound', async () => {
  const { browser } = createFakeBrowser({ createButtonMissing: true });
  const statuses = [];
  const status = (code, text) => statuses.push({ code, text });

  await assert.rejects(
    enablePasskey(browser, { email: 'user@gmail.com' }, status, { timeoutMs: 500, typingDelayMs: 1 }),
    err => err.passkeyCode === 'create_not_found'
  );
}));

test('enablePasskey fails if no credentials returned from authenticator', t('test.passkeyNoCreds', async () => {
  const { browser } = createFakeBrowser({ noCredentials: true });
  const statuses = [];
  const status = (code, text) => statuses.push({ code, text });

  await assert.rejects(
    enablePasskey(browser, { email: 'user@gmail.com' }, status, { timeoutMs: 500, typingDelayMs: 1 }),
    err => err.passkeyCode === 'no_credentials'
  );
}));

test('passReauthChallenge handles password challenge', t('test.passReauthPwd', async () => {
  const page = new EventEmitter();
  page.currentUrl = 'https://accounts.google.com/signin/challenge/pwd';
  page.url = () => page.currentUrl;
  page.mainFrame = () => page;
  page.waitForSelector = async () => {};
  page.typed = [];
  page.keyboard = {
    type: async char => { page.typed.push(char); },
    press: async () => {},
  };
  page.click = async selector => {
    if (selector.includes('Next') || selector.includes('submit')) {
      page.currentUrl = 'https://myaccount.google.com/signinoptions/passkeys';
      page.emit('framenavigated', page);
    }
  };

  const handled = await passReauthChallenge(page, { password: 'my-secret-password' }, { timeoutMs: 500, typingDelayMs: 1 });
  assert.equal(handled, true);
  assert.equal(page.typed.join(''), 'my-secret-password');
}));

test('passReauthChallenge handles 2FA TOTP challenge', t('test.passReauthTotp', async () => {
  const page = new EventEmitter();
  page.currentUrl = 'https://accounts.google.com/challenge/totp';
  page.url = () => page.currentUrl;
  page.mainFrame = () => page;
  page.waitForSelector = async () => {};
  page.typed = [];
  page.keyboard = {
    type: async char => { page.typed.push(char); },
    press: async () => {},
  };
  page.click = async selector => {
    if (selector.includes('Next') || selector.includes('submit')) {
      page.currentUrl = 'https://myaccount.google.com/signinoptions/passkeys';
      page.emit('framenavigated', page);
    }
  };

  const handled = await passReauthChallenge(page, { twofa: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' }, { timeoutMs: 500, typingDelayMs: 1 });
  assert.equal(handled, true);
  assert.equal(page.typed.length, 6);
}));

test('passReauthChallenge handles recaptcha challenge', t('test.passReauthRecaptcha', async () => {
  const page = new EventEmitter();
  page.currentUrl = 'https://accounts.google.com/v3/signin/challenge/recaptcha';
  page.url = () => page.currentUrl;
  page.mainFrame = () => page;
  page.mouse = { click: async () => {} };
  page.evaluate = async (fn) => {
    if (typeof fn === 'function') {
      try { return fn(); } catch (_) { return false; }
    }
    return { x: 100, y: 100 };
  };
  const mockSolver = {
    waitForCheckState: async () => true,
    solveAndBypass: async () => {
      page.currentUrl = 'https://myaccount.google.com/signinoptions/passkeys';
      return { success: true, autoRedirected: true };
    },
  };
  let statusState = null;
  const onStatus = (s) => { statusState = s; };
  const handled = await passReauthChallenge(page, {}, { timeoutMs: 500, solver: mockSolver, onStatus });
  assert.equal(handled, true);
  assert.equal(statusState, 'recaptcha');
}));

