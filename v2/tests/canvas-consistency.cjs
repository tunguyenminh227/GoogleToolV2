// Local engine comparison only. CDP is used on both engines; no IPhey score is
// inferred from this probe. PNGs are decoded outside Chromium by System.Drawing.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const WebSocket = require('ws');
const { BUNDLED_CHROMIUM, inspectChromium, launchArgs } = require('../chromium-runtime');
const { BUNDLED_CHROME, inspectChrome } = require('../chrome-runtime');
const engine = require('../engine-config');
const pixelBoundsProbe = require('./pixel-bounds-probe');

const root = fs.mkdtempSync(path.join(__dirname, '../artifacts/canvas-consistency-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = data => createHash('sha256').update(data).digest('hex');
const fingerprint = { engine: engine.id, seed: 123456789, gpu: 'auto', locale: 'en-GB', timezone: 'Asia/Saigon' };

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let id = 0;
  const pending = new Map();
  socket.on('message', raw => {
    const message = JSON.parse(raw), item = pending.get(message.id);
    if (!item) return;
    clearTimeout(item.timer); pending.delete(message.id);
    message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
  });
  socket.on('close', () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('CDP disconnected')); } pending.clear(); });
  return { close: () => socket.close(), send: (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error(`Timeout: ${method}`)); }, 10000);
    pending.set(key, { resolve, reject, timer });
    socket.send(JSON.stringify({ id: key, method, params }));
  }) };
}

const expression = `(() => {
  const samples = [];
  for (const kind of ['blank', 'solid', 'solid-default', 'pattern', 'text']) {
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 16;
    const ctx = canvas.getContext('2d', { willReadFrequently: kind !== 'solid-default' });
    let expected = null;
    if (kind === 'blank') expected = Array(32 * 16 * 4).fill(0);
    if (kind.startsWith('solid') || kind === 'pattern') {
      const input = ctx.createImageData(32, 16);
      for (let y = 0; y < 16; y++) for (let x = 0; x < 32; x++) {
        const i = (y * 32 + x) * 4;
        input.data.set(kind.startsWith('solid') ? [40,80,120,255] : [(x*13+y*7)%256,(x*5+y*19)%256,(x*23+y*3)%256,255], i);
      }
      expected = Array.from(input.data); ctx.putImageData(input, 0, 0);
    }
    if (kind === 'text') { ctx.font = '12px Arial'; ctx.fillText('Abcd', 0, 12); }
    const before = Array.from(ctx.getImageData(0, 0, 32, 16).data);
    const png = canvas.toDataURL();
    const after = Array.from(ctx.getImageData(0, 0, 32, 16).data);
    const crop = Array.from(ctx.getImageData(3, 2, 5, 4).data);
    const expectedCrop = [];
    for (let y = 2; y < 6; y++) for (let x = 3; x < 8; x++) expectedCrop.push(...before.slice((y*32+x)*4,(y*32+x)*4+4));
    samples.push({ kind, expected, before, after, png, crop, expectedCrop });
  }
  const ctx = document.createElement('canvas').getContext('2d'); ctx.font = '18px monospace';
  return { userAgent: navigator.userAgent, samples, bounds: (${pixelBoundsProbe.toString()})(), metrics: { one: ctx.measureText('M').width, two: ctx.measureText('MM').width, four: ctx.measureText('MMMM').width } };
})()`;

async function run(label, executable, args, url) {
  const dir = path.join(root, label); fs.mkdirSync(dir);
  // Chromium chooses a free port and records it in this isolated test directory.
  const dataDir = args.find(arg => arg.startsWith('--user-data-dir=')).slice(16);
  const marker = path.join(dataDir, 'DevToolsActivePort');
  if (fs.existsSync(marker)) fs.unlinkSync(marker);
  const child = spawn(executable, ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', ...args, url], { windowsHide: true, stdio: 'ignore' });
  let cdp, spawnError;
  child.on('error', error => { spawnError = error; });
  try {
    for (let i = 0; i < 60; i++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Browser exited: ${child.exitCode}`);
      try {
        const port = fs.readFileSync(marker, 'utf8').split('\n')[0];
        const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json();
        const page = pages.find(page => page.type === 'page');
        if (page) { cdp = await connect(page.webSocketDebuggerUrl); break; }
      } catch (_) {}
      await delay(250);
    }
    if (!cdp) throw new Error('Could not connect to local browser probe');
    await cdp.send('Page.enable'); await cdp.send('Page.navigate', { url }); await delay(800);
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    const report = result.result.value;
    report.launchArgs = args;
    for (const sample of report.samples) {
      fs.writeFileSync(path.join(dir, `${sample.kind}.png`), Buffer.from(sample.png.split(',')[1], 'base64'));
      delete sample.png;
    }
    fs.writeFileSync(path.join(dir, 'raw.json'), JSON.stringify(report));
    console.log(`${label}: local samples saved`);
    return { label, dir, report };
  } finally {
    if (cdp) { await cdp.send('Browser.close').catch(() => {}); cdp.close(); }
    if (child.exitCode === null) {
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)]);
      if (child.exitCode === null) child.kill();
    }
  }
}

const diffs = (a, b) => { let count = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) count++; return count; };
(async () => {
  if (!inspectChromium(BUNDLED_CHROMIUM).ready || !inspectChrome(BUNDLED_CHROME).ready) throw new Error('Both verified browser builds are required');
  const server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Canvas consistency probe</title>Local test'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/`;
    const profiles = Object.fromEntries(['chrome', 'adryfish', 'zero'].map(name => { const dir = path.join(root, `${name}-data`); fs.mkdirSync(dir); return [name, dir]; }));
    const original = launchArgs(profiles.adryfish, 'https://iphey.com/', fingerprint).slice(0, -1);
    const zero = launchArgs(profiles.zero, 'https://iphey.com/', fingerprint).slice(0, -1).map(arg => /^--fingerprint=/.test(arg) ? arg.replace(/=.*/, '=0') : arg);
    const runs = [];
    runs.push(await run('chrome-control', BUNDLED_CHROME, [`--user-data-dir=${profiles.chrome}`, '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1'], url));
    runs.push(await run('chrome-reopen', BUNDLED_CHROME, [`--user-data-dir=${profiles.chrome}`, '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1'], url));
    runs.push(await run('adryfish-first', BUNDLED_CHROMIUM, original, url));
    runs.push(await run('adryfish-reopen', BUNDLED_CHROMIUM, original, url));
    runs.push(await run('adryfish-zero', BUNDLED_CHROMIUM, zero, url));
    const shell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    execFileSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'decode-probe-png.ps1'), '-Root', root], { windowsHide: true, timeout: 20000 });
    const summary = { checkedAt: new Date().toISOString(), mode: 'CDP local diagnostic', scope: 'Local API consistency; not an IPhey score test', runs: runs.map(({ label, dir, report }) => ({ label, webdriver: report.webdriver, metrics: report.metrics, bounds: report.bounds,
      samples: report.samples.map(sample => { const decoded = fs.readFileSync(path.join(dir, `${sample.kind}.rgba`));
        if (decoded.length !== sample.before.length) throw new Error(`Decoded image size mismatch: ${label}/${sample.kind}`);
        return {
        kind: sample.kind, returnedPixelHash: hash(Buffer.from(sample.before)),
        inputMismatchBytes: sample.expected ? diffs(sample.before, sample.expected) : null,
        pngMismatchBytes: diffs(sample.before, decoded), pngDecodedBytes: decoded.length,
        pngMismatchByChannel: [0, 1, 2, 3].map(channel => sample.before.filter((value, i) => i % 4 === channel && value !== decoded[i]).length),
        readAfterExportMismatchBytes: diffs(sample.before, sample.after),
        cropMismatchBytes: diffs(sample.crop, sample.expectedCrop), firstPixel: sample.before.slice(0, 4)
      }; }) })) };
    fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2));
    if (summary.runs.some(run => !run.bounds.negativeCrop || !run.bounds.packedReadback || run.bounds.floatReadback === false)) {
      throw new Error('Pixel bounds/readback regression; inspect summary.json');
    }
    for (const run of summary.runs) console.log(run.label, JSON.stringify(run.samples.map(sample => ({ kind: sample.kind, pngMismatchBytes: sample.pngMismatchBytes, channels: sample.pngMismatchByChannel }))));
    console.log(`CANVAS_PROBE_COMPLETE ${root}`);
  } finally { server.close(); }
})().catch(error => { fs.writeFileSync(path.join(root, 'error.txt'), error.stack); console.error(error); process.exitCode = 1; });
