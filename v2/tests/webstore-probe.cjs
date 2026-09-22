// Real Store page in a disposable profile. CDP drives the page, not the installer.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { BUNDLED_CHROMIUM, inspectChromium, launchArgs } = require('../chromium-runtime');
const { ProfileStore } = require('../profile-store');
const delay = ms => new Promise(r => setTimeout(r, ms));
const root = fs.mkdtempSync(path.join(__dirname, '../artifacts/webstore149-'));
const store = new ProfileStore(path.join(root, 'data'));
const profile = store.create({ name: 'Store installation test', gpu: 'auto' });
const directory = store.directory(profile.id);
const id = 'aapbdbdomjkkjkaonfhkkikfgjllcleb'; // Google Translate
const url = `https://chromewebstore.google.com/detail/${id}?hl=en`;
let child, socket;
async function main() {
  const runtime = inspectChromium(BUNDLED_CHROMIUM);
  if (!runtime.ready) throw new Error(runtime.error);
  const args = launchArgs(directory, 'https://iphey.com/', profile.fingerprint);
  args[args.length - 1] = url;
  child = spawn(BUNDLED_CHROMIUM, ['--remote-debugging-port=0', ...args], { windowsHide: true, stdio: 'ignore' });
  fs.writeFileSync(path.join(root, 'launch.json'), JSON.stringify({ pid: child.pid, directory, url, version: runtime.version }, null, 2));
  console.log(`STORE_PROBE ${root} PID ${child.pid}`);
  let page;
  for (let i = 0; i < 120; i++) {
    try {
      const port = fs.readFileSync(path.join(directory, 'DevToolsActivePort'), 'utf8').split('\n')[0];
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = pages.find(p => p.type === 'page');
      if (page) break;
    } catch {}
    await delay(500);
  }
  if (!page) throw new Error('No browser target');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let seq = 0;
  const pending = new Map();
  socket.on('message', raw => { const m = JSON.parse(raw); const p = pending.get(m.id); if (p) { pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++seq; const timer = setTimeout(() => { pending.delete(n); reject(new Error(`Timeout: ${method}`)); }, 15000); pending.set(n, { resolve, reject, timer }); socket.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, userGesture: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  try {
    await send('Page.navigate', { url });
    let state;
    for (let i = 0; i < 60; i++) {
      state = await evaluate(`({url:location.href,title:document.title,text:document.body?.innerText,api:typeof chrome.webstorePrivate,buttons:[...document.querySelectorAll('button')].map(b=>({text:b.innerText,disabled:b.disabled}))})`);
      if (state.buttons.some(b => /Add to Chrome/i.test(b.text) && !b.disabled)) break;
      await delay(1000);
    }
    fs.writeFileSync(path.join(root, 'store-before.json'), JSON.stringify(state, null, 2));
    const clicked = await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>/Add to Chrome/i.test(b.innerText)&&!b.disabled);if(!b)return false;b.click();return true})()`);
    console.log(`STORE_ADD_CLICKED ${clicked}`);
    let installed = false;
    for (let i = 0; i < 120 && clicked; i++) {
      if (fs.existsSync(path.join(directory, 'Default/Extensions', id))) { installed = true; break; }
      await delay(1000);
    }
    const after = await evaluate('document.body.innerText');
    fs.writeFileSync(path.join(root, 'store-after.txt'), after);
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ version: runtime.version, url, clicked, installed, storeApi: state.api, extensionId: id }, null, 2));
    console.log(`STORE_INSTALLED ${installed}`);
    if (!installed) process.exitCode = 1;
  } finally { await send('Browser.close').catch(() => {}); socket.close(); }
}
main().catch(e => { fs.writeFileSync(path.join(root, 'error.txt'), e.stack); console.error(e); socket?.close(); child?.kill(); process.exitCode = 1; });
