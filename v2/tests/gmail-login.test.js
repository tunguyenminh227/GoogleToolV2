const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { traced: t } = require('../trace-log');
const { classify, totp, login, clickAndWaitUrl } = require('../gmail-login');

test('rejected sign-in stops with a safe error after email navigation', t('test.gmailRejected', async () => {
  const url = 'https://accounts.google.com/v3/signin/rejected?TL=fixture-secret&flowEntry=ServiceLogin';
  assert.equal(classify(url), 'rejected');
  assert.equal(classify('https://accounts.google.com.evil.example/v3/signin/rejected'), 'manual');
  const page = fakePage([url]);
  let closed = 0;
  page.browser = t('fake.rejectedBrowser', () => ({ close: t('fake.closeRejected', async () => { closed++; }) }));
  const states = [];
  await assert.rejects(login(page, { email: 'fake@example.com', password: 'unused-password' },
    t('fake.rejectedStatus', state => states.push(state)), { timeoutMs: 100 }), {
    loginCode: 'rejected', message: 'Google đã từ chối đăng nhập (signin/rejected).'
  });
  assert.deepEqual(states, ['starting', 'email']);
  assert.equal(closed, 1, 'Close the rejected profile browser exactly once');
  assert.equal(page.typed.map(t('fake.typedCharacter', entry => entry.character)).join(''), 'fake@example.com');
}));

test('verify phone challenge stops with a safe error and closes browser', t('test.gmailVerifyPhone', async () => {
  const url = 'https://accounts.google.com/v3/signin/challenge/iap?TL=fixture-secret&flowEntry=ServiceLogin';
  assert.equal(classify(url), 'verify_phone');
  assert.equal(classify('https://accounts.google.com.evil.example/v3/signin/challenge/iap'), 'manual');
  const page = fakePage([url]);
  let closed = 0;
  page.browser = t('fake.verifyPhoneBrowser', () => ({ close: t('fake.closeVerifyPhone', async () => { closed++; }) }));
  const states = [];
  await assert.rejects(login(page, { email: 'fake@example.com', password: 'unused-password' },
    t('fake.verifyPhoneStatus', state => states.push(state)), { timeoutMs: 100 }), {
    loginCode: 'verify_phone', message: 'Google yêu cầu xác minh số điện thoại (verify phone).'
  });
  assert.deepEqual(states, ['starting', 'email']);
  assert.equal(closed, 1, 'Close the verify phone profile browser exactly once');
  assert.equal(page.typed.map(t('fake.typedCharacter', entry => entry.character)).join(''), 'fake@example.com');
}));

test('Gmail URL classification trusts only HTTPS Google hosts and RFC TOTP is correct', t('test.gmailClassification', () => {
  assert.equal(classify('https://accounts.google.com/v3/signin/challenge/pwd'), 'password');
  assert.equal(classify('https://accounts.google.com/signin/v2/challenge/totp'), 'totp');
  assert.equal(classify('https://accounts.google.com/signin/v2/challenge/kpe'), 'recovery');
  assert.equal(classify('https://accounts.google.com/v3/signin/challenge/recaptcha'), 'recaptcha');
  assert.equal(classify('https://accounts.google.com/v3/signin/challenge/iap'), 'verify_phone');
  assert.equal(classify('https://mail.google.com.evil.example/mail/u/0/'), 'manual');
  assert.equal(classify('http://accounts.google.com/v3/signin/identifier'), 'manual');
  assert.equal(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59000), '287082');
}));

const fakePage = t('test.fakePage', (destinations = []) => {
  const page = new EventEmitter();
  page.currentUrl = 'https://accounts.google.com/v3/signin/identifier';
  page.url = t('fake.url', () => page.currentUrl);
  page.mainFrame = t('fake.mainFrame', () => page);
  page.goto = t('fake.goto', async url => { page.startedAt = url; });
  page.evaluate = t('fake.evaluate', async script => {
    if (typeof script === 'string' && script.includes('getBoundingClientRect')) {
      return { x: 128, y: 250 };
    }
    return true;
  });
  page.waitForSelector = t('fake.selector', async () => {});
  page.waitForFunction = t('fake.visiblePassword', async () => null);
  page.typed = [];
  page.mouseClicked = [];
  page.mouse = { click: t('fake.mouseClick', async (x, y) => { page.mouseClicked.push({ x, y }); }) };
  page.keyboard = { press: t('fake.press', async () => {}), type: t('fake.type', async (character, options) => { page.typed.push({ character, delay: options.delay }); }) };
  page.click = t('fake.click', async selector => {
    if (!/^#(?:identifier|password|knowledgePreregisteredEmail|totp|recaptcha)Next/.test(selector) && !selector.includes('recaptchaNext')) return;
    const next = destinations.shift();
    if (next) { page.currentUrl = next; page.emit('framenavigated', page); }
  });
  return page;
});
test('navigation to password during checkbox waiting closes a profile without password', t('test.checkboxNavigationClose', async () => {
  const page = fakePage();
  page.currentUrl = 'https://accounts.google.com/v3/signin/challenge/recaptcha';
  let closed = false;
  page.browser = t('fake.navigationBrowser', () => ({ close: t('fake.navigationClose', async () => { closed = true; }) }));
  const solver = {
    waitForCheckState: t('fake.navigationWait', async evaluate => {
      page.currentUrl = 'https://accounts.google.com/v3/signin/challenge/pwd';
      page.emit('framenavigated', page);
      await evaluate('document.title');
      assert.fail('Old-page waiting must stop');
    }),
    detect: t('fake.noDetectionAfterNavigation', () => assert.fail('Already on password page')),
  };
  assert.equal((await login(page, { email: 'fake@example.com' }, t('fake.navigationStatus', () => {}), { solver, timeoutMs: 100 })).status, 'password_reached');
  assert.equal(closed, true);
  assert.equal(page.listenerCount('framenavigated'), 0);
}));
test('login follows immediate URL events and types each character with configured delay', t('test.gmailFlow', async () => {
  const page = fakePage(['https://accounts.google.com/v3/signin/challenge/pwd', 'https://accounts.google.com/v3/signin/challenge/kpe', 'https://accounts.google.com/v3/signin/challenge/totp', 'https://mail.google.com/mail/u/0/#inbox']);
  const states = [];
  const result = await login(page, { email: 'fake@example.com', password: 'fake-pass', recoveryMail: 'recovery@example.com', twofa: 'JBSWY3DPEHPK3PXP' }, t('fake.status', status => states.push(status)), { typingDelayMs: 17, timeoutMs: 100 });
  assert.equal(result.status, 'success');
  assert.equal(new URL(page.startedAt).searchParams.has('Email'), false);
  assert.ok(!page.startedAt.includes('fake%40example.com'));
  assert.deepEqual(states, ['starting', 'email', 'password', 'recovery', 'totp', 'inbox', 'success']);
  assert.ok(page.typed.every(t('test.typingDelay', entry => entry.character.length === 1 && entry.delay === 17)));
  assert.equal(page.listenerCount('framenavigated'), 0);
}));
test('unchanged URL times out without advancing, and click failure removes listeners', t('test.gmailUrlFailure', async () => {
  const page = fakePage();
  await assert.rejects(clickAndWaitUrl(page, t('fake.noNavigation', async () => {}), 5), { loginCode: 'url_unchanged' });
  assert.equal(page.listenerCount('framenavigated'), 0);
  await assert.rejects(clickAndWaitUrl(page, t('fake.clickError', async () => { throw new Error('click failed'); }), 100));
  assert.equal(page.listenerCount('close'), 0);
}));

test('login navigation timeout marks error and closes the browser', t('test.loginTimeoutClose', async () => {
  const page = fakePage();
  const states = [];
  let closed = 0;
  page.browser = t('fake.timeoutBrowser', () => ({ close: t('fake.timeoutClose', async () => { closed++; }) }));
  await assert.rejects(login(page, { email: 'fake@example.com' }, t('fake.timeoutStatus', state => states.push(state)), { timeoutMs: 5 }), { loginCode: 'timeout' });
  assert.equal(closed, 1);
  assert.equal(states.at(-1), 'error');
  assert.equal(page.listenerCount('framenavigated'), 0);
}));

test('password visibility timeout closes the browser with an error', t('test.passwordNotVisible', async () => {
  const page = fakePage();
  page.currentUrl = 'https://accounts.google.com/v3/signin/challenge/pwd';
  page.waitForFunction = t('fake.hiddenPassword', async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); });
  let closed = 0;
  page.browser = t('fake.hiddenBrowser', () => ({ close: t('fake.hiddenClose', async () => { closed++; }) }));
  await assert.rejects(login(page, { email: 'fake@example.com' }, t('fake.hiddenStatus', () => {}), { timeoutMs: 100 }), { loginCode: 'timeout' });
  assert.equal(closed, 1);
}));

test('password disappears during grace period keeps browser open', t('test.passwordDisappears', async () => {
  const page = fakePage();
  page.currentUrl = 'https://accounts.google.com/v3/signin/challenge/pwd';
  page.evaluate = t('fake.passwordDisappeared', async () => false);
  page.browser = t('fake.noCloseAfterDisappearing', () => assert.fail('Do not close after password disappears'));
  await assert.rejects(login(page, { email: 'fake@example.com' }, t('fake.disappearedStatus', () => {}), { timeoutMs: 100 }), { loginCode: 'manual' });
}));

test('unverified account and missing password stop without claiming success', t('test.gmailManual', async () => {
  const page = fakePage();
  page.currentUrl = 'https://mail.google.com/mail/u/0/#inbox';
  page.evaluate = t('fake.wrongAccount', async () => false);
  const statuses = [];
  await assert.rejects(login(page, { email: 'fake@example.com' }, t('fake.manualStatus', state => statuses.push(state)), { timeoutMs: 100 }), { loginCode: 'manual' });
  assert.ok(!statuses.includes('success'));
  page.currentUrl = 'https://accounts.google.com/v3/signin/challenge/pwd';
  page.evaluate = t('fake.passwordVisible', async () => true);
  let closed = false;
  let visibleAt;
  page.waitForSelector = t('fake.waitPasswordVisible', async (selector, options) => {
    assert.equal(selector, 'input[name="Passwd"][type="password"]');
    assert.equal(options.visible, true);
    await new Promise(t('fake.delayedPassword', resolve => setTimeout(resolve, 200)));
    visibleAt = Date.now();
  });
  page.browser = t('fake.browser', () => ({ close: t('fake.close', async () => {
    assert.ok(visibleAt && Date.now() - visibleAt >= 2900, 'Wait three seconds after password input becomes visible');
    closed = true;
  }) }));
  const terminalStates = [];
  const result = await login(page, { email: 'fake@example.com' }, t('fake.terminalStatus', state => terminalStates.push(state)), { timeoutMs: 100 });
  assert.equal(result.status, 'password_reached');
  assert.deepEqual(terminalStates, ['starting', 'password', 'password_reached']);
  assert.equal(closed, true);
  assert.equal(page.typed.length, 0);
}));

test('handles recaptcha challenge by clicking checkbox and solving via twoCaptcha without clicking next button', t('test.gmailRecaptcha', async () => {
  const destinations = [
    'https://accounts.google.com/v3/signin/challenge/recaptcha',
    'https://accounts.google.com/v3/signin/challenge/pwd',
    'https://mail.google.com/mail/u/0/#inbox'
  ];
  const page = fakePage(destinations);
  const clickedSelectors = [];
  const originalClick = page.click;
  page.click = t('fake.trackingClick', async selector => {
    clickedSelectors.push(selector);
    return originalClick(selector);
  });

  const mockSolver = {
    waitForCheckState: t('fake.waitForCheckState', async () => false),
    detect: t('fake.detect', async () => ({ detected: true, siteKey: 'fake-key', pageUrl: page.url() })),
    solveRecaptchaV2: t('fake.solveRecaptchaV2', async () => ({ success: true, token: 'fake-token' })),
    injectToken: t('fake.injectToken', async () => {
      // Google tự động chuyển sang trang mật khẩu sau khi nhận callback/token
      const next = destinations.shift();
      if (next) {
        page.currentUrl = next;
        page.emit('framenavigated', page);
      }
      return 'ok';
    }),
  };
  const states = [];
  const result = await login(
    page,
    { email: 'fake@example.com', password: 'fake-pass' },
    t('fake.statusRecaptcha', status => states.push(status)),
    { typingDelayMs: 10, timeoutMs: 100, solver: mockSolver }
  );
  assert.equal(result.status, 'success');
  assert.deepEqual(states, ['starting', 'email', 'recaptcha', 'password', 'inbox', 'success']);
  assert.equal(page.mouseClicked.length, 1);
  assert.deepEqual(page.mouseClicked[0], { x: 128, y: 250 });
  // Đảm bảo không bấm bất kỳ nút nào ở bước recaptcha
  assert.ok(!clickedSelectors.some(s => s.includes('recaptcha')));
}));
