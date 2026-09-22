const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');
const engine = require('../engine-config');
const { traced: t } = require('../trace-log');
const run = t('probe.resolution', async () => {
  const root = fs.mkdtempSync(path.join(__dirname, '..', 'artifacts', 'resolution-'));
  const cases = [
    ['baseline', []],
    ['window1280', ['--window-size=1280,720']],
    ['fingerprint1280', ['--fingerprint-screen-width=1280', '--fingerprint-screen-height=720']],
    ['window1280_scale1', ['--window-size=1280,720', '--force-device-scale-factor=1']],
  ];
  const results = [];
  for (const [name, flags] of cases) {
    const browser = await puppeteer.launch({ executablePath: engine.executable, ignoreDefaultArgs: true, pipe: true, headless: false, defaultViewport: null,
      args: [`--user-data-dir=${path.join(root, name)}`, '--no-first-run', '--no-default-browser-check', '--fingerprint=123456', ...flags, 'about:blank'] });
    try {
      const page = (await browser.pages())[0];
      const metrics = await page.evaluate(() => ({ screen: [screen.width, screen.height], available: [screen.availWidth, screen.availHeight], outer: [outerWidth, outerHeight], inner: [innerWidth, innerHeight], dpr: devicePixelRatio, device1280: matchMedia('(device-width: 1280px)').matches }));
      results.push({ name, flags, ...metrics });
    } finally { await browser.close(); }
  }
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ engine: engine.version, results }, null, 2));
  console.log(JSON.stringify({ root, results }, null, 2));
});
run().catch(t('probe.failed', error => { console.error(error.message); process.exitCode = 1; }));
