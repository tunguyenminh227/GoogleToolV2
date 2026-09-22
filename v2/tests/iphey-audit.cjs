// Online, headful diagnostic. Uses two NEW test profiles, never production data.
// No fingerprint overrides. CDP is used only to read results and take screenshots.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');
const { createHash } = require('node:crypto');
const WebSocket = require('ws');
const { BUNDLED_CHROME, inspectChrome, launchArgs } = require('../chrome-runtime');
const { ProfileStore } = require('../profile-store');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = fs.mkdtempSync(path.join(__dirname, '..', 'artifacts', 'iphey-'));
console.log(`Audit folder: ${root}`);
const store = new ProfileStore(path.join(root, 'data'));

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let sequence = 0;
  const pending = new Map();
  const failAll = () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('CDP disconnected')); } pending.clear(); };
  socket.on('close', failAll);
  socket.on('error', failAll);
  socket.on('message', raw => {
    const message = JSON.parse(raw);
    const item = pending.get(message.id);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(message.id);
    if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result);
  });
  return {
    close: () => socket.close(),
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    }),
  };
}

const expression = `(async () => {
  const canvas = document.createElement('canvas'); canvas.width = 280; canvas.height = 80;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f60'; ctx.fillRect(10, 10, 100, 40);
  ctx.font = '18px Arial'; ctx.fillStyle = '#069'; ctx.fillText('GoogleTool fingerprint check', 3, 45);
  const gl = document.createElement('canvas').getContext('webgl');
  const extension = gl && gl.getExtension('WEBGL_debug_renderer_info');
  return {
    url: location.href, title: document.title, text: document.body.innerText,
    fingerprint: {
      userAgent: navigator.userAgent, platform: navigator.platform,
      languages: navigator.languages, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory,
      screen: { width: screen.width, height: screen.height, depth: screen.colorDepth },
      webdriver: navigator.webdriver,
      canvasData: canvas.toDataURL(),
      webglVendor: extension ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL) : null,
      webglRenderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null
    }
  };
})()`;

async function audit(index) {
  const profile = store.create({ name: `IPhey test ${index}` });
  const port = await availablePort();
  const args = launchArgs(store.directory(profile.id), 'https://iphey.com/');
  args.unshift(`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1');
  const child = spawn(BUNDLED_CHROME, args, { stdio: 'ignore', windowsHide: true, shell: false });
  let spawnError;
  child.on('error', error => { spawnError = error; });
  let cdp;
  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Chrome exited: ${child.exitCode}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
        const pages = await response.json();
        const page = pages.find(p => p.type === 'page' && p.url.includes('iphey.com'));
        if (page) { cdp = await connect(page.webSocketDebuggerUrl); break; }
      } catch (_) {}
      await delay(500);
    }
    if (!cdp) throw new Error('Cannot attach to test Chrome');
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.bringToFront');
    const navigation = await cdp.send('Page.navigate', { url: 'https://iphey.com/' });
    fs.writeFileSync(path.join(root, `profile-${index}-navigation.json`), JSON.stringify(navigation, null, 2));
    console.log(`Profile ${index}: Chrome ready; waiting for IPhey results.`);
    await delay(40000);
    const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    const report = { checkedAt: new Date().toISOString(), profileId: profile.id, ...result.result.value };
    const scoreMatch = report.text.match(/(?:^|\n)(\d{1,3})\s*\nMX SCORE\b/i);
    report.ipheyScore = report.url.startsWith('https://iphey.com/') && scoreMatch && Number(scoreMatch[1]) <= 100 ? Number(scoreMatch[1]) : null;
    report.fingerprint.canvasHash = createHash('sha256').update(report.fingerprint.canvasData).digest('hex');
    delete report.fingerprint.canvasData;
    fs.writeFileSync(path.join(root, `profile-${index}.json`), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(root, `profile-${index}.txt`), report.text);
    try {
      const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.join(root, `profile-${index}.png`), Buffer.from(screenshot.data, 'base64'));
    } catch (error) { fs.writeFileSync(path.join(root, `profile-${index}-screenshot-error.txt`), error.message); }
    console.log(`Profile ${index}: report saved; document URL: ${report.url}`);
    return report;
  } finally {
    if (cdp) { await cdp.send('Browser.close').catch(() => {}); cdp.close(); }
    else if (child.pid) child.kill();
  }
}

(async () => {
  const chrome = inspectChrome(BUNDLED_CHROME);
  if (!chrome.ready) throw new Error(chrome.error);
  const first = await audit(1);
  const second = await audit(2);
  const fields = Object.keys(first.fingerprint);
  const sameFields = fields.filter(key => JSON.stringify(first.fingerprint[key]) === JSON.stringify(second.fingerprint[key]));
  const summary = { chromeVersion: chrome.version, checkedAt: new Date().toISOString(),
    mode: 'headful Chrome; CDP read-only diagnostics; no fingerprint overrides',
    profiles: [first.profileId, second.profileId], sameFields,
    differentFields: fields.filter(key => !sameFields.includes(key)),
    ipheyLoaded: [first, second].every(report => report.url.startsWith('https://iphey.com') && /digital identity/i.test(report.text)),
    ipheyScores: [first.ipheyScore, second.ipheyScore],
    note: 'Scores read from the live page. null means not confirmed. Cross-check screenshots; CDP may affect the result.' };
  fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`AUDIT_COMPLETE ${root}`);
  console.log(`Matching fingerprint fields: ${sameFields.length}/${fields.length}`);
  if (!summary.ipheyLoaded) { console.error('IPhey did not load correctly; no score has been measured.'); process.exitCode = 2; }
  else if (summary.ipheyScores.some(score => score !== 100)) { console.error('The requested 100-point target was not reached in this diagnostic run.'); process.exitCode = 3; }
})().catch(error => { fs.writeFileSync(path.join(root, 'error.txt'), error.stack); console.error(error.message); process.exitCode = 1; });
