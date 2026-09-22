const { app, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer-core');
const engine = require('../engine-config');
const { gridBounds } = require('../window-layout');
const { traced: t } = require('../trace-log');
app.whenReady().then(t('test.windowLayout', async () => {
  const root = fs.mkdtempSync(path.join(__dirname, '..', 'artifacts', 'window-layout-'));
  const browsers = [], results = [];
  try {
    const area = screen.getPrimaryDisplay().workArea;
    for (let slot = 0; slot < 4; slot++) {
      const bounds = gridBounds(area, 4, slot);
      const browser = await puppeteer.launch({ executablePath: engine.executable, headless: false, ignoreDefaultArgs: true, pipe: true, defaultViewport: null,
        args: [`--user-data-dir=${path.join(root, String(slot))}`, '--no-first-run', '--no-default-browser-check', `--window-size=${bounds.width},${bounds.height}`, `--window-position=${bounds.x},${bounds.y}`, 'about:blank'] });
      browsers.push(browser);
      const page = (await browser.pages())[0];
      const cdp = await page.target().createCDPSession();
      const actual = (await cdp.send('Browser.getWindowForTarget')).bounds;
      assert.ok(Math.abs(actual.left - bounds.x) <= 2, 'Horizontal position must match the assigned slot');
      assert.ok(Math.abs(actual.top - bounds.y) <= 2, 'Vertical position must match the assigned slot');
      assert.ok(Math.abs(actual.height - bounds.height) <= 2, 'Window height must match v1');
      results.push(actual);
    }
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ area, results }, null, 2));
    console.log('WINDOW_LAYOUT_RESULT', root);
    console.log('WINDOW_LAYOUT_PASS', root);
  } finally { for (const browser of browsers) await browser.close(); }
})).then(t('test.exit', () => app.exit(0))).catch(t('test.failed', error => { console.error(error.message); app.exit(1); }));
