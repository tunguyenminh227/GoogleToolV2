const puppeteer = require('puppeteer-core');
const trace = require('./trace-log');

// Let Chromium write its protected preference and integrity metadata itself.
const initializeStartup = trace.traced('profile.initializeStartup', async (id, executablePath, directory) => {
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath, ignoreDefaultArgs: true, pipe: true, defaultViewport: null,
      args: [`--user-data-dir=${directory}`, '--headless=new', '--no-first-run', '--no-default-browser-check', 'about:blank'], timeout: 30000 });
    const page = (await browser.pages())[0];
    await page.goto('chrome://settings/onStartup', { waitUntil: 'load', timeout: 15000 });
    const saved = await page.evaluate(() => new Promise(resolve => chrome.settingsPrivate.setPref('session.restore_on_startup', 1, '', resolve)));
    if (!saved) throw new Error('Startup preference rejected');
    const value = await page.evaluate(() => new Promise(resolve => chrome.settingsPrivate.getPref('session.restore_on_startup', pref => resolve(pref.value))));
    if (value !== 1) throw new Error('Startup preference not applied');
    // Do not restore the setup page when the user first opens this profile.
    await page.goto('about:blank');
  } finally { if (browser) await browser.close(); }
}, { profileArgument: 0 });
module.exports = { initializeStartup };
