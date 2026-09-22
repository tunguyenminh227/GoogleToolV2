const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { ProfileStore } = require('../profile-store');
const { inspectChromium, BUNDLED_CHROMIUM, launchArgs } = require('../chromium-runtime');
const root = path.resolve(process.argv[2]);
const limit = Number(process.argv[3] || 20);
const store = new ProfileStore(path.join(root, 'data'));
const runtime = inspectChromium(BUNDLED_CHROMIUM);
if (!runtime.ready || runtime.version !== '148.0.7778.215') throw new Error('148 runtime required');
const delay = ms => new Promise(r => setTimeout(r, ms));
const file = path.join(root, 'cdp-results.json');
const report = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : { version: runtime.version, mode: 'Headful CDP diagnostic; may affect detection', results: [] };
async function run(profile, index) {
  const output = path.join(root, `cdp-${String(index).padStart(2, '0')}`);
  fs.mkdirSync(output, { recursive: true });
  const dir = store.directory(profile.id);
  const args = launchArgs(dir, 'https://iphey.com/', profile.fingerprint);
  args[args.length - 1] = 'https://www.browserscan.net/';
  const child = spawn(BUNDLED_CHROMIUM, ['--remote-debugging-port=0', ...args], { windowsHide: true, stdio: 'ignore' });
  let ws, send;
  try {
    let page;
    for (let i = 0; i < 120; i++) {
      try {
        const port = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0];
        const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json();
        page = pages.find(p => p.type === 'page');
        if (page) break;
      } catch {}
      if (child.exitCode !== null) throw new Error(`Browser exited ${child.exitCode}`);
      await delay(500);
    }
    if (!page) throw new Error('Browser unavailable');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    let id = 0; const pending = new Map();
    ws.on('message', raw => { const m = JSON.parse(raw); const p = pending.get(m.id); if (p) { pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
    send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; const timer = setTimeout(() => { pending.delete(n); reject(new Error(`Timeout ${method}`)); }, 15000); pending.set(n, { resolve, reject, timer }); ws.send(JSON.stringify({ id: n, method, params })); });
    await send('Page.enable');
    await send('Page.navigate', { url: 'https://www.browserscan.net/' });
    await delay(35000);
    const r = await send('Runtime.evaluate', { expression: '({url:location.href,text:document.body.innerText})', returnByValue: true });
    if (r.exceptionDetails) throw new Error('Page evaluation failed');
    const text = r.result.value.text;
    fs.writeFileSync(path.join(output, 'page.txt'), text);
    const pic = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(output, 'page.png'), Buffer.from(pic.data, 'base64'));
    const match = text.match(/Browser fingerprint authenticity\s*:?\s*(\d{1,3})\s*%/i);
    const score = match ? Number(match[1]) : null;
    const timezoneWarning = /Different time zones/i.test(text);
    const ipWarning = /IP addresses are different/i.test(text);
    return { index, profileId: profile.id, seed: profile.fingerprint.seed, score, output, checkedAt: new Date().toISOString(),
      timezoneWarning, ipWarning, canvasWarning: /Canvas Tampering/i.test(text), webglWarning: /WebGL exception/i.test(text),
      botDetection: text.match(/Bot Detection:\s*\n([^\n]+)/i)?.[1] || null,
      scoreExcludingTimezoneAndIp: score === null ? null : Math.min(100, score + (timezoneWarning ? 10 : 0) + (ipWarning ? 10 : 0)) };
  } finally {
    if (send) await send('Browser.close').catch(() => {});
    ws?.close();
    if (child.exitCode === null) {
      await Promise.race([new Promise(r => child.once('exit', r)), delay(5000)]);
      if (child.exitCode === null) child.kill();
    }
  }
}
(async () => {
  for (const [i, profile] of store.list().slice(0, limit).entries()) {
    if (report.results.some(r => r.index === i + 1 && r.score !== null)) continue;
    let result;
    try { result = await run(profile, i + 1); }
    catch (e) { result = { index: i + 1, score: null, error: e.message }; }
    report.results = report.results.filter(r => r.index !== i + 1); report.results.push(result);
    fs.writeFileSync(file, JSON.stringify(report, null, 2)); console.log(JSON.stringify(result));
    if (result.score === null) break;
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
