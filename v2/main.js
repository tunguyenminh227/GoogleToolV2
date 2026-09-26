const secretConfig = require('./secret-config');
const { proxyArgs, closeProxy } = require('./proxy-auth');
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const { ProfileStore } = require('./profile-store');
const { resolveChromium, inspectChromium, launchArgs } = require('./chromium-runtime');
const { GPU_PRESETS } = require('./fingerprint');
const engine = require('./engine-config');
const fingerprintConfig = require('./fingerprint-config');
const { parseLine, importLines } = require('./profile-import');
const trace = require('./trace-log');
const gmailLogin = require('./gmail-login');
const passkey = require('./passkey');
const firebaseService = require('./firebase-service');
const puppeteer = require('puppeteer-core');
const { initializeStartup } = require('./profile-startup');
const { OpenQueue } = require('./open-queue');
const { gridBounds } = require('./window-layout');
const net = require('node:net');
const passkeyWatcher = require('./passkey-watcher');
const adsVerification = require('./ads-verification');

const getFreePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => {
    const port = srv.address().port;
    srv.close(() => resolve(port));
  });
  srv.on('error', reject);
});

const windowSlots = new Map();
let importing = false;

app.setName('GoogleTool v2');
app.setPath('userData', path.join(app.getPath('appData'), engine.dataNamespace));
let window;
let store;
let settings = {};
const running = new Map();
const runningPorts = new Map();
const deleting = new Set();

const logProfileCreated = trace.traced('logProfileCreated', profile => {
  const fp = profile.fingerprint || {};
  const gpuLabel = fp.gpu === 'real' ? 'GPU thật (real)' : `GPU tự động theo seed (${fp.gpu || 'auto'})`;
  const ipProxy = fp.proxyUrl ? (fp.proxyUsername ? `${fp.proxyUrl} (User: ${fp.proxyUsername})` : fp.proxyUrl) : 'IP trực tiếp (không dùng proxy)';
  console.log(`[profile-create] ==========================================`);
  console.log(`[profile-create] ĐÃ TẠO PROFILE MỚI THÀNH CÔNG:`);
  console.log(`[profile-create] - ID:         ${profile.id}`);
  console.log(`[profile-create] - Tên:        ${profile.name}`);
  if (profile.email) console.log(`[profile-create] - Email:      ${profile.email}`);
  console.log(`[profile-create] - Seed:       ${fp.seed}`);
  console.log(`[profile-create] - GPU:        ${gpuLabel}`);
  console.log(`[profile-create] - IP / Proxy: ${ipProxy}`);
  console.log(`[profile-create] - Múi giờ:    ${fp.timezone || 'Mặc định'}`);
  console.log(`[profile-create] - Ngôn ngữ:   ${fp.locale || 'Mặc định'}`);
  console.log(`[profile-create] - CPU Cores:  ${fp.hardwareConcurrency || 8}`);
  console.log(`[profile-create] - Cửa sổ:     ${fp.windowSize || '1280x720'}`);
  console.log(`[profile-create] - Nền tảng:   ${fp.platform || 'windows'}`);
  console.log(`[profile-create] - WebRTC:     ${fp.webrtc || 'default'}`);
  console.log(`[profile-create] ==========================================`);
}, { profileArgument: 0 });

const createProfile = trace.traced('createProfile', async input => {
  const chrome = resolveChromium(settings.chromiumPath);
  if (!chrome.ready) throw new Error(chrome.error);
  const profile = store.create(input);
  deleting.add(profile.id);
  try {
    await initializeStartup(profile.id, chrome.path, store.directory(profile.id));
    logProfileCreated(profile);
    return profile;
  } catch {
    const staged = store.remove(profile.id);
    if (staged) await shell.trashItem(staged);
    throw new Error('Không thiết lập được chế độ khôi phục phiên cho profile mới. Hãy thử tạo lại.');
  } finally { deleting.delete(profile.id); }
});

// Logging transport: no recursive tracing of logger callbacks.
ipcMain.on('v2:ui-trace', (event, record) => {
  if (window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame) trace.recordUi(record);
});

async function profileIsOpen(id) {
  if (running.has(id)) return true;
  // Browsers can outlive the app; check their actual user-data-dir too.
  const directory = store.directory(id);
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$target=$env:GOOGLETOOL_DELETE_DIRECTORY; $found=Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" -ErrorAction Stop | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($target,[StringComparison]::OrdinalIgnoreCase) -ge 0 }; if($found){"open"}else{"closed"}'],
  { windowsHide: true, timeout: 15000, env: { ...process.env, GOOGLETOOL_DELETE_DIRECTORY: directory } });
  if (!['open', 'closed'].includes(stdout.trim())) throw new Error('Không kiểm tra được trạng thái trình duyệt.');
  return stdout.trim() === 'open';
}

const deleteConfirmedProfile = trace.traced('deleteConfirmedProfile', async id => {
  if (await profileIsOpen(id)) throw new Error('Hãy đóng trình duyệt của profile trước khi xóa.');
  const staged = store.remove(id);
  let warning = null;
  if (staged) {
    try { await shell.trashItem(staged); }
    catch { warning = `Đã xóa khỏi danh sách nhưng chưa chuyển được dữ liệu vào Thùng rác. Dữ liệu còn tại: ${staged}`; }
  }
  try { await trace.deleteProfileLogs(id, trace.traced('delete.trashLogs', target => shell.trashItem(target))); }
  catch { warning = [warning, 'Chưa chuyển được log riêng của profile vào Thùng rác.'].filter(Boolean).join(' '); }
  return { id, deleted: true, warning };
}, { profileArgument: 0 });

const deleteProfiles = trace.traced('deleteProfiles', async ids => {
  if (!Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some(trace.traced('delete.validateId', id => typeof id !== 'string'))) throw new Error('Danh sách profile không hợp lệ.');
  const uniqueIds = [...new Set(ids)];
  const locked = [], eligible = [], results = [];
  try {
    for (const id of uniqueIds) {
      try {
        store.get(id);
        if (deleting.has(id)) throw new Error('Profile đang được xử lý.');
        deleting.add(id); locked.push(id);
        if (await profileIsOpen(id)) throw new Error('Hãy đóng trình duyệt của profile trước khi xóa.');
        eligible.push(id);
      } catch (error) { results.push({ id, deleted: false, error: error.message }); }
    }
    if (!eligible.length) return { cancelled: false, results };
    const { response } = await dialog.showMessageBox(window, {
      type: 'warning', title: 'Xóa profile', message: `Xóa ${eligible.length} profile đã chọn?`,
      detail: `Dữ liệu trình duyệt, cookie, phiên đăng nhập và log riêng sẽ được chuyển vào Thùng rác.${results.length ? ` Bỏ qua ${results.length} profile đang mở hoặc không thể xử lý.` : ''}`,
      buttons: ['Hủy', 'Xóa profile'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (response !== 1) return { cancelled: true, results };
    for (const id of eligible) {
      try { results.push(await deleteConfirmedProfile(id)); }
      catch (error) { results.push({ id, deleted: false, error: error.message }); }
    }
    broadcast();
    return { cancelled: false, results };
  } finally { for (const id of locked) deleting.delete(id); }
});

const deleteProfile = trace.traced('deleteProfile', async id => {
  const profile = store.get(id);
  if (deleting.has(id)) throw new Error('Profile đang được xử lý.');
  deleting.add(id);
  try {
    if (await profileIsOpen(id)) throw new Error('Hãy đóng trình duyệt của profile trước khi xóa.');
    const { response } = await dialog.showMessageBox(window, {
      type: 'warning', title: 'Xóa profile', message: `Xóa profile “${profile.name}”?`,
      detail: 'Profile sẽ bị xóa khỏi danh sách. Dữ liệu trình duyệt, cookie, phiên đăng nhập và log riêng sẽ được chuyển vào Thùng rác.',
      buttons: ['Hủy', 'Xóa profile'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (response !== 1) return { deleted: false };
    if (await profileIsOpen(id)) throw new Error('Hãy đóng trình duyệt của profile trước khi xóa.');
    const result = await deleteConfirmedProfile(id);
    broadcast();
    return result;
  } finally { deleting.delete(id); }
}, { profileArgument: 0 });
const settingsFile = path.join(app.getPath('userData'), 'settings.json');

function accountDetails(id) {
  const file = path.join(store.directory(id), '.googletool-account');
  if (!fs.existsSync(file)) return {};
  try {
    const account = JSON.parse(safeStorage.decryptString(Buffer.from(fs.readFileSync(file, 'utf8'), 'base64')));
    const details = Object.fromEntries(['password', 'recoveryMail', 'twofa', 'securityCode', 'passkey'].map(key => [key, typeof account[key] === 'string' ? account[key] : '']));
    if (!details.securityCode && typeof account.security_code === 'string') details.securityCode = account.security_code;
    return details;
  } catch { return { accountError: 'Không đọc được thông tin tài khoản mã hóa.' }; }
}

const savePasskey = trace.traced('savePasskey', (id, passkeyBlob) => {
  const dir = store.directory(id);
  const file = path.join(dir, '.googletool-account');
  let account = {};
  if (fs.existsSync(file)) {
    try {
      account = JSON.parse(safeStorage.decryptString(Buffer.from(fs.readFileSync(file, 'utf8'), 'base64')));
    } catch (_) {}
  }
  account.passkey = passkeyBlob;
  const encrypted = safeStorage.encryptString(JSON.stringify(account)).toString('base64');
  fs.writeFileSync(file, encrypted, 'utf8');
}, { profileArgument: 0 });

function snapshot() {
  const chrome = resolveChromium(settings.chromiumPath);
  return {
    profiles: store.list().map(p => ({ ...p, ...accountDetails(p.id), gpuLabel: GPU_PRESETS[p.fingerprint.gpu].label, running: running.has(p.id) })),
    chromePath: chrome.ready ? chrome.path : null,
    chromeVersion: chrome.version,
    engineLabel: engine.label,
    chromeError: chrome.error,
    dataPath: store.root,
    openQueue: openQueue.snapshot(),
  };
}

const broadcast = trace.traced('broadcast', () => {
  openQueue.pump();
  if (window && !window.isDestroyed()) window.webContents.send('v2:changed', snapshot());
});

const handle = trace.traced('handle', function (channel, fn) {
  const operation = trace.traced(channel, fn);
  ipcMain.handle(channel, trace.traced('ipc.dispatch', async (event, ...args) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      return { ok: false, error: 'Yêu cầu không hợp lệ.' };
    }
    try { return { ok: true, data: await operation(...args) }; }
    catch (error) { return { ok: false, error: error.message || 'Không thể hoàn tất thao tác.' }; }
  }, { profileArgument: 1 }));
});

const tiledArgs = trace.traced('windows.tiledArgs', (id, args) => {
  if (openQueue.limit > 1) {
    const occupied = new Set(windowSlots.values());
    let slot = 0;
    while (occupied.has(slot)) slot++;
    const display = window && !window.isDestroyed() ? screen.getDisplayMatching(window.getBounds()) : screen.getPrimaryDisplay();
    const bounds = gridBounds(display.workArea, Math.max(openQueue.limit, slot + 1), slot);
    windowSlots.set(id, slot);
    args = args.filter(trace.traced('windows.filterSize', arg => !arg.startsWith('--window-size=')));
    args.push(`--window-size=${bounds.width},${bounds.height}`, `--window-position=${bounds.x},${bounds.y}`);
  }
  return args;
}, { profileArgument: 0 });

const loginProfile = trace.traced('loginProfile', async id => {
  if (deleting.has(id)) throw new Error('Profile đang được xử lý.');
  const profile = store.get(id);
  const details = accountDetails(id);
  if (!profile.email) throw new Error('Profile chưa có email.');
  if (details.accountError) throw new Error(details.accountError);
  deleting.add(id);
  let browser;
  const status = trace.traced('gmail.status', (value, errorText = null) => { store.setMailStatus(id, value, errorText); broadcast(); });
  try {
    if (await profileIsOpen(id)) {
      status('error', 'Profile đang mở');
      throw new Error('Đóng profile trước khi chọn Login gmail để app mở phiên đăng nhập.');
    }
    const chrome = resolveChromium(settings.chromiumPath);
    if (!chrome.ready) {
      status('error', chrome.error || 'Chromium chưa sẵn sàng');
      throw new Error(chrome.error);
    }
    status('starting');
    let args = launchArgs(store.directory(id), null, profile.fingerprint);
    args = tiledArgs(id, args);
    args = await proxyArgs(id, args, profile.fingerprint);
    try {
      browser = await puppeteer.launch({ executablePath: chrome.path, args, ignoreDefaultArgs: true,
        headless: false, pipe: true, defaultViewport: null, timeout: 30000,
        handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
    } catch {
      windowSlots.delete(id); await closeProxy(id);
      status('error', 'Không kết nối được Chromium');
      throw new Error('Không kết nối được Chromium để đăng nhập Gmail.');
    }
    const child = browser.process();
    running.set(id, child);
    child.once('exit', trace.traced('gmail.browserExit', () => {
      if (running.get(id) === child) { running.delete(id); runningPorts.delete(id); windowSlots.delete(id); void closeProxy(id); }
      try {
        const current = store.get(id);
        const inProgress = ['starting', 'email', 'password', 'recovery', 'totp', 'selection', 'skotp', 'recaptcha', 'inbox'];
        if (inProgress.includes(current.mailStatus)) {
          store.setMailStatus(id, 'error', 'Trình duyệt đã đóng');
        }
      } catch (_) {}
      if (browser) {
        try { browser.close().catch(() => {}); } catch (_) {}
      }
      broadcast();
    }));
    store.markOpened(id); broadcast();
    const pages = await browser.pages();
    let page = pages[0];
    for (const candidate of pages) {
      if (await candidate.evaluate(() => document.visibilityState === 'visible')) {
        page = candidate;
        break;
      }
    }
    if (!page) {
      const target = await browser.waitForTarget(trace.traced('gmail.waitExistingTab', target => target.type() === 'page'), { timeout: 30000 });
      page = await target.page();
    }
    if (!page) {
      status('error', 'Không tìm thấy tab profile');
      throw new Error('Không tìm thấy tab hiện tại của profile.');
    }
    await page.bringToFront();
    return await gmailLogin.login(page, { ...details, email: profile.email }, status,
      { typingDelayMs: settings.gmailTypingDelayMs ?? 90, timeoutMs: settings.gmailStepTimeoutMs ?? 30000,
        twoCaptchaApiKey: settings.twoCaptchaApiKey });
  } catch (error) {
    const errorMsg = error.message || 'Lỗi đăng nhập';
    const statusCode = error.loginCode === 'rejected' ? 'rejected' :
      error.loginCode === 'verify_phone' ? 'verify_phone' :
      error.loginCode === 'manual' || error.loginCode === 'missing_data' || error.loginCode === 'missing_totp' || error.loginCode === 'no_authenticator' ? 'manual' : 'error';
    status(statusCode, errorMsg);
    throw new Error(error.loginCode ? error.message : 'Không thể bắt đầu Login gmail. Hãy đóng profile đang mở và kiểm tra cấu hình trình duyệt.');
  } finally {
    try { if (browser) browser.disconnect(); }
    finally { if (!browser) { windowSlots.delete(id); await closeProxy(id); } deleting.delete(id); }
  }
}, { profileArgument: 0 });

const enablePasskeyProfile = trace.traced('enablePasskeyProfile', async id => {
  if (deleting.has(id)) throw new Error('Profile đang được xử lý.');
  const profile = store.get(id);
  const details = accountDetails(id);
  if (!profile.email) throw new Error('Profile chưa có email.');
  if (details.accountError) throw new Error(details.accountError);
  deleting.add(id);
  let browser;
  const status = trace.traced('passkey.status', (value, errorText = null) => { store.setMailStatus(id, value, errorText); broadcast(); });
  try {
    if (await profileIsOpen(id)) {
      status('error', 'Profile đang mở');
      throw new Error('Đóng profile trước khi chọn Bật Passkey để app mở phiên cấu hình.');
    }
    const chrome = resolveChromium(settings.chromiumPath);
    if (!chrome.ready) {
      status('error', chrome.error || 'Chromium chưa sẵn sàng');
      throw new Error(chrome.error);
    }
    status('starting', 'Đang kết nối…');
    let args = launchArgs(store.directory(id), null, profile.fingerprint);
    args = tiledArgs(id, args);
    args = await proxyArgs(id, args, profile.fingerprint);
    try {
      browser = await puppeteer.launch({ executablePath: chrome.path, args, ignoreDefaultArgs: true,
        headless: false, pipe: true, defaultViewport: null, timeout: 30000,
        handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
    } catch {
      windowSlots.delete(id); await closeProxy(id);
      status('error', 'Không kết nối được Chromium');
      throw new Error('Không kết nối được Chromium để bật Passkey.');
    }
    const child = browser.process();
    running.set(id, child);
    child.once('exit', trace.traced('passkey.browserExit', () => {
      if (running.get(id) === child) { running.delete(id); runningPorts.delete(id); windowSlots.delete(id); void closeProxy(id); }
      try {
        const current = store.get(id);
        const inProgress = ['starting', 'passkey_creating'];
        if (inProgress.includes(current.mailStatus)) {
          store.setMailStatus(id, 'error', 'Trình duyệt đã đóng');
        }
      } catch (_) {}
      if (browser) {
        try { browser.close().catch(() => {}); } catch (_) {}
      }
      broadcast();
    }));
    store.markOpened(id); broadcast();

    const result = await passkey.enablePasskey(browser, { ...details, email: profile.email }, status,
      { typingDelayMs: settings.gmailTypingDelayMs ?? 90, timeoutMs: settings.gmailStepTimeoutMs ?? 30000 });
    if (result && result.passkeyBlob) {
      savePasskey(id, result.passkeyBlob);
    }
    return result;
  } catch (error) {
    const errorMsg = error.message || 'Lỗi bật Passkey';
    status('error', errorMsg);
    throw new Error(error.passkeyCode ? error.message : 'Không thể hoàn tất bật Passkey. Hãy kiểm tra lại cấu hình.');
  } finally {
    try {
      if (browser) {
        try { await browser.close(); } catch (_) {}
        browser.disconnect();
      }
    } finally {
      if (!browser) { windowSlots.delete(id); await closeProxy(id); }
      deleting.delete(id);
    }
  }
}, { profileArgument: 0 });

const WebSocketClient = typeof WebSocket !== 'undefined' ? WebSocket : require('ws');

function connectAndSendBrowser(browserWsUrl, actions, timeoutMs = 25000) {
  return new Promise((resolve) => {
    let ws;
    try {
      ws = new WebSocketClient(browserWsUrl);
    } catch (_) {
      return resolve(null);
    }

    let settled = false;
    let timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { ws.close(); } catch (_) {}
        resolve(null);
      }
    }, timeoutMs);

    let id = 0;
    const pending = new Map();

    const onMsg = data => {
      try {
        const text = typeof data === 'string' ? data : (data.data || data.toString());
        const msg = JSON.parse(text);
        if (msg && msg.id && pending.has(msg.id)) {
          const cb = pending.get(msg.id);
          pending.delete(msg.id);
          cb(msg);
        }
      } catch (_) {}
    };

    if (ws.on) {
      ws.on('message', onMsg);
      ws.on('error', () => { if (!settled) { settled = true; clearTimeout(timer); resolve(null); } });
      ws.on('close', () => { if (!settled) { settled = true; clearTimeout(timer); resolve(null); } });
    } else {
      ws.onmessage = e => onMsg(e.data);
      ws.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(null); } };
      ws.onclose = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(null); } };
    }

    const send = (method, params = {}) => new Promise(res => {
      const myId = ++id;
      const t = setTimeout(() => {
        pending.delete(myId);
        res(null);
      }, 7000);
      pending.set(myId, msg => {
        clearTimeout(t);
        res(msg);
      });
      try {
        ws.send(JSON.stringify({ id: myId, method, params }));
      } catch (_) {
        pending.delete(myId);
        clearTimeout(t);
        res(null);
      }
    });

    const onOpen = async () => {
      try {
        const result = await actions(send);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          try { ws.close(); } catch (_) {}
          resolve(result);
        }
      } catch (_) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          try { ws.close(); } catch (_) {}
          resolve(null);
        }
      }
    };

    if (ws.on) ws.on('open', onOpen);
    else ws.onopen = onOpen;
  });
}

const openTiledWindowsInProfile = trace.traced('openTiledWindowsInProfile', async (id, urls) => {
  if (!Array.isArray(urls) || urls.length === 0) return { ok: true };

  let port = runningPorts.get(id);
  if (!port || !running.has(id)) {
    await openProfile(id);
    for (let i = 0; i < 30; i++) {
      port = runningPorts.get(id);
      if (port) break;
      await new Promise(r => setTimeout(r, 200));
    }
  }

  if (!port) {
    throw new Error('Không thể kết nối cổng điều khiển trình duyệt của profile.');
  }

  let browserWsUrl = null;
  for (let i = 0; i < 30; i++) {
    try {
      const vRes = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (vRes.ok) {
        const vData = await vRes.json();
        browserWsUrl = vData.webSocketDebuggerUrl;
        if (browserWsUrl) break;
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 200));
  }

  if (!browserWsUrl) {
    throw new Error('Trình duyệt chưa sẵn sàng nhận lệnh mở window.');
  }

  // Đóng các tab xác minh cũ đang mở trong cùng window (tránh dồn tab vào 1 window)
  try {
    const listRes = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (listRes.ok) {
      const tabs = await listRes.json();
      if (Array.isArray(tabs)) {
        for (const tab of tabs) {
          if (tab.type === 'page' && (tab.url.includes('/identity/advertiser-verification') || tab.url.includes('/billing/advertiserverification'))) {
            await fetch(`http://127.0.0.1:${port}/json/close/${tab.id}`).catch(() => {});
          }
        }
      }
    }
  } catch (_) {}

  // Tính toán vị trí xếp ngang theo chiều ngang (side-by-side)
  const display = window && !window.isDestroyed() ? screen.getDisplayMatching(window.getBounds()) : screen.getPrimaryDisplay();
  const area = display.workArea;
  const count = urls.length;
  const gap = 8;
  const winWidth = Math.max(380, Math.floor((area.width - (count - 1) * gap) / count));
  const winHeight = area.height;

  return await connectAndSendBrowser(browserWsUrl, async (send) => {
    for (let i = 0; i < count; i++) {
      const targetUrl = urls[i];
      const x = area.x + i * (winWidth + gap);
      const y = area.y;

      const createRes = await send('Target.createTarget', {
        url: targetUrl,
        newWindow: true
      });

      const targetId = createRes?.result?.targetId;
      if (targetId) {
        try {
          const winRes = await send('Browser.getWindowForTarget', { targetId });
          const windowId = winRes?.result?.windowId;
          if (windowId) {
            await send('Browser.setWindowBounds', {
              windowId,
              bounds: {
                windowState: 'normal',
                left: x,
                top: y,
                width: winWidth,
                height: winHeight
              }
            });
          }
          await send('Target.activateTarget', { targetId });
        } catch (e) {
          console.warn('[openTiledWindowsInProfile] Lỗi đặt kích thước window:', e.message);
        }
      }
      await new Promise(r => setTimeout(r, 200));
    }
    return { ok: true, count };
  });
}, { profileArgument: 0 });

const verifyAdsUrl = 'https://ads.google.com/aw/billing/advertiserverification';

const verifyAdsProfile = trace.traced('verifyAdsProfile', async (id, url = null) => {
  return openTiledWindowsInProfile(id, [url || verifyAdsUrl]);
}, { profileArgument: 0 });

const openProfile = trace.traced('openProfile', async (id, url = null, tiled = false) => {
  if (deleting.has(id)) throw new Error('Profile đang được chỉnh sửa hoặc xóa.');
  const profile = store.get(id);
  const alreadyRunning = running.has(id);
  if (alreadyRunning) {
    if (url) return openTiledWindowsInProfile(id, [url]);
    throw new Error('Profile này đang mở trong Chromium.');
  }
  const chrome = resolveChromium(settings.chromiumPath);
  if (!chrome.ready) throw new Error(chrome.error);
  const dir = store.directory(id);
  fs.mkdirSync(dir, { recursive: true });
  let args = launchArgs(dir, url, profile.fingerprint);
  if (tiled) args = tiledArgs(id, args);
  try { args = await proxyArgs(id, args, profile.fingerprint); }
  catch { windowSlots.delete(id); throw new Error('Không khởi động được proxy xác thực.'); }
  const port = await getFreePort();
  args.push(`--remote-debugging-port=${port}`);
  let child;
  try { child = spawn(chrome.path, args, { detached: true, stdio: 'ignore', shell: false }); }
  catch (error) { windowSlots.delete(id); await closeProxy(id); throw error; }
  running.set(id, child);
  runningPorts.set(id, port);
  const details = accountDetails(id);
  passkeyWatcher.startPasskeyWatcher(child, port, details.passkey, id);
  child.once('exit', trace.traced('openProfile.exit', () => {
    if (running.get(id) === child) {
      running.delete(id);
      runningPorts.delete(id);
      windowSlots.delete(id);
      void closeProxy(id);
    }
    try {
      const current = store.get(id);
      const inProgress = ['starting', 'email', 'password', 'recovery', 'totp', 'selection', 'skotp', 'recaptcha', 'inbox', 'passkey_creating'];
      if (inProgress.includes(current.mailStatus)) {
        store.setMailStatus(id, 'manual', 'Trình duyệt đã đóng');
      }
    } catch (_) {}
    broadcast();
  }));
  await new Promise(trace.traced('openProfile.spawn', (resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', trace.traced('openProfile.error', () => {
      if (running.get(id) === child) {
        running.delete(id);
        runningPorts.delete(id);
        windowSlots.delete(id);
        void closeProxy(id);
      }
      broadcast();
      reject(new Error('Không mở được Chromium. Kiểm tra lại đường dẫn đã chọn.'));
    }));
  }));
  child.unref();
  store.markOpened(id);
  broadcast();
}, { profileArgument: 0 });

const openQueue = new OpenQueue({
  activeIds: trace.traced('queue.activeIds', () => [...running.keys()]),
  open: trace.traced('queue.openTiled', id => openProfile(id, null, true), { profileArgument: 0 }),
  changed: trace.traced('queue.changed', () => { if (store) broadcast(); }),
});

const createWindow = trace.traced('createWindow', () => {
  window = new BrowserWindow({
    width: 1320, height: 860, minWidth: 960, minHeight: 640,
    title: 'GoogleTool v2', backgroundColor: '#f6f8fc', autoHideMenuBar: true,
    show: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  window.once('ready-to-show', () => {
    if (window && !window.isDestroyed()) {
      window.show();
      window.focus();
    }
  });
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
  });
  app.whenReady().then(() => {
    try {
      trace.configure(path.join(app.getPath('userData'), 'logs'));
      store = new ProfileStore(app.getPath('userData'));
      if (fs.existsSync(settingsFile)) settings = secretConfig.parse(fs.readFileSync(settingsFile, 'utf8')) || {};
      handle('v2:load', snapshot);
      handle('v2:create', async input => {
        const tpl = fingerprintConfig.template(settings.fingerprintTemplate);
        const profile = await createProfile({ ...input, name: input.name || tpl.name || `Profile ${Date.now()}`, notes: input.notes || tpl.notes,
          fingerprint: { ...tpl, gpu: input.gpu || tpl.gpu } });
        broadcast(); return profile;
      });
      handle('v2:template-get', () => ({ current: fingerprintConfig.template(settings.fingerprintTemplate), defaults: fingerprintConfig.template(), resolutions: fingerprintConfig.RESOLUTIONS }));
      handle('v2:notes-save', input => {
        if (!input || deleting.has(input.id)) throw new Error('Profile đang được xử lý.');
        const profile = store.updateNotes(input.id, input);
        return { notes: profile.notes, notes2: profile.notes2, updatedAt: profile.updatedAt };
      });
      handle('v2:create-batch', async text => {
        if (importing) throw new Error('Đang tạo profile, vui lòng chờ.');
        const lines = importLines(text);
        const tpl = fingerprintConfig.template(settings.fingerprintTemplate);
        importing = true;
        const results = [];
        try {
          for (const [index, item] of lines.entries()) {
            try {
              const account = parseLine(item.line);
              let encryptedAccount;
              if (account.password || account.recoveryMail || account.twofa || account.securityCode || account.passkey) {
                if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows chưa sẵn sàng mã hóa dữ liệu tài khoản.');
                encryptedAccount = safeStorage.encryptString(JSON.stringify(account)).toString('base64');
              }
              const profile = await createProfile({ name: account.email, email: account.email, notes: tpl.notes,
                fingerprint: tpl, encryptedAccount });
              if (account.passkey) {
                store.setMailStatus(profile.id, 'passkey_enabled', null);
              }
              results.push({ lineNumber: item.lineNumber, endLineNumber: item.endLineNumber ?? item.lineNumber, ok: true, id: profile.id });
            } catch (error) {
              results.push({ lineNumber: item.lineNumber, endLineNumber: item.endLineNumber ?? item.lineNumber, ok: false, error: error.message });
            }
            if (window && !window.isDestroyed()) window.webContents.send('v2:create-progress', { done: index + 1, total: lines.length });
            await new Promise(resolve => setImmediate(resolve));
          }
          broadcast();
          return { total: lines.length, created: results.filter(r => r.ok).length, results };
        } finally { importing = false; }
      });
      handle('v2:template-save', input => {
        const tpl = fingerprintConfig.template(input);
        const next = { ...settings, fingerprintTemplate: tpl };
        fs.writeFileSync(`${settingsFile}.tmp`, secretConfig.stringify(next));
        fs.renameSync(`${settingsFile}.tmp`, settingsFile);
        settings = next;
        return tpl;
      });
      handle('v2:fingerprint-save', async input => {
        const id = input?.id;
        store.get(id);
        if (deleting.has(id)) throw new Error('Profile đang được xử lý.');
        deleting.add(id);
        try {
          if (await profileIsOpen(id)) throw new Error('Đóng trình duyệt của profile trước khi chỉnh fingerprint.');
          const profile = store.updateFingerprint(id, input.fingerprint);
          broadcast(); return profile;
        } finally { deleting.delete(id); }
      });
      handle('v2:delete', deleteProfile);
      handle('v2:delete-batch', deleteProfiles);
      handle('v2:open', trace.traced('ipc.open', input => {
        if (input && typeof input === 'object') {
          return openProfile(input.id, input.url);
        }
        return openProfile(input);
      }));
      handle('v2:open-batch', trace.traced('queue.request', input => {
        if (!input || !Array.isArray(input.ids) || !input.ids.length || input.ids.length > 500) throw new Error('Danh sách profile không hợp lệ.');
        for (const id of input.ids) store.get(id);
        if (input.action && !['open', 'login-gmail', 'enable-passkey', 'verify-ads'].includes(input.action)) throw new Error('Thao tác không hợp lệ.');
        const handler = input.action === 'login-gmail' ? loginProfile :
          input.action === 'enable-passkey' ? enablePasskeyProfile :
          input.action === 'verify-ads' ? verifyAdsProfile : undefined;
        return openQueue.enqueue(input.ids, input.limit, handler);
      }));
      handle('v2:open-cancel', openQueue.cancel);
      handle('v2:open-limit', openQueue.setLimit);
      handle('v2:login-gmail', loginProfile);
      handle('v2:enable-passkey', enablePasskeyProfile);
      handle('v2:verify-ads', trace.traced('ipc.verifyAds', input => {
        const id = (input && typeof input === 'object') ? input.id : input;
        const url = (input && typeof input === 'object' && input.url) ? input.url : verifyAdsUrl;
        return openTiledWindowsInProfile(id, [url]);
      }));
      handle('v2:verify-ads-batch', trace.traced('ipc.verifyAdsBatch', input => {
        const id = (input && typeof input === 'object') ? input.id : input;
        const urls = (input && typeof input === 'object' && Array.isArray(input.urls)) ? input.urls : [];
        return openTiledWindowsInProfile(id, urls);
      }));
      handle('v2:get-totp', secret => gmailLogin.totp(secret));
      handle('v2:check-iphey', id => openProfile(id, 'https://iphey.com/'));
      handle('v2:choose-chrome', async () => {
        const result = await dialog.showOpenDialog(window, { title: `Chọn ${engine.label} (chrome.exe)`, properties: ['openFile'], filters: [{ name: 'Chromium', extensions: ['exe'] }] });
        if (result.canceled) return snapshot();
        const selected = result.filePaths[0];
        if (path.basename(selected).toLowerCase() !== 'chrome.exe') throw new Error(`Vui lòng chọn chrome.exe của ${engine.label}.`);
        const info = inspectChromium(selected);
        if (!info.ready) throw new Error(info.error);
        const next = { ...settings, chromiumPath: selected };
        fs.writeFileSync(`${settingsFile}.tmp`, secretConfig.stringify(next));
        fs.renameSync(`${settingsFile}.tmp`, settingsFile);
        settings = next;
        broadcast();
        return snapshot();
      });
      handle('v2:gcp-ads-get', trace.traced('gcpAds.get', async () => {
        let config = settings.gcpAdsConfig || {};
        try {
          const remoteConfig = await firebaseService.getGcpAdsConfigFromFirebase();
          if (remoteConfig && (remoteConfig.clientId || remoteConfig.clientSecret || remoteConfig.developerToken || remoteConfig.refreshToken)) {
            config = remoteConfig;
            const next = { ...settings, gcpAdsConfig: config };
            fs.writeFileSync(`${settingsFile}.tmp`, secretConfig.stringify(next));
            fs.renameSync(`${settingsFile}.tmp`, settingsFile);
            settings = next;
          }
        } catch (err) {
          console.warn('[firebase] Không thể tải cấu hình từ Firebase (dùng cấu hình cục bộ):', err.message);
        }
        return {
          clientId: config.clientId || '',
          clientSecret: config.clientSecret || '',
          developerToken: config.developerToken || '',
          refreshToken: config.refreshToken || '',
          loginCustomerId: config.loginCustomerId || '',
        };
      }));
      handle('v2:gcp-ads-save', trace.traced('gcpAds.save', async input => {
        const clientId = typeof input?.clientId === 'string' ? input.clientId.trim() : '';
        const clientSecret = typeof input?.clientSecret === 'string' ? input.clientSecret.trim() : '';
        const developerToken = typeof input?.developerToken === 'string' ? input.developerToken.trim() : '';
        const refreshToken = typeof input?.refreshToken === 'string' ? input.refreshToken.trim() : '';
        const loginCustomerId = typeof input?.loginCustomerId === 'string' ? input.loginCustomerId.trim() : '';
        const gcpAdsConfig = { clientId, clientSecret, developerToken, refreshToken, loginCustomerId };
        
        // 1. Lưu an toàn vào settings.json cục bộ
        const next = { ...settings, gcpAdsConfig };
        fs.writeFileSync(`${settingsFile}.tmp`, secretConfig.stringify(next));
        fs.renameSync(`${settingsFile}.tmp`, settingsFile);
        settings = next;

        // 2. Đồng bộ lên Firebase Realtime Database
        try {
          await firebaseService.saveGcpAdsConfigToFirebase(gcpAdsConfig);
        } catch (err) {
          console.error('[firebase] Lỗi đồng bộ lên Firebase:', err.message);
          throw new Error(`Đã lưu trên máy nhưng lỗi đồng bộ Firebase: ${err.message}`);
        }

        return gcpAdsConfig;
      }));
      handle('v2:gcp-ads-auth-link', trace.traced('gcpAds.authLink', async () => {
        let config = settings.gcpAdsConfig || {};
        if (!config.clientId) {
          try {
            const remote = await firebaseService.getGcpAdsConfigFromFirebase();
            if (remote && remote.clientId) {
              config = remote;
              settings = { ...settings, gcpAdsConfig: config };
            }
          } catch (_) {}
        }
        if (!config.clientId) {
          throw new Error('Chưa cấu hình Client ID. Vui lòng bấm "Cài đặt GCP" để nhập Client ID trước.');
        }
        const redirectUri = 'http://127.0.0.1';
        const params = new URLSearchParams({
          client_id: config.clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: 'https://www.googleapis.com/auth/adwords',
          access_type: 'offline',
          prompt: 'consent',
        });
        const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
        return { url, redirectUri, clientId: config.clientId };
      }));
      handle('v2:gcp-ads-exchange-code', trace.traced('gcpAds.exchangeCode', async input => {
        const raw = typeof input?.codeOrUrl === 'string' ? input.codeOrUrl.trim() : '';
        if (!raw) throw new Error('Vui lòng dán URL chuyển hướng hoặc mã Authorization Code.');

        let code = raw;
        if (raw.includes('code=')) {
          try {
            const parsedUrl = new URL(raw.startsWith('http') ? raw : `http://${raw}`);
            const codeParam = parsedUrl.searchParams.get('code');
            if (codeParam) code = codeParam;
          } catch (_) {
            const match = raw.match(/[?&]code=([^&]+)/);
            if (match) code = decodeURIComponent(match[1]);
          }
        }

        let config = settings.gcpAdsConfig || {};
        if (!config.clientId || !config.clientSecret) {
          try {
            const remote = await firebaseService.getGcpAdsConfigFromFirebase();
            if (remote && remote.clientId && remote.clientSecret) {
              config = remote;
              settings = { ...settings, gcpAdsConfig: config };
            }
          } catch (_) {}
        }

        if (!config.clientId || !config.clientSecret) {
          throw new Error('Thiếu Client ID hoặc Client Secret trong Cài đặt GCP.');
        }

        const redirectUri = input?.redirectUri || 'http://127.0.0.1';
        const res = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: config.clientId,
            client_secret: config.clientSecret,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
          }),
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const errMsg = data.error_description || data.error || `HTTP ${res.status}`;
          throw new Error(`Đổi mã code thất bại từ Google: ${errMsg}`);
        }

        if (!data.refresh_token) {
          throw new Error('Google không trả về Refresh Token (có thể do tài khoản đã được cấp quyền trước đó). Hãy đăng nhập lại với prompt=consent hoặc gỡ quyền app tại myaccount.google.com/permissions rồi thử lại.');
        }

        const updatedConfig = {
          ...config,
          refreshToken: data.refresh_token,
        };

        const next = { ...settings, gcpAdsConfig: updatedConfig };
        fs.writeFileSync(`${settingsFile}.tmp`, secretConfig.stringify(next));
        fs.renameSync(`${settingsFile}.tmp`, settingsFile);
        settings = next;

        try {
          await firebaseService.saveGcpAdsConfigToFirebase(updatedConfig);
        } catch (err) {
          console.warn('[firebase] Lỗi lưu refresh token lên Firebase:', err.message);
        }

        return { ok: true, refreshToken: data.refresh_token };
      }));
      handle('v2:gcp-ads-scan-verification', trace.traced('gcpAds.scanVerification', async mccId => {
        let config = settings.gcpAdsConfig || {};
        if (!config.clientId || !config.refreshToken) {
          try {
            const remote = await firebaseService.getGcpAdsConfigFromFirebase();
            if (remote && remote.clientId) {
              config = remote;
              settings = { ...settings, gcpAdsConfig: config };
            }
          } catch (_) {}
        }
        return await adsVerification.scanMccVerification(config, mccId);
      }));
      handle('v2:open-external', trace.traced('system.openExternal', async url => {
        if (!url || typeof url !== 'string' || !url.startsWith('https://')) {
          throw new Error('URL không hợp lệ.');
        }
        await shell.openExternal(url);
        return { ok: true };
      }));
      createWindow();
    } catch (error) {
      dialog.showErrorBox('Không thể khởi động GoogleTool v2', error.message);
      app.quit();
    }
  });
  app.on('window-all-closed', () => app.quit());
}
