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
const root = fs.mkdtempSync(path.join(__dirname, '../artifacts/cookies149-'));
const store = new ProfileStore(path.join(root, 'data'));
const profiles = [store.create({ name: 'Cookie A' }), store.create({ name: 'Cookie B' })];
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
  console.log(`COOKIE_TEST ${root}`);
  const runtime = inspectChromium(BUNDLED_CHROMIUM);
  assert.equal(runtime.ready, true, runtime.error);
  report.version = runtime.version;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  await run(profiles[0], '/set', async (cookies, visible) => {
    assert.equal(cookies.length, 3);
    assert.ok(cookies.find(c => c.name === 'httponly_probe').httpOnly);
    assert.ok(!visible.includes('httponly_probe'));
    report.checks.cookiesCreated = true;
    report.checks.httpOnlyHiddenFromJavascript = true;
  });
  await run(profiles[1], '/read', async cookies => {
    assert.equal(cookies.length, 0);
    report.checks.isolatedBetweenProfiles = true;
  });
  await run(profiles[0], '/read', async (cookies, visible, send) => {
    for (const name of ['persistent_probe', 'httponly_probe']) assert.equal(cookies.find(c => c.name === name)?.value, 'local-test');
    report.checks.persistentCookiesSurviveRestart = true;
    report.sessionCookieRestored = cookies.some(c => c.name === 'session_probe');
    await send('Network.deleteCookies', { name: 'persistent_probe', url: base });
  });
  await run(profiles[0], '/read', async cookies => {
    assert.ok(!cookies.some(c => c.name === 'persistent_probe'));
    assert.ok(cookies.some(c => c.name === 'httponly_probe'));
    report.checks.deletionSurvivesRestart = true;
  });
  report.passed = true;
})().catch(error => { report.passed = false; report.error = error.stack; process.exitCode = 1; }).finally(() => {
  server.close();
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
});
