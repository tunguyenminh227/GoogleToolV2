const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer-core');
const engine = require('../engine-config');
const trace = require('../trace-log');
const { login, typeField } = require('../gmail-login');
const root = fs.mkdtempSync(path.join(__dirname, '..', 'artifacts', 'gmail-runtime-'));
trace.configure(path.join(root, 'logs'));

const run = trace.traced('test.gmailRuntime', async () => {
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath: engine.executable, headless: false, ignoreDefaultArgs: true,
      args: [`--user-data-dir=${path.join(root, 'profile')}`, '--no-first-run', '--no-default-browser-check', 'about:blank'],
      pipe: true, defaultViewport: null, timeout: 30000 });
    const page = (await browser.pages())[0];
    await page.setRequestInterception(true);
    page.on('request', trace.traced('test.fixtureRequest', async request => {
      const url = new URL(request.url());
      const steps = {
        '/ServiceLogin': ['id="identifierId" name="identifier" type="text"', 'identifierNext', '/v3/signin/challenge/pwd'],
        '/v3/signin/challenge/pwd': ['name="Passwd" type="password"', 'passwordNext', '/v3/signin/challenge/kpe'],
        '/v3/signin/challenge/kpe': ['name="knowledgePreregisteredEmailResponse"', 'knowledgePreregisteredEmailNext', '/v3/signin/challenge/totp'],
        '/v3/signin/challenge/totp': ['name="totpPin"', 'totpNext', 'https://mail.google.com/mail/u/0/#inbox'],
      };
      if (!request.isNavigationRequest()) return request.respond({ status: 204, body: '' });
      const step = steps[url.pathname];
      const body = step ? `<html><body><input ${step[0]}><button id="${step[1]}" onclick="location.href='${step[2]}'">Next</button><script>window.inputEvents=[];document.querySelector('input').addEventListener('input',event=>inputEvents.push({length:event.target.value.length,time:performance.now(),trusted:event.isTrusted}));</script></body></html>` : '<html><body><main role="main" data-email="fixture@example.com">Fake inbox</main></body></html>';
      await request.respond({ status: 200, contentType: 'text/html', body });
    }));
    await page.goto('https://accounts.google.com/ServiceLogin', { waitUntil: 'domcontentloaded' });
    await typeField(page, '#identifierId', 'a@b.co', { typingDelayMs: 90, timeoutMs: 10000 });
    const inputEvents = await page.evaluate(() => window.inputEvents);
    const typed = inputEvents.filter(trace.traced('test.nonemptyInput', event => event.length > 0));
    assert.deepEqual(typed.map(trace.traced('test.inputLength', event => event.length)), [1, 2, 3, 4, 5, 6]);
    assert.ok(typed.every(trace.traced('test.inputDelay', (event, index) => event.trusted && (!index || event.time - typed[index - 1].time >= 60))));
    const statuses = [];
    const result = await trace.withProfile('cccccccc-cccc-cccc-cccc-cccccccccccc', trace.traced('test.profileLogin', () => login(page,
      { email: 'fixture@example.com', password: 'fake-password', recoveryMail: 'recovery@example.com', twofa: 'JBSWY3DPEHPK3PXP' },
      trace.traced('test.status', status => statuses.push(status)), { typingDelayMs: 15, timeoutMs: 10000 })));
    assert.equal(result.status, 'success');
    assert.deepEqual(statuses, ['starting', 'email', 'password', 'recovery', 'totp', 'inbox', 'success']);
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ engine: engine.version, status: 'pass', statuses, inputEvents, note: 'Real Chromium, intercepted fixture pages only; no real account login.' }, null, 2));
    console.log('GMAIL_RUNTIME_PASS', root);
  } finally { if (browser) await browser.close(); }
});
run().catch(trace.traced('test.failed', error => { console.error(error.message); process.exitCode = 1; }));
