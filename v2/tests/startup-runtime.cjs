const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer-core');
const engine = require('../engine-config');
const { ProfileStore } = require('../profile-store');
const { traced: t } = require('../trace-log');
const { initializeStartup } = require('../profile-startup');
const run = t('test.startupRuntime', async () => {
  const root = fs.mkdtempSync(path.join(__dirname, '..', 'artifacts', 'startup-runtime-'));
  const store = new ProfileStore(root);
  const profile = store.create({ name: 'Startup fixture' });
  await initializeStartup(profile.id, engine.executable, store.directory(profile.id));
  const browser = await puppeteer.launch({ executablePath: engine.executable, ignoreDefaultArgs: true, headless: false, pipe: true,
    args: [`--user-data-dir=${store.directory(profile.id)}`, '--no-first-run', '--no-default-browser-check', 'chrome://settings/onStartup'], defaultViewport: null });
  try {
    const page = (await browser.pages())[0];
    await page.goto('chrome://version');
    console.log('PROFILE_PATH', await page.$eval('#profile_path', node => node.textContent));
    await page.goto('chrome://settings/onStartup');
    const value = await page.evaluate(() => new Promise(resolve => chrome.settingsPrivate.getPref('session.restore_on_startup', pref => resolve(pref.value))));
    assert.equal(value, 1);
    assert.equal(await page.evaluate(() => new Promise(resolve => chrome.settingsPrivate.getPref('session.restore_on_startup', pref => resolve(pref.value)))), 1);
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ status: 'pass', restoreOnStartup: value, version: engine.version }));
    console.log('STARTUP_RUNTIME_PASS', root);
  } finally { await browser.close(); }
});
run().catch(t('test.startupFailed', error => { console.error(error.message); process.exitCode = 1; }));
