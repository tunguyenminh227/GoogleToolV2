const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');
const engine = require('../engine-config');
const { traced: t } = require('../trace-log');
const { typeField } = require('../gmail-login');
const run = t('probe.email', async () => {
  const root = fs.mkdtempSync(path.join(__dirname, '..', 'artifacts', 'gmail-email-probe-'));
  const browser = await puppeteer.launch({ executablePath: engine.executable, ignoreDefaultArgs: true, headless: false, pipe: true,
    args: [`--user-data-dir=${path.join(root, 'profile')}`, '--no-first-run', 'about:blank'], defaultViewport: null });
  try {
    const page = (await browser.pages())[0];
    await page.goto('https://accounts.google.com/ServiceLogin?service=mail&continue=https%3A%2F%2Fmail.google.com%2Fmail%2F', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const report = await page.evaluate(() => ({ path: location.pathname, inputs: [...document.querySelectorAll('input')].map(n => ({ id: n.id, type: n.type, name: n.name, visible: !!(n.offsetWidth || n.offsetHeight) })) }));
    console.log(JSON.stringify(report));
    await page.waitForSelector('#identifierId', { visible: true, timeout: 15000 });
    console.log('EMAIL_FIELD_READY');
    await typeField(page, '#identifierId', 'typing-check@example.invalid', { typingDelayMs: 90, timeoutMs: 10000 });
    const typedLength = await page.$eval('#identifierId', element => element.value.length);
    if (typedLength !== 'typing-check@example.invalid'.length) throw new Error('Typing failed');
    console.log('EMAIL_TYPING_PASS_NO_SUBMISSION');
  } finally { await browser.close(); }
});
run().catch(t('probe.error', error => { console.error(error.name); process.exitCode = 1; }));
