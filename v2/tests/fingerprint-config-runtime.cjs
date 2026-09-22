// Controlled cookies on localhost only; never reads real account cookies.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const WebSocket = require('ws');
const { ProfileStore } = require('../profile-store');
const { BUNDLED_CHROMIUM, inspectChromium, launchArgs } = require('../chromium-runtime');
const delay = ms => new Promise(r => setTimeout(r, ms));
const root = fs.mkdtempSync(path.join(__dirname, '../artifacts/fingerprint-config-'));
const store = new ProfileStore(path.join(root, 'data'));
const profiles = [store.create({ name: 'Config test', fingerprint: { locale: 'vi-VN', timezone: 'UTC', hardwareConcurrency: 4, gpu: 'real', canvas: 'off', audio: 'off', clientrects: 'off', font: 'off' } })];
profiles.push(store.create({ name: 'Config test second seed', fingerprint: profiles[0].fingerprint }));
const report = { checkedAt: new Date().toISOString(), checks: {} };
const server = http.createServer((req, res) => {
  if (req.url === '/set') res.setHeader('Set-Cookie', [
    'persistent_probe=local-test; Max-Age=86400; Path=/; SameSite=Lax',
    'httponly_probe=local-test; Max-Age=86400; Path=/; HttpOnly; SameSite=Lax',
    'session_probe=local-test; Path=/; SameSite=Lax'
  ]);
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><title>Local cookie test</title>Cookie persistence test');
});
async function run(profile, route, callback) {
  const dir = store.directory(profile.id);
  const args = launchArgs(dir, 'https://iphey.com/', profile.fingerprint);
  args[args.length - 1] = base + route;
  const child = spawn(BUNDLED_CHROMIUM, ['--remote-debugging-port=0', ...args], { windowsHide: true, stdio: 'ignore' });
  const exited = once(child, 'exit');
  let ws, send;
  try {
    let page;
    for (let i = 0; i < 120; i++) {
      if (child.exitCode !== null) throw new Error(`Browser exited: ${child.exitCode}`);
      try {
        const port = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0];
        const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json();
        page = pages.find(p => p.type === 'page');
        if (page) break;
      } catch {}
      await delay(500);
    }
    if (!page) throw new Error('Browser not ready');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await once(ws, 'open');
    let id = 0;
    const pending = new Map();
    ws.on('message', raw => { const m = JSON.parse(raw); const p = pending.get(m.id); if (p) { pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
    send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; const timer = setTimeout(() => { pending.delete(n); reject(new Error(`Timeout ${method}`)); }, 10000); pending.set(n, { resolve, reject, timer }); ws.send(JSON.stringify({ id: n, method, params })); });
    await send('Page.enable');
    await send('Page.navigate', { url: base + route });
    await delay(1000);
    const { cookies } = await send('Network.getCookies', { urls: [base] });
    const visible = await send('Runtime.evaluate', { expression: 'document.cookie', returnByValue: true });
    await callback(cookies, visible.result.value, send);
  } finally {
    if (send) await send('Browser.close').catch(() => {});
    ws?.close();
    if (child.exitCode === null) {
      let timer;
      await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { child.kill(); resolve(); }, 10000); })]);
      clearTimeout(timer);
      await exited;
    }
  }
}
let base;
(async () => {
  assert.equal(inspectChromium(BUNDLED_CHROMIUM).ready, true);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  report.runs = [];
  for (const profile of profiles) await run(profile, '/read', async (_cookies, _visible, send) => {
    const r = await send('Runtime.evaluate', { expression: `(()=>{const gl=document.createElement('canvas').getContext('webgl');const e=gl.getExtension('WEBGL_debug_renderer_info');return {language:navigator.language,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,cpu:navigator.hardwareConcurrency,width:screen.width,height:screen.height,gpu:gl.getParameter(e.UNMASKED_RENDERER_WEBGL)}})()`, returnByValue:true });
    report.actual = r.result.value;
    assert.equal(report.actual.language, 'vi-VN');
    assert.equal(report.actual.timezone, 'UTC');
    assert.equal(report.actual.cpu, 4);
    const pixels = await send('Runtime.evaluate', { expression: `(()=>{const c=document.createElement('canvas');c.width=120;c.height=40;const x=c.getContext('2d');x.fillText('Config test',5,20);return c.toDataURL()})()`, returnByValue:true });
    report.runs.push({ ...report.actual, seed: profile.fingerprint.seed, canvasHash: require('node:crypto').createHash('sha256').update(pixels.result.value).digest('hex') });
  });
  assert.notEqual(report.runs[0].seed, report.runs[1].seed);
  assert.equal(report.runs[0].canvasHash, report.runs[1].canvasHash);
  assert.equal(report.runs[0].gpu, report.runs[1].gpu);
  report.passed=true;
})().catch(e=>{report.error=e.stack;process.exitCode=1;}).finally(()=>{server.close();fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(report,null,2));console.log(root,JSON.stringify(report));});
