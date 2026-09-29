const secretConfig = require('./secret-config');
const { proxyArgs, closeProxy } = require('./proxy-auth');
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFile, execSync } = require('node:child_process');
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
const { gridBounds, horizontalBounds } = require('./window-layout');
const net = require('node:net');
const passkeyWatcher = require('./passkey-watcher');
const adsVerification = require('./ads-verification');
const adsVerificationBrowser = require('./ads-verification-browser');
const gcpServers = require('./gcp-servers');
const { queryPool, QuotaStopError, getTaskTimeoutMs, setTaskTimeoutMs } = require('./query-pool');
const { registerPoolRoutes } = require('./pool-routes');

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
let lastUsedMccId = null;
let lastUsedCustomerId = null;
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
    const result = await gmailLogin.login(page, { ...details, email: profile.email }, status,
      { typingDelayMs: settings.gmailTypingDelayMs ?? 90, timeoutMs: settings.gmailStepTimeoutMs ?? 30000,
        twoCaptchaApiKey: settings.twoCaptchaApiKey });
    if (result && result.status === 'success') {
      try {
        if (browser && typeof browser.close === 'function') {
          await browser.close().catch(() => {});
        }
      } catch (_) {}
    }
    return result;
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
    const port = await getFreePort();
    args.push(`--remote-debugging-port=${port}`);
    runningPorts.set(id, port);
    try {
      browser = await puppeteer.launch({ executablePath: chrome.path, args, ignoreDefaultArgs: true,
        headless: false, pipe: true, defaultViewport: null, timeout: 30000,
        handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
    } catch {
      windowSlots.delete(id); await closeProxy(id); runningPorts.delete(id);
      status('error', 'Không kết nối được Chromium');
      throw new Error('Không kết nối được Chromium để bật Passkey.');
    }
    const child = browser.process();
    running.set(id, child);
    child.once('exit', trace.traced('passkey.browserExit', () => {
      if (running.get(id) === child) { running.delete(id); runningPorts.delete(id); windowSlots.delete(id); void closeProxy(id); }
      try {
        const current = store.get(id);
        const inProgress = ['starting', 'passkey_creating', 'recaptcha'];
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
      {
        typingDelayMs: settings.gmailTypingDelayMs ?? 90,
        timeoutMs: settings.gmailStepTimeoutMs ?? 30000,
        twoCaptchaApiKey: settings.twoCaptchaApiKey,
        port
      });
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
      runningPorts.delete(id);
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

  return await connectAndSendBrowser(browserWsUrl, async (send) => {
    for (let i = 0; i < count; i++) {
      const targetUrl = urls[i];
      const bounds = horizontalBounds(area, count, i);

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
              bounds
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

const openedAccountWindowsByProfile = new Map();

const arrangeProfileAccountWindows = trace.traced('ads.arrangeAccountWindows', async (profileId, bSend, mainTargetId = null, newEntry = null) => {
  let list = openedAccountWindowsByProfile.get(profileId) || [];
  if (newEntry && newEntry.targetId && newEntry.windowId) {
    list = list.filter(item => item.targetId !== newEntry.targetId && item.windowId !== newEntry.windowId);
    list.push(newEntry);
  }

  try {
    const targetsRes = await bSend('Target.getTargets').catch(() => null);
    if (targetsRes && Array.isArray(targetsRes.targetInfos)) {
      const activeTargetIds = new Set(targetsRes.targetInfos.map(t => t.targetId));
      list = list.filter(item => activeTargetIds.has(item.targetId));
    }
  } catch (_) {}

  openedAccountWindowsByProfile.set(profileId, list);

  // Lấy thông tin kích thước và vị trí của window chính để làm chuẩn
  let mainWindowId = null;
  let mainBounds = null;
  if (mainTargetId) {
    try {
      const mRes = await bSend('Browser.getWindowForTarget', { targetId: mainTargetId }).catch(() => null);
      mainWindowId = mRes?.result?.windowId;
      mainBounds = mRes?.result?.bounds;
    } catch (_) {}
  }

  // KHÔNG chia đôi màn hình và KHÔNG thay đổi kích thước của window chính
  // Chỉ sắp xếp các window mới của tài khoản theo hàng ngang với cùng kích thước như window chính
  const accountWindows = list.filter(item => item.windowId && item.windowId !== mainWindowId);
  const total = accountWindows.length;
  if (total === 0) return { ok: true, count: 0 };

  const display = window && !window.isDestroyed() ? screen.getDisplayMatching(window.getBounds()) : screen.getPrimaryDisplay();
  const area = display.workArea;

  const isMainMaximized = mainBounds?.windowState === 'maximized';
  const targetWidth = isMainMaximized ? Math.min(500, area.width) : (mainBounds?.width || Math.min(500, area.width));
  const targetHeight = isMainMaximized ? Math.min(900, area.height) : (mainBounds?.height || Math.min(900, area.height));
  const baseLeft = (mainBounds?.left !== undefined && !isMainMaximized) ? mainBounds.left : area.x;
  const baseTop = (mainBounds?.top !== undefined && !isMainMaximized) ? mainBounds.top : area.y;
  // Trên Windows 10/11, viền resize tàng hình (invisible DWM borders) chiếm ~7px mỗi bên (tổng 14px giữa 2 cửa sổ).
  // Trừ 14px trên Windows để các cửa sổ khít sát nhau hoàn toàn, không lộ màu nền desktop.
  const borderOverlap = process.platform === 'win32' ? 14 : 0;
  const strideX = Math.max(1, targetWidth - borderOverlap);

  console.log(`[navigateAds] 🪟 Sắp xếp ${total} window mới theo hàng ngang có cùng kích thước như window chính (${targetWidth}x${targetHeight})...`);

  for (let i = 0; i < total; i++) {
    const win = accountWindows[i];
    let left = baseLeft + (i + 1) * strideX;
    let top = baseTop;

    // Nếu vượt quá mép phải màn hình thì wrap lại trong vùng hiển thị
    if (left + targetWidth > area.x + area.width) {
      left = Math.max(area.x, area.x + ((i * strideX) % Math.max(1, area.width - targetWidth)));
    }

    const bounds = {
      windowState: 'normal',
      left: Math.round(left),
      top: Math.round(top),
      width: Math.round(targetWidth),
      height: Math.round(targetHeight)
    };

    try {
      await bSend('Browser.setWindowBounds', {
        windowId: win.windowId,
        bounds
      });
      console.log(`[navigateAds] 🪟 Window tài khoản #${i + 1}/${total} (windowId=${win.windowId}): left=${bounds.left}, top=${bounds.top}, width=${bounds.width}, height=${bounds.height}`);
    } catch (err) {
      console.warn(`[navigateAds] ⚠️ Lỗi đặt kích thước Window tài khoản (windowId=${win.windowId}):`, err?.message || err);
    }
  }

  return { ok: true, count: total };
}, { profileArgument: 0 });

const verifyAdsUrl = 'https://ads.google.com/aw/billing/advertiserverification';



const prepareProfileForRestore = trace.traced('profile.prepareRestore', (id, dir) => {
  const prefPath = path.join(dir, 'Default', 'Preferences');
  if (!fs.existsSync(prefPath)) return;
  try {
    const raw = fs.readFileSync(prefPath, 'utf8');
    const prefs = JSON.parse(raw);
    let changed = false;
    if (!prefs.profile) prefs.profile = {};
    if (prefs.profile.exit_type !== 'Normal' || prefs.profile.exited_cleanly !== true) {
      prefs.profile.exit_type = 'Normal';
      prefs.profile.exited_cleanly = true;
      changed = true;
    }
    if (!prefs.session || prefs.session.restore_on_startup !== 5) {
      prefs.session = prefs.session || {};
      prefs.session.restore_on_startup = 5;
      changed = true;
    }
    if (changed) {
      fs.writeFileSync(prefPath, JSON.stringify(prefs));
    }
  } catch (_) {}
}, { profileArgument: 0 });

const checkPortAlive = trace.traced('port.checkAlive', async port => {
  if (!port || typeof port !== 'number') return false;
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, { timeout: 1000 }, res => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
});

const findExistingProfilePort = trace.traced('port.findExisting', async id => {
  // 1. Kiểm tra file active-port.json trong thư mục profile
  try {
    if (store && typeof store.directory === 'function') {
      const portFile = path.join(store.directory(id), 'active-port.json');
      if (fs.existsSync(portFile)) {
        const data = JSON.parse(fs.readFileSync(portFile, 'utf8'));
        if (data && typeof data.port === 'number') {
          const alive = await checkPortAlive(data.port);
          if (alive) {
            console.log(`[port] 🔌 Tìm thấy cổng ${data.port} từ active-port.json cho profile ${id}`);
            return data.port;
          }
        }
      }
    }
  } catch (_) {}

  // 2. Tìm kiếm qua tiến trình Win32_Process của Chrome đang chạy trên máy (Windows)
  if (process.platform === 'win32') {
    try {
      const cmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name like 'chrome%'\\" | Where-Object { $_.CommandLine -like '*${id}*' } | Select-Object -ExpandProperty CommandLine"`;
      const out = execSync(cmd, { encoding: 'utf8', timeout: 4000 });
      const match = out.match(/--remote-debugging-port=(\d+)/);
      if (match) {
        const port = parseInt(match[1], 10);
        const alive = await checkPortAlive(port);
        if (alive) {
          console.log(`[port] 🔌 Phát hiện tiến trình Chrome đang chạy trên cổng ${port} cho profile ${id}`);
          try {
            if (store && typeof store.directory === 'function') {
              const portFile = path.join(store.directory(id), 'active-port.json');
              fs.writeFileSync(portFile, JSON.stringify({ port, timestamp: Date.now() }), { mode: 0o600 });
            }
          } catch (_) {}
          return port;
        }
      }
    } catch (_) {}
  }

  return null;
}, { profileArgument: 0 });

const activateRunningProfileWindow = trace.traced('profile.activateRunningWindow', async (targetPort) => {
  if (!targetPort) return false;
  try {
    const vRes = await fetch(`http://127.0.0.1:${targetPort}/json/version`);
    if (vRes.ok) {
      const vData = await vRes.json();
      if (vData.webSocketDebuggerUrl) {
        return await connectAndSendBrowser(vData.webSocketDebuggerUrl, async bSend => {
          const listRes = await fetch(`http://127.0.0.1:${targetPort}/json/list`).catch(() => null);
          const tabs = listRes && listRes.ok ? await listRes.json() : [];
          const pageTab = tabs.find(t => t.type === 'page') || tabs[0];
          if (pageTab?.id) {
            const winRes = await bSend('Browser.getWindowForTarget', { targetId: pageTab.id }).catch(() => null);
            const curBounds = winRes?.result?.bounds;
            const winId = winRes?.result?.windowId;
            if (winId && curBounds?.windowState === 'minimized') {
              await bSend('Browser.setWindowBounds', {
                windowId: winId,
                bounds: { windowState: 'normal' }
              }).catch(() => {});
            }
            await bSend('Target.activateTarget', { targetId: pageTab.id }).catch(() => {});
            return true;
          }
          return false;
        }, 2000);
      }
    }
  } catch (_) {}
  return false;
});

const openProfile = trace.traced('openProfile', async (id, url = null, tiled = false) => {
  if (deleting.has(id)) throw new Error('Profile đang được chỉnh sửa hoặc xóa.');
  const profile = store.get(id);
  const alreadyRunning = running.has(id);
  const currentPort = runningPorts.get(id);
  if (alreadyRunning) {
    if (currentPort) await activateRunningProfileWindow(currentPort);
    if (url) return openTiledWindowsInProfile(id, [url]);
    return { ok: true, port: currentPort, alreadyRunning: true };
  }
  const existingPort = await findExistingProfilePort(id);
  if (existingPort) {
    runningPorts.set(id, existingPort);
    await activateRunningProfileWindow(existingPort);
    if (url) return openTiledWindowsInProfile(id, [url]);
    return { ok: true, port: existingPort, attached: true };
  }
  const chrome = resolveChromium(settings.chromiumPath);
  if (!chrome.ready) throw new Error(chrome.error);
  const dir = store.directory(id);
  fs.mkdirSync(dir, { recursive: true });
  prepareProfileForRestore(id, dir);
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
  try {
    fs.writeFileSync(path.join(dir, 'active-port.json'), JSON.stringify({ port, pid: child.pid, timestamp: Date.now() }), { mode: 0o600 });
  } catch (_) {}
  passkeyWatcher.startPasskeyWatcher(child, port, () => accountDetails(id).passkey, id);
  child.once('exit', trace.traced('openProfile.exit', () => {
    if (running.get(id) === child) {
      running.delete(id);
      runningPorts.delete(id);
      windowSlots.delete(id);
      openedAccountWindowsByProfile.delete(id);
      void closeProxy(id);
      try { fs.unlinkSync(path.join(dir, 'active-port.json')); } catch (_) {}
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
        openedAccountWindowsByProfile.delete(id);
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

const getOrAttachProfilePort = trace.traced('port.getOrAttach', async (id, maxWaitMs = 12000) => {
  let port = runningPorts.get(id);
  if (port) {
    const alive = await checkPortAlive(port);
    if (alive) return port;
    runningPorts.delete(id);
  }

  const existingPort = await findExistingProfilePort(id);
  if (existingPort) {
    runningPorts.set(id, existingPort);
    return existingPort;
  }

  console.log(`[port] 🚀 Chưa có tiến trình nào đang chạy -> Mở profile ${id}...`);
  try {
    await openProfile(id);
  } catch (err) {
    console.log(`[port] ℹ️ openProfile: ${err.message}`);
  }

  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    port = runningPorts.get(id);
    if (port && await checkPortAlive(port)) return port;
    const found = await findExistingProfilePort(id);
    if (found) {
      runningPorts.set(id, found);
      return found;
    }
    await new Promise(r => setTimeout(r, 400));
  }

  return runningPorts.get(id) || null;
}, { profileArgument: 0 });

const CLICK_START_NOW_SCRIPT = `(() => {
  const triggerClick = el => {
    try { el.scrollIntoView({ block: 'center' }); } catch (_) {}
    try { el.focus(); } catch (_) {}
    try { el.click(); } catch (_) {}
    for (const evt of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      try { el.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window })); } catch (_) {}
    }
  };

  const isVisible = el => {
    if (!el) return false;
    if (el.offsetParent === null && el.getClientRects().length === 0) return false;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
    } catch (_) {}
    return true;
  };

  const normalize = s => (s || '')
    .toString()
    .toLowerCase()
    .replace(/[\\s\\u00A0]+/g, ' ')
    .replace(/[→›»►>–—\\-_]/g, '')
    .trim();

  const isExcluded = s => {
    const t = normalize(s);
    return t.includes('bắt đầu từ đâu') ||
           t.includes('where to start') ||
           t.includes('how to start') ||
           t.includes('tìm hiểu thêm') ||
           t.includes('learn more') ||
           t.includes('trợ giúp') ||
           t.includes('help');
  };

  const exactTargets = ['bắt đầu ngay', 'start now', 'get started', 'bắt đầu ngay bây giờ'];

  const candidates = Array.from(document.querySelectorAll(
    'a, button, [role="button"], div[role="button"], input[type="button"], input[type="submit"], .glue-button'
  ));

  // 1. Ưu tiên cao nhất: Text hoặc aria-label khớp CHÍNH XÁC "Bắt đầu ngay" / "Start now" / "Get started"
  for (const el of candidates) {
    if (!isVisible(el)) continue;
    const text = normalize(el.innerText || el.textContent);
    const aria = normalize(el.getAttribute('aria-label'));
    const val = normalize(el.value);
    
    if (isExcluded(text) || isExcluded(aria)) continue;

    if (exactTargets.includes(text) || exactTargets.includes(aria) || exactTargets.includes(val)) {
      const targetEl = el.closest('a, button, [role="button"]') || el;
      triggerClick(targetEl);
      return 'clicked:' + (text || aria || val);
    }
  }

  // 2. Selector chuẩn theo thuộc tính data-g-action hoặc CTA class của Google Ads
  const selectors = [
    'a[data-g-action="Start now"]',
    'a[data-g-action="start now" i]',
    'a[data-g-action="Get started"]',
    'a[data-g-action="get-started" i]',
    'a[data-g-action="Bắt đầu ngay"]',
    'a[data-g-action="bắt đầu ngay" i]',
    'button[data-g-action="Start now"]',
    'button[data-g-action="Get started"]',
    'button[data-g-action="Bắt đầu ngay"]',
    'a.header__cta',
    '.glue-header__cta-link',
    'a.glue-button--high-emphasis',
    'button.glue-button--high-emphasis'
  ];
  for (const sel of selectors) {
    const list = Array.from(document.querySelectorAll(sel));
    for (const el of list) {
      if (!isVisible(el)) continue;
      const text = normalize(el.innerText || el.textContent);
      if (isExcluded(text)) continue;
      if (!text || exactTargets.some(t => text.includes(t))) {
        const targetEl = el.closest('a, button, [role="button"]') || el;
        triggerClick(targetEl);
        return 'clicked:' + (text || sel);
      }
    }
  }

  // 3. Khớp tiền tố (ví dụ: "Bắt đầu ngay hôm nay", "Start now today")
  for (const el of candidates) {
    if (!isVisible(el)) continue;
    const text = normalize(el.innerText || el.textContent);
    const aria = normalize(el.getAttribute('aria-label'));
    const val = normalize(el.value);
    const target = text || aria || val;
    if (!target || isExcluded(target) || target.length > 35) continue;
    for (const prefix of exactTargets) {
      if (target.startsWith(prefix)) {
        const targetEl = el.closest('a, button, [role="button"]') || el;
        triggerClick(targetEl);
        return 'clicked:' + target;
      }
    }
  }

  return false;
})()`;

const makeSelectMccScript = (cleanMcc, formattedMcc) => `(() => {
  const clean = ${JSON.stringify(cleanMcc || '')};
  const formatted = ${JSON.stringify(formattedMcc || '')};

  const triggerClick = el => {
    try { el.scrollIntoView({ block: 'center' }); } catch (_) {}
    try { el.focus(); } catch (_) {}
    try { el.click(); } catch (_) {}
    for (const evt of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      try { el.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window })); } catch (_) {}
    }
  };

  const isVisible = el => {
    if (!el) return false;
    if (el.offsetParent === null && el.getClientRects().length === 0) return false;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
    } catch (_) {}
    return true;
  };

  // 1. Kiểm tra nếu URL hiện tại đã ở trong MCC (ocid hoặc ascid)
  const href = location.href;
  if (clean && (href.includes('ocid=' + clean) || href.includes('ascid=' + clean))) {
    return { status: 'already_in_mcc', matched: formatted };
  }

  // 2. Tìm ô tìm kiếm tài khoản: "Search for account name or CID" / "Tìm kiếm tên tài khoản hoặc CID"
  const searchInputs = Array.from(document.querySelectorAll(
    'input[placeholder*="CID" i], input[placeholder*="Search" i], input[placeholder*="Tìm" i], ' +
    'input[aria-label*="Search" i], input[aria-label*="Tìm" i], input[aria-label*="CID" i], ' +
    'input[type="search"], input.search-input, material-input input'
  ));
  let searchInput = searchInputs.find(isVisible);
  if (!searchInput) {
    const allInputs = Array.from(document.querySelectorAll('input'));
    searchInput = allInputs.find(i => isVisible(i) && !i.disabled && i.type !== 'hidden' && i.type !== 'checkbox');
  }

  let typed = false;
  if (searchInput && (formatted || clean)) {
    const curVal = (searchInput.value || '').trim();
    if (!curVal.includes(clean) && !curVal.includes(formatted)) {
      try {
        searchInput.focus();
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (nativeSetter) {
          nativeSetter.call(searchInput, formatted);
        } else {
          searchInput.value = formatted;
        }
        searchInput.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        searchInput.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        searchInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Enter' }));
      } catch (_) {}
      typed = true;
    }
  }

  // 3. Tìm phần tử trong danh sách chứa ID MCC (cả dạng format 477-279-9880 lẫn 4772799880)
  const candidateElements = Array.from(document.querySelectorAll(
    'tr, li, [role="row"], [role="button"], [role="link"], div.account-item, div.item, a, button, span, div'
  ));

  const matches = [];
  for (const el of candidateElements) {
    if (!isVisible(el)) continue;
    const text = (el.innerText || el.textContent || '').trim();
    if ((formatted && text.includes(formatted)) || (clean && text.includes(clean))) {
      if (text.length < 350) {
        matches.push({ el, len: text.length });
      }
    }
  }

  if (matches.length > 0) {
    matches.sort((a, b) => a.len - b.len);
    const best = matches[0].el;
    const clickable = best.closest('[role="button"], [role="row"], [role="link"], tr, li, button, a, div[tabindex]') || best;
    triggerClick(clickable);
    return { status: 'selected', matched: formatted, typed };
  }

  return typed ? { status: 'typed', matched: formatted } : false;
})()`;

const WAIT_FOR_PAGE_LOAD_SCRIPT = `(() => {
  // 1. Kiểm tra document.readyState
  if (document.readyState !== 'complete') {
    return { ready: false, reason: 'readyState=' + document.readyState };
  }

  // 2. Kiểm tra các spinner / progressbar của Google Ads
  const spinners = Array.from(document.querySelectorAll(
    'material-linear-progress, material-spinner, [role="progressbar"], .particle-animation, .loading-spinner, .splash-screen, div[aria-label*="loading" i], div[aria-label*="đang tải" i]'
  ));
  for (const el of spinners) {
    if (el.offsetParent !== null || el.getClientRects().length > 0) {
      try {
        const style = window.getComputedStyle(el);
        if (style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') > 0.05) {
          return { ready: false, reason: 'spinner_visible' };
        }
      } catch (_) {}
    }
  }

  // 3. Kiểm tra xem đã có phần tử tương tác (button, dialog, toolbar, nội dung overview) xuất hiện chưa
  const interactives = Array.from(document.querySelectorAll(
    'material-button, button, [role="button"], [role="dialog"], div.dialog, [role="main"], nav, header'
  ));
  const hasInteractive = interactives.some(el => el.offsetParent !== null || el.getClientRects().length > 0);
  if (!hasInteractive) {
    return { ready: false, reason: 'no_interactive_elements' };
  }

  return { ready: true };
})()`;

const FIND_ACCOUNT_PICKER_SCRIPT = `(() => {
  const isVisible = el => {
    if (!el) return false;
    if (el.offsetParent === null && el.getClientRects().length === 0) return false;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
    } catch (_) {}
    return true;
  };

  // 1. Quét tìm các node chứa định dạng CID 10 chữ số (xxx-xxx-xxxx)
  const cidRegex = /\\b\\d{3}-\\d{3}-\\d{4}\\b/;
  const allElements = Array.from(document.querySelectorAll('*'));
  const candidateNodes = [];

  for (const el of allElements) {
    if (!isVisible(el)) continue;
    const text = (el.innerText || el.textContent || '').trim();
    if (cidRegex.test(text) && text.length < 200) {
      candidateNodes.push({ el, text, len: text.length });
    }
  }

  candidateNodes.sort((a, b) => a.len - b.len);

  for (const item of candidateNodes) {
    let curr = item.el;
    let picker = null;
    while (curr && curr !== document.body) {
      const rect = curr.getBoundingClientRect();
      const isTarget = curr.matches?.(
        'button, [role="button"], [role="combobox"], material-dropdown-select, .particle-header-account-picker, .account-picker, [debugid="account-picker"], .mcc-nav-popup-trigger'
      );
      if (isTarget && rect.width >= 50 && rect.height >= 20) {
        picker = curr;
        break;
      }
      curr = curr.parentElement;
    }

    if (!picker) {
      curr = item.el;
      while (curr && curr !== document.body) {
        const rect = curr.getBoundingClientRect();
        if (rect.width >= 60 && rect.height >= 25 && rect.height <= 90) {
          picker = curr;
          break;
        }
        curr = curr.parentElement;
      }
    }

    if (picker && isVisible(picker)) {
      const rect = picker.getBoundingClientRect();
      const text = (picker.innerText || picker.textContent || '').trim().replace(/[\\r\\n\\t]+/g, ' ');
      const aria = picker.getAttribute('aria-label') || '';
      const tag = picker.tagName.toLowerCase();
      const role = picker.getAttribute('role') || '';
      const classes = picker.className || '';
      const hasArrow = Boolean(picker.querySelector('material-icon, svg, [role="img"], i, .arrow'));

      return {
        found: true,
        tag,
        role,
        classes: typeof classes === 'string' ? classes : '',
        aria,
        text,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        hasArrow
      };
    }
  }

  // 2. Fallback tìm theo các selector chuẩn của Google Ads
  const standardSelectors = [
    'material-dropdown-select[debugid="account-picker"]',
    '.particle-header-account-picker',
    '[data-guidedhelpid="account-picker"]',
    'button[aria-haspopup="true"]',
    'div[role="button"][aria-haspopup="true"]'
  ];
  for (const sel of standardSelectors) {
    const el = document.querySelector(sel);
    if (el && isVisible(el)) {
      const rect = el.getBoundingClientRect();
      const text = (el.innerText || el.textContent || '').trim().replace(/[\\r\\n\\t]+/g, ' ');
      return {
        found: true,
        selector: sel,
        tag: el.tagName.toLowerCase(),
        text,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      };
    }
  }

  return { found: false };
})()`;

const TRIGGER_CLICK_PICKER_SCRIPT = `(() => {
  const isVisible = el => {
    if (!el) return false;
    if (el.offsetParent === null && el.getClientRects().length === 0) return false;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
    } catch (_) {}
    return true;
  };

  const cidRegex = /\\b\\d{3}-\\d{3}-\\d{4}\\b/;
  const allElements = Array.from(document.querySelectorAll('*'));
  const candidateNodes = [];

  for (const el of allElements) {
    if (!isVisible(el)) continue;
    const text = (el.innerText || el.textContent || '').trim();
    if (cidRegex.test(text) && text.length < 200) {
      candidateNodes.push({ el, text, len: text.length });
    }
  }

  candidateNodes.sort((a, b) => a.len - b.len);

  let container = null;
  // Tìm container bao ngoài có kích thước đầy đủ (tránh nhặt các span nhãn nhỏ 18px)
  for (const item of candidateNodes) {
    let curr = item.el;
    while (curr && curr !== document.body) {
      const rect = curr.getBoundingClientRect();
      const matchesSelector = curr.matches?.(
        'button, [role="button"], [role="combobox"], material-dropdown-select, .mcc-nav-popup-trigger, [debugid="account-picker"], .particle-header-account-picker'
      );
      if (matchesSelector && rect.width >= 50 && rect.height >= 20) {
        container = curr;
        break;
      }
      curr = curr.parentElement;
    }
    if (container) break;
  }

  if (!container && candidateNodes.length > 0) {
    let curr = candidateNodes[0].el;
    while (curr && curr !== document.body) {
      const rect = curr.getBoundingClientRect();
      if (rect.width >= 60 && rect.height >= 25 && rect.height <= 90) {
        container = curr;
        break;
      }
      curr = curr.parentElement;
    }
  }

  if (!container) {
    container = document.querySelector('.mcc-nav-popup-trigger, [debugid="account-picker"]');
  }

  if (!container) {
    return { clicked: false, reason: 'container_not_found' };
  }

  const cRect = container.getBoundingClientRect();
  const outerPicker = container.closest('mcc-customer-picker, [navi-id="mcc-customer-picker"], awsm-breadcrumbs, .particle-header-account-picker, material-dropdown-select, header') || container.parentElement || container;
  const oRect = outerPicker.getBoundingClientRect();

  // Tìm icon / mũi tên dropdown bên trong container, ở sibling, trong outerPicker hoặc trên header
  const arrowSelectors = [
    '.dropdown-section',
    'material-icon.dropdown-icon',
    '.dropdown-icon',
    '[icon="arrow_drop_down"]',
    'material-icon[name="arrow_drop_down"]',
    '.arrow_drop_down',
    '.drop-down',
    '.arrow'
  ];

  let arrowEl = null;
  const searchRoots = [container, container.parentElement, outerPicker, document.querySelector('header, .app-bar')].filter(Boolean);
  for (const root of searchRoots) {
    for (const sel of arrowSelectors) {
      const found = root.querySelector(sel);
      if (found && isVisible(found)) {
        const r = found.getBoundingClientRect();
        // Kiểm tra xem vị trí có nằm ở khu vực account picker không (tránh icon khác)
        if (r.width > 0 && r.height > 0 && Math.abs(r.y - cRect.y) < 40) {
          arrowEl = found;
          break;
        }
      }
    }
    if (arrowEl) break;
  }

  // Fallback quét tất cả phần tử trong outerPicker tìm text hoặc icon chứa "arrow_drop_down"
  if (!arrowEl && outerPicker) {
    const allDesc = Array.from(outerPicker.querySelectorAll('*'));
    arrowEl = allDesc.find(e => {
      if (!isVisible(e)) return false;
      const text = (e.innerText || e.textContent || '').trim();
      const icon = (e.getAttribute('icon') || '').trim();
      return text.includes('arrow_drop_down') || icon.includes('arrow_drop_down');
    });
  }

  const aRect = arrowEl ? arrowEl.getBoundingClientRect() : null;

  try { (arrowEl || container).scrollIntoView({ block: 'center' }); } catch (_) {}
  try { (arrowEl || container).focus(); } catch (_) {}

  // Mép phải của toàn bộ picker (nơi mũi tên luôn ngự trị ở mọi layout split button)
  const rightEdgeX = Math.round(Math.max(cRect.x + cRect.width, oRect.x + oRect.width) - 20);
  const midY = Math.round(cRect.y + cRect.height / 2);

  return {
    clicked: true,
    text: (container.innerText || container.textContent || '').trim().replace(/[\\r\\n\\t]+/g, ' '),
    containerRect: {
      x: Math.round(cRect.x),
      y: Math.round(cRect.y),
      width: Math.round(cRect.width),
      height: Math.round(cRect.height)
    },
    arrowCenter: (aRect && aRect.width > 0 && aRect.height > 0) ? {
      x: Math.round(aRect.x + aRect.width / 2),
      y: Math.round(aRect.y + aRect.height / 2)
    } : null,
    arrowEdgeCenter: {
      x: rightEdgeX,
      y: midY
    },
    containerCenter: {
      x: Math.round(cRect.x + cRect.width / 2),
      y: Math.round(cRect.y + cRect.height / 2)
    }
  };
})()`;

const CHECK_POPUP_OPEN_SCRIPT = `(() => {
  // 1. Kiểm tra các phần tử đặc trưng của popup danh sách tài khoản Google Ads
  const popupEl = document.querySelector(
    '.customer-search-button, material-icon.search-material-icon, .search-material-icon, awsm-customer-item, .customer-tree, .acx-overlay-container .customer-id, .popup-wrapper.visible, .pane.visible, awsm-customer-search'
  );
  if (popupEl && (popupEl.offsetParent !== null || popupEl.getClientRects().length > 0)) {
    const r = popupEl.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return true;
  }

  // 2. Kiểm tra container overlay hoặc popup
  const popups = document.querySelectorAll(
    '.acx-overlay-container, .popup-wrapper, .pane, material-popup, [role="listbox"], [role="menu"]'
  );
  for (const p of popups) {
    const r = p.getBoundingClientRect();
    if (r.width > 80 && r.height > 80) {
      const text = p.innerText || '';
      if (text.includes('Account status') || text.includes('search') || text.includes('All accounts') || text.includes('accounts')) {
        return true;
      }
    }
  }
  return false;
})()`;

const CLICK_MAGNIFYING_GLASS_SCRIPT = `(() => {
  const isVisible = el => {
    if (!el) return false;
    if (el.offsetParent === null && el.getClientRects().length === 0) return false;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
    } catch (_) {}
    return true;
  };

  const triggerClick = el => {
    try { el.scrollIntoView({ block: 'center' }); } catch (_) {}
    try { el.focus(); } catch (_) {}
    try { el.click(); } catch (_) {}
    for (const evt of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      try { el.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window })); } catch (_) {}
    }
  };

  // 1. Ưu tiên tìm nút kính lúp trong menu popup / breadcrumbs chọn tài khoản (customer-search-button)
  const popupGlassSelectors = [
    '.customer-search-button',
    '[aria-label*="Search customers" i]',
    '.search-material-icon',
    'awsm-breadcrumbs-popup .search-icon',
    '.top-bar-right-content [aria-label*="Search" i]',
    'material-popup material-icon[icon="search"]',
    '.mcc-nav-popup material-icon[icon="search"]',
    'material-popup [aria-label*="Search" i]',
    '.mcc-nav-popup [aria-label*="Search" i]',
    'material-popup [aria-label*="Tìm" i]'
  ];

  for (const sel of popupGlassSelectors) {
    const el = document.querySelector(sel);
    if (el && isVisible(el)) {
      const target = el.closest('button, [role="button"], div.customer-search-button, material-button') || el;
      const rect = target.getBoundingClientRect();
      triggerClick(target);
      return {
        clicked: true,
        selector: sel,
        inPopup: true,
        tag: target.tagName.toLowerCase(),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        center: { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
      };
    }
  }

  // 2. Tìm theo nút Search (kính lúp) trên thanh điều hướng chính (header)
  const headerSelectors = [
    '.app-bar-icon.search-icon',
    'material-button.goto.icon-text',
    'button[aria-label*="Search" i]',
    'button[aria-label*="Tìm kiếm" i]',
    '[data-anchor-id="search"]',
    '.search-button'
  ];
  for (const sel of headerSelectors) {
    const el = document.querySelector(sel);
    if (el && isVisible(el)) {
      const target = el.closest('button, [role="button"], material-button') || el;
      const rect = target.getBoundingClientRect();
      triggerClick(target);
      return {
        clicked: true,
        selector: sel,
        inPopup: false,
        tag: target.tagName.toLowerCase(),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        center: { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
      };
    }
  }

  // 3. Fallback tìm bất kỳ material-icon "search" nào đang hiển thị
  const allIcons = Array.from(document.querySelectorAll('material-icon, [data-icon="search"]')).filter(isVisible);
  for (const icon of allIcons) {
    const text = (icon.innerText || icon.textContent || '').trim().toLowerCase();
    const name = (icon.getAttribute('name') || icon.getAttribute('icon') || '').toLowerCase();
    if (text === 'search' || name === 'search') {
      const target = icon.closest('button, [role="button"], material-button, div') || icon;
      const rect = target.getBoundingClientRect();
      triggerClick(target);
      return {
        clicked: true,
        selector: 'material-icon:search',
        tag: target.tagName.toLowerCase(),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        center: { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
      };
    }
  }

  return { clicked: false };
})()`;

const FOCUS_CUSTOMER_SEARCH_INPUT_SCRIPT = `(() => {
  const input = document.querySelector('awsm-customer-search input.input-area, material-input.search-input input, input.input-area') ||
                (document.activeElement && document.activeElement.tagName === 'INPUT' ? document.activeElement : null);
  if (!input) return { found: false };
  input.focus();
  const rect = input.getBoundingClientRect();
  return {
    found: true,
    tag: input.tagName.toLowerCase(),
    className: input.className,
    value: input.value,
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
  };
})()`;

const navigateCurrentTabToAds = trace.traced('ads.navigateCurrentTab', async (id, targetUrl = 'https://ads.google.com/', rawMccId = null, rawCustomerId = null, defaultActionUrl = null) => {
  const port = await getOrAttachProfilePort(id);
  if (!port) {
    throw new Error('Không thể kết nối cổng điều khiển trình duyệt của profile.');
  }

  // Chờ danh sách tab từ Chromium sẵn sàng
  let pages = [];
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          const filtered = data.filter(t => t.type === 'page' && !t.url.startsWith('devtools://'));
          if (filtered.length > 0) {
            pages = filtered;
            break;
          }
        }
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }

  const destUrl = targetUrl || 'https://ads.google.com/';

  // Tìm tab ads.google.com đã mở sẵn, hoặc tab đang hiển thị (visible), hoặc tab đầu tiên
  let targetTab = pages.find(t => t.url && t.url.includes('ads.google.com'));
  if (!targetTab) {
    if (pages.length === 1) {
      targetTab = pages[0];
    } else if (pages.length > 1) {
      for (const tab of pages) {
        if (!tab.webSocketDebuggerUrl) continue;
        try {
          const isVisible = await connectAndSendBrowser(tab.webSocketDebuggerUrl, async send => {
            await send('Runtime.enable');
            const res = await send('Runtime.evaluate', {
              expression: 'document.visibilityState === "visible"',
              returnByValue: true
            });
            return res?.result?.result?.value === true;
          }, 1500);
          if (isVisible) {
            targetTab = tab;
            break;
          }
        } catch (_) {}
      }
      if (!targetTab) targetTab = pages[0];
    }
  }

  if (targetTab && targetTab.webSocketDebuggerUrl) {
    await connectAndSendBrowser(targetTab.webSocketDebuggerUrl, async send => {
      await send('Page.enable');
      await send('Runtime.enable');

      // 1. Thử Page.navigate (nếu chưa ở trang Google Ads Overview)
      const curUrlRes = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
      const curUrl = curUrlRes?.result?.result?.value || '';
      if (!curUrl.includes('/aw/overview') && !curUrl.includes('/aw/')) {
        console.log('[navigateAds] 🌐 Điều hướng tab tới:', destUrl);
        await send('Page.navigate', { url: destUrl });
        await send('Runtime.evaluate', {
          expression: `if (window.location.href !== ${JSON.stringify(destUrl)} && !window.location.href.includes('/aw/')) { window.location.href = ${JSON.stringify(destUrl)}; }`,
          returnByValue: true
        }).catch(() => {});
      } else {
        console.log('[navigateAds] ℹ️ Tab đã ở sẵn trang Google Ads Overview:', curUrl);
      }

      // 3. Đưa tab lên trước
      await send('Page.bringToFront');

      // 4. Chờ trang tải và tự động bấm nút "Bắt đầu ngay" / "Start now"
      const startTime = Date.now();
      let clicked = false;
      while (Date.now() - startTime < 16000) {
        await new Promise(r => setTimeout(r, 600));

        // Nếu trình duyệt đã chuyển thẳng vào giao diện Ads hoặc chọn tài khoản, bỏ qua nút Bắt đầu ngay
        const urlRes = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
        const curUrl = urlRes?.result?.result?.value || '';
        if (curUrl.includes('/aw/') || curUrl.includes('/selectaccount') || curUrl.includes('/um/identity')) {
          console.log('[navigateAds] ⏭️ Đã vào thẳng giao diện Ads:', curUrl);
          clicked = true;
          break;
        }

        // Thử tìm và click nút Bắt đầu ngay / Start now
        const clickRes = await send('Runtime.evaluate', { expression: CLICK_START_NOW_SCRIPT, returnByValue: true });
        const clickVal = clickRes?.result?.result?.value;
        if (clickVal && typeof clickVal === 'string' && clickVal.startsWith('clicked')) {
          console.log('[navigateAds] 🖱️ Đã nhấn nút:', clickVal);
          clicked = true;
          // Chờ thêm 1.5s để điều hướng sau khi nhấn nút có hiệu lực
          await new Promise(r => setTimeout(r, 1500));
          break;
        }
      }

      if (!clicked) {
        console.log('[navigateAds] ℹ️ Không phát hiện nút "Bắt đầu ngay" / "Start now" hoặc trang đã tải xong.');
      }

      // 5. Tự động nhập ID MCC và chọn tài khoản MCC trên trang selectaccount (nếu có yêu cầu MCC)
      const effectiveMcc = rawMccId || lastUsedMccId;
      if (effectiveMcc) {
        const cleanMcc = adsVerification.cleanCustomerId(effectiveMcc);
        const formattedMcc = adsVerification.formatCustomerId(effectiveMcc);
        if (cleanMcc) {
          console.log(`[navigateAds] ⏳ Đang chờ giao diện chọn tài khoản để nhập ID MCC: ${formattedMcc}...`);
          const mccStartTime = Date.now();
          let mccSelected = false;
          while (Date.now() - mccStartTime < 25000) {
            await new Promise(r => setTimeout(r, 800));

            const curUrlRes = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
            const curUrl = curUrlRes?.result?.result?.value || '';

            // Nếu đã ở sẵn trong MCC (có ocid hoặc ascid khớp cleanMcc)
            if (curUrl.includes('ocid=' + cleanMcc) || curUrl.includes('ascid=' + cleanMcc)) {
              console.log(`[navigateAds] ✅ Trình duyệt đã ở trong tài khoản MCC: ${formattedMcc}`);
              mccSelected = true;
              break;
            }

            const selectScript = makeSelectMccScript(cleanMcc, formattedMcc);
            const selectRes = await send('Runtime.evaluate', { expression: selectScript, returnByValue: true });
            const selectVal = selectRes?.result?.result?.value;

            if (selectVal && typeof selectVal === 'object') {
              if (selectVal.status === 'selected' || selectVal.status === 'already_in_mcc') {
                console.log(`[navigateAds] 🎯 Đã tìm thấy và chọn tài khoản MCC: ${formattedMcc}!`);
                mccSelected = true;
                await new Promise(r => setTimeout(r, 2000));
                break;
              } else if (selectVal.status === 'typed') {
                console.log(`[navigateAds] ⌨️ Đã nhập ID MCC ${formattedMcc} vào ô tìm kiếm...`);
              }
            }
          }

          if (!mccSelected) {
            console.log(`[navigateAds] ℹ️ Đã hoàn tất bước chọn MCC ${formattedMcc}.`);
          }
        }
      }

      // 6. Chờ khi trang đã vào tới /aw/overview hoặc /aw/ -> Nhấn Tab 1 lần -> Nhấn Enter
      console.log('[navigateAds] ⏳ Đang chờ trang Google Ads Overview (/aw/overview)...');
      const overviewStartTime = Date.now();
      let overviewReached = false;
      while (Date.now() - overviewStartTime < 30000) {
        await new Promise(r => setTimeout(r, 800));
        const curUrlRes = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
        const curUrl = curUrlRes?.result?.result?.value || '';
        if (curUrl.includes('/aw/overview') || curUrl.includes('/aw/')) {
          overviewReached = true;
          console.log('[navigateAds] 🏁 Đã vào tới trang Google Ads Overview:', curUrl);
          break;
        }
      }

      if (overviewReached) {
        let savedWindowId = null;
        let savedBounds = null;

        // Lưu lại kích thước cửa sổ ban đầu và phóng to cửa sổ (maximize) để Google Ads hiển thị đầy đủ giao diện desktop
        try {
          console.log('[navigateAds] 🔲 Bắt đầu kiểm tra và phóng to cửa sổ trình duyệt (maximize)...');
          const vRes = await fetch(`http://127.0.0.1:${port}/json/version`);
          if (vRes.ok) {
            const vData = await vRes.json();
            if (vData.webSocketDebuggerUrl) {
              await connectAndSendBrowser(vData.webSocketDebuggerUrl, async bSend => {
                const winRes = await bSend('Browser.getWindowForTarget', { targetId: targetTab.id });
                savedWindowId = winRes?.result?.windowId;
                savedBounds = winRes?.result?.bounds;
                if (savedWindowId) {
                  console.log(`[navigateAds] 💾 Đã lưu kích thước cửa sổ ban đầu: windowId=${savedWindowId}, state=${savedBounds?.windowState || 'normal'}, width=${savedBounds?.width}, height=${savedBounds?.height}`);
                  console.log('[navigateAds] 🔲 Đang gửi lệnh phóng to cửa sổ trình duyệt (Browser.setWindowBounds maximize)...');
                  await bSend('Browser.setWindowBounds', {
                    windowId: savedWindowId,
                    bounds: { windowState: 'maximized' }
                  });
                  console.log('[navigateAds] ✅ Đã phóng to cửa sổ trình duyệt (maximize) thành công.');
                } else {
                  console.log('[navigateAds] ⚠️ Không lấy được windowId của tab từ Browser.getWindowForTarget.');
                }
              }, 3000);
            } else {
              console.log('[navigateAds] ⚠️ Không tìm thấy webSocketDebuggerUrl để kết nối Browser CDP.');
            }
          } else {
            console.log(`[navigateAds] ⚠️ Không thể truy vấn /json/version (status ${vRes.status}).`);
          }
        } catch (err) {
          console.log('[navigateAds] ⚠️ Lỗi khi phóng to trình duyệt:', err?.message || err);
        }

        console.log('[navigateAds] ⏳ Đang chờ trang Overview tải xong hoàn toàn (readyState, spinners, dialogs)...');
        const loadStartTime = Date.now();
        let stableCount = 0;

        while (Date.now() - loadStartTime < 25000) {
          await new Promise(r => setTimeout(r, 600));

          const readyRes = await send('Runtime.evaluate', { expression: WAIT_FOR_PAGE_LOAD_SCRIPT, returnByValue: true });
          const readyVal = readyRes?.result?.result?.value;

          if (readyVal && readyVal.ready) {
            stableCount++;
            if (stableCount >= 2) {
              console.log('[navigateAds] ✅ Trang Overview đã tải xong hoàn tất và sẵn sàng.');
              break;
            }
          } else {
            stableCount = 0;
          }
        }

        // Chờ thêm 1.5 giây sau khi trang ổn định để bất kỳ popup/dialog nào hiển thị trọn vẹn
        await new Promise(r => setTimeout(r, 1500));

        // Kiểm tra và log thông tin ô chọn tài khoản trên header theo yêu cầu
        try {
          const pickerRes = await send('Runtime.evaluate', { expression: FIND_ACCOUNT_PICKER_SCRIPT, returnByValue: true });
          const pickerVal = pickerRes?.result?.result?.value;
          if (pickerVal && pickerVal.found) {
            console.log('================================================================');
            console.log('🏢 [navigateAds] ĐÃ TÌM THẤY Ô TÀI KHOẢN (ACCOUNT PICKER) TRÊN HEADER:');
            console.log(`   - Nội dung hiển thị:   "${pickerVal.text}"`);
            console.log(`   - Tọa độ & kích thước: x=${pickerVal.rect?.x}, y=${pickerVal.rect?.y}, rộng=${pickerVal.rect?.width}px, cao=${pickerVal.rect?.height}px`);
            console.log(`   - Thẻ & Vai trò:       <${pickerVal.tag}> (role="${pickerVal.role || 'none'}")`);
            if (pickerVal.aria) console.log(`   - Aria-label:           "${pickerVal.aria}"`);
            if (pickerVal.classes) console.log(`   - Class name:           "${pickerVal.classes}"`);
            console.log(`   - Mũi tên Dropdown:    ${pickerVal.hasArrow ? 'Có (dropdown icon/caret)' : 'Không'}`);
            console.log('================================================================');
          } else {
            console.log('[navigateAds] ⚠️ Chưa phát hiện ô tài khoản trên header.');
          }
        } catch (_) {}

        await send('Page.bringToFront');
        await send('Runtime.evaluate', { expression: 'window.focus();' }).catch(() => {});

        // 7. Nhấn vào ô tài khoản để mở danh sách tài khoản (trên cửa sổ đã thu nhỏ)
        console.log('[navigateAds] 🖱️ Đang trigger click vào ô tài khoản trên header để mở danh sách...');
        const clickRes = await send('Runtime.evaluate', { expression: TRIGGER_CLICK_PICKER_SCRIPT, returnByValue: true });
        const clickVal = clickRes?.result?.result?.value;

        if (clickVal && clickVal.clicked) {
          console.log(`[navigateAds] 🎯 Đã tìm thấy ô tài khoản: "${clickVal.text}"`);
          console.log(`   - Khung container: x=${clickVal.containerRect?.x}, y=${clickVal.containerRect?.y}, rộng=${clickVal.containerRect?.width}px, cao=${clickVal.containerRect?.height}px`);
          if (clickVal.arrowCenter) {
            console.log(`   - Mũi tên dropdown: x=${clickVal.arrowCenter.x}, y=${clickVal.arrowCenter.y}`);
          } else {
            console.log(`   - Mép phải nút (vị trí mũi tên dự phòng): x=${clickVal.arrowEdgeCenter?.x}, y=${clickVal.arrowEdgeCenter?.y}`);
          }

          // Kiểm tra xem menu popup đã mở sẵn chưa
          let popupOpen = false;
          try {
            const initialCheck = await send('Runtime.evaluate', { expression: CHECK_POPUP_OPEN_SCRIPT, returnByValue: true });
            popupOpen = initialCheck?.result?.result?.value === true;
          } catch (_) {}

          if (popupOpen) {
            console.log('[navigateAds] ℹ️ Menu danh sách tài khoản đã mở sẵn từ trước.');
          } else {
            // Tọa độ mục tiêu: ƯU TIÊN MŨI TÊN DROPDOWN (vì là split-button, click vào nhãn tài khoản bên trái sẽ KHÔNG mở popup)
            const targetPos = clickVal.arrowCenter || clickVal.arrowEdgeCenter || clickVal.containerCenter;
            if (targetPos?.x && targetPos?.y) {
              console.log(`[navigateAds] 🖱️ Gửi CDP Mouse Click vào mũi tên dropdown tại tọa độ x=${targetPos.x}, y=${targetPos.y}...`);
              try {
                await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: targetPos.x, y: targetPos.y });
                await new Promise(r => setTimeout(r, 50));
                await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: targetPos.x, y: targetPos.y, button: 'left', buttons: 1, clickCount: 1 });
                await new Promise(r => setTimeout(r, 80));
                await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: targetPos.x, y: targetPos.y, button: 'left', buttons: 0, clickCount: 1 });
              } catch (_) {}
            }

              // Thu nhỏ cửa sổ lại như ban đầu theo yêu cầu trước khi thao tác mở menu tài khoản
        if (savedWindowId && savedBounds) {
          try {
            const vRes = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (vRes.ok) {
              const vData = await vRes.json();
              if (vData.webSocketDebuggerUrl) {
                await connectAndSendBrowser(vData.webSocketDebuggerUrl, async bSend => {
                  console.log('[navigateAds] 🔄 Đang thu nhỏ / khôi phục kích thước cửa sổ trình duyệt về trạng thái ban đầu...');
                  if (savedBounds.windowState === 'normal' && savedBounds.width && savedBounds.height) {
                    await bSend('Browser.setWindowBounds', {
                      windowId: savedWindowId,
                      bounds: {
                        windowState: 'normal',
                        left: savedBounds.left,
                        top: savedBounds.top,
                        width: savedBounds.width,
                        height: savedBounds.height
                      }
                    });
                  } else {
                    await bSend('Browser.setWindowBounds', {
                      windowId: savedWindowId,
                      bounds: { windowState: savedBounds.windowState || 'normal' }
                    });
                  }
                  console.log('[navigateAds] 🆗 Đã khôi phục kích thước cửa sổ về ban đầu.');
                }, 3000);
              }
            }
          } catch (_) {}

          // Đợi cửa sổ thu nhỏ lại hoàn tất và giao diện ổn định
          console.log('[navigateAds] ⏳ Đang đợi cửa sổ thu nhỏ lại và giao diện ổn định...');
          await new Promise(r => setTimeout(r, 1000));
        }

            // Chờ và kiểm tra menu dropdown đã mở ra chưa (kiểm tra lặp trong 3 giây)
            const checkStart = Date.now();
            while (Date.now() - checkStart < 3000) {
              await new Promise(r => setTimeout(r, 300));
              try {
                const popRes = await send('Runtime.evaluate', { expression: CHECK_POPUP_OPEN_SCRIPT, returnByValue: true });
                if (popRes?.result?.result?.value === true) {
                  popupOpen = true;
                  break;
                }
              } catch (_) {}
            }

            // Fallback: Nếu chưa mở sau CDP Click, thử kích hoạt trigger.click()
            if (!popupOpen) {
              console.log('[navigateAds] 🖱️ Popup chưa xuất hiện sau CDP Click -> Thử gọi trigger click...');
              await send('Runtime.evaluate', {
                expression: `(() => {
                  const arrow = document.querySelector('.dropdown-section, .dropdown-icon');
                  if (arrow) { arrow.click(); return 'arrow'; }
                  const trigger = document.querySelector('.mcc-nav-popup-trigger');
                  if (trigger) { trigger.click(); return 'trigger'; }
                  return 'none';
                })()`
              }).catch(() => {});

              const checkStart2 = Date.now();
              while (Date.now() - checkStart2 < 2000) {
                await new Promise(r => setTimeout(r, 300));
                try {
                  const popRes = await send('Runtime.evaluate', { expression: CHECK_POPUP_OPEN_SCRIPT, returnByValue: true });
                  if (popRes?.result?.result?.value === true) {
                    popupOpen = true;
                    break;
                  }
                } catch (_) {}
              }
            }
          }

          if (popupOpen) {
            console.log('[navigateAds] 🟢 Danh sách tài khoản đã hiển thị thành công!');
          } else {
            console.log('[navigateAds] ⚠️ Cảnh báo: Danh sách tài khoản chưa được xác nhận mở.');
          }

          console.log('[navigateAds] ✅ Hoàn tất thao tác kích hoạt mở menu tài khoản.');

          // 8. Tiếp tục luồng Verify -> Nhấn vào kính lúp (Search icon)
          console.log('[navigateAds] 🔍 Đang tìm và nhấn vào kính lúp (Search icon)...');
          let glassClicked = false;
          const glassStartTime = Date.now();
          while (Date.now() - glassStartTime < 8000) {
            await new Promise(r => setTimeout(r, 500));
            // Kiểm tra xem ô input tìm kiếm đã hiển thị luôn chưa
            const inputAlreadyVisible = await send('Runtime.evaluate', {
              expression: `(() => {
                const inp = document.querySelector('awsm-customer-search input.input-area, material-input.search-input input, input.input-area');
                return Boolean(inp && (inp.offsetParent !== null || inp.getClientRects().length > 0));
              })()`,
              returnByValue: true
            }).catch(() => null);

            if (inputAlreadyVisible?.result?.result?.value === true) {
              glassClicked = true;
              console.log('[navigateAds] ℹ️ Ô input tìm kiếm đã sẵn sàng, không cần bấm kính lúp.');
              break;
            }

            const glassRes = await send('Runtime.evaluate', { expression: CLICK_MAGNIFYING_GLASS_SCRIPT, returnByValue: true });
            const glassVal = glassRes?.result?.result?.value;

            if (glassVal && glassVal.clicked) {
              glassClicked = true;
              console.log(`[navigateAds] 🎯 Đã kích hoạt click vào kính lúp: selector="${glassVal.selector}" <${glassVal.tag}>`);
              if (glassVal.center?.x && glassVal.center?.y) {
                console.log(`[navigateAds] 🖱️ Gửi CDP Mouse Click vào kính lúp tại tọa độ x=${glassVal.center.x}, y=${glassVal.center.y}...`);
                try {
                  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: glassVal.center.x, y: glassVal.center.y });
                  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: glassVal.center.x, y: glassVal.center.y, button: 'left', buttons: 1, clickCount: 1 });
                  await new Promise(r => setTimeout(r, 60));
                  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: glassVal.center.x, y: glassVal.center.y, button: 'left', buttons: 0, clickCount: 1 });
                } catch (_) {}
              }
              console.log('[navigateAds] ✅ Đã nhấn vào kính lúp thành công.');
              break;
            }
          }

          if (!glassClicked) {
            console.log('[navigateAds] ⚠️ Không tìm thấy nút kính lúp sau thời gian chờ.');
          }
        } else {
          console.log('[navigateAds] ⚠️ Không thể click vào ô tài khoản (không tìm thấy phần tử).');
        }

        // 9. Tiếp tục luồng Verify -> Đợi cửa sổ thu nhỏ lại mới nhập ID TK vào ô tìm kiếm tài khoản
        const rawTargetList = Array.isArray(rawCustomerId)
          ? rawCustomerId
          : (rawCustomerId ? [rawCustomerId] : (lastUsedCustomerId ? [lastUsedCustomerId] : (rawMccId ? [rawMccId] : [])));
        const targetList = rawTargetList.filter(Boolean);

        if (targetList.length > 0) {
          console.log(`[navigateAds] 📋 Bắt đầu luồng xác minh cho ${targetList.length} tài khoản...`);

          for (let accIdx = 0; accIdx < targetList.length; accIdx++) {
            const accItem = targetList[accIdx];
            const accCustId = (typeof accItem === 'object' && accItem !== null)
              ? (accItem.id || accItem.customerId || accItem.formattedId)
              : accItem;
            const accActionUrl = (typeof accItem === 'object' && accItem !== null)
              ? (accItem.actionUrl || accItem.url)
              : defaultActionUrl;

            if (!accCustId) continue;
            const formattedTarget = adsVerification.formatCustomerId(accCustId);
            console.log(`[navigateAds] ⌨️ [${accIdx + 1}/${targetList.length}] Tìm kiếm tài khoản: ${formattedTarget}...`);

            // Đảm bảo ô input tìm kiếm sẵn sàng (hoặc bấm kính lúp nếu cần)
            let focusVal = null;
            const inputStartTime = Date.now();
            while (Date.now() - inputStartTime < 10000) {
              const focusRes = await send('Runtime.evaluate', { expression: FOCUS_CUSTOMER_SEARCH_INPUT_SCRIPT, returnByValue: true });
              const fVal = focusRes?.result?.result?.value;
              if (fVal && fVal.found) {
                focusVal = fVal;
                break;
              }
              await send('Runtime.evaluate', { expression: CLICK_MAGNIFYING_GLASS_SCRIPT, returnByValue: true }).catch(() => {});
              await new Promise(r => setTimeout(r, 600));
            }

            if (focusVal && focusVal.found) {
              console.log('[navigateAds] 🎯 Đã tìm thấy ô input tìm kiếm tài khoản, đang focus và click...');
              // Click vào ô input nếu có tọa độ (tọa độ mới sau khi thu nhỏ)
              if (focusVal.rect?.x && focusVal.rect?.y) {
                const ix = focusVal.rect.x + (focusVal.rect.width / 2);
                const iy = focusVal.rect.y + (focusVal.rect.height / 2);
                try {
                  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ix, y: iy });
                  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ix, y: iy, button: 'left', buttons: 1, clickCount: 1 });
                  await new Promise(r => setTimeout(r, 50));
                  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ix, y: iy, button: 'left', buttons: 0, clickCount: 1 });
                } catch (_) {}
              }

              // Xóa nội dung cũ nếu có (Ctrl+A -> Backspace)
              try {
                await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 65, modifiers: 2 });
                await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 65 });
                await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 8 });
                await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 8 });
              } catch (_) {}

              // Nhập từng ký tự với độ trễ (delay) theo quy tắc AGENTS.md
              for (const ch of formattedTarget) {
                try {
                  await send('Input.dispatchKeyEvent', {
                    type: 'keyDown',
                    text: ch,
                    unmodifiedText: ch
                  });
                  await send('Input.dispatchKeyEvent', {
                    type: 'keyUp'
                  });
                } catch (_) {}
                await new Promise(r => setTimeout(r, 80));
              }

              // Kích hoạt sự kiện input & change để Angular nhận diện
              await send('Runtime.evaluate', {
                expression: `(() => {
                  const input = document.querySelector('awsm-customer-search input.input-area, material-input.search-input input, input.input-area') || document.activeElement;
                  if (input) {
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                  }
                })()`
              });

              console.log('[navigateAds] ✅ Đã nhập ID tài khoản vào ô tìm kiếm thành công.');

              // 10. Chờ kết quả trả về rồi mở tk trong window mới
              console.log(`[navigateAds] ⏳ Đang chờ kết quả tìm kiếm hiển thị cho tài khoản ${formattedTarget}...`);
              const searchStartTime = Date.now();
              let foundAccount = null;

              while (Date.now() - searchStartTime < 15000) {
                await new Promise(r => setTimeout(r, 600));

                const searchEvalRes = await send('Runtime.evaluate', {
                  expression: `(() => {
                    const targetId = ${JSON.stringify(formattedTarget)};
                    const cleanTarget = targetId.replace(/\\D/g, '');
                    const formatted = targetId.trim();

                    const items = Array.from(document.querySelectorAll('.customer-tree, awsm-customer-item, .customer-item, [role="menuitemradio"], material-select-item, [role="row"], tr, div.item'));
                    for (const item of items) {
                      if (item.offsetParent === null && item.getClientRects().length === 0) continue;
                      const text = (item.innerText || item.textContent || '');
                      const cleanText = text.replace(/\D/g, '');

                      const match = (!cleanTarget) || text.includes(formatted) || (cleanTarget.length >= 4 && cleanText.includes(cleanTarget));
                      if (match) {
                        const a = item.matches('a') ? item : item.querySelector('a[href], a');
                        let href = a ? (a.getAttribute('href') || a.href) : (item.getAttribute('href') || item.dataset?.href);
                        if (!href && item.parentElement?.matches('a')) href = item.parentElement.getAttribute('href') || item.parentElement.href;
                        if (!href) { const link = item.closest('a') || item.querySelector('[href]'); if (link) href = link.getAttribute('href') || link.href; }
                        if (!href || !href.includes('ocid')) {
                          const child = item.querySelector('[href*="ocid"], [ng-reflect-href*="ocid"], [data-ocid]');
                          if (child) href = child.getAttribute('href') || child.getAttribute('ng-reflect-href') || child.dataset?.ocid;
                        }
                        if (!href && cleanTarget) {
                          href = '/aw/overview?ocid=' + cleanTarget;
                        }
                        const rect = item.getBoundingClientRect();
                        const name = item.querySelector('.customer-name')?.innerText?.trim() || '';
                        const idText = item.querySelector('.customer-id')?.innerText?.trim() || '';

                        return {
                          found: true,
                          href: href,
                          name: name,
                          idText: idText,
                          text: text.slice(0, 150),
                          rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
                        };
                      }
                    }
                    return { found: false };
                  })()`,
                  returnByValue: true
                }).catch(() => null);

                const searchVal = searchEvalRes?.result?.result?.value;
                if (searchVal && searchVal.found) {
                  foundAccount = searchVal;
                  break;
                }
              }

              if (foundAccount) {
                console.log(`[navigateAds] 🎯 Đã tìm thấy kết quả tài khoản: "${foundAccount.name}" (ID: "${foundAccount.idText || formattedTarget}")`);
                const cleanIdStr = formattedTarget.replace(/\D/g, '');
                let accountTargetUrl = 'https://ads.google.com/aw/overview';
                if (foundAccount.href) {
                  try {
                    accountTargetUrl = new URL(foundAccount.href, 'https://ads.google.com').href;
                  } catch (_) {
                    accountTargetUrl = foundAccount.href;
                  }
                } else if (cleanIdStr) {
                  accountTargetUrl = 'https://ads.google.com/aw/overview?ocid=' + cleanIdStr;
                }

                console.log(`[navigateAds] 🚀 Đang mở link tài khoản trong window mới: ${accountTargetUrl}...`);
                let windowOpened = false;

                try {
                  const vRes = await fetch(`http://127.0.0.1:${port}/json/version`);
                  if (vRes.ok) {
                    const vData = await vRes.json();
                    if (vData.webSocketDebuggerUrl) {
                      await connectAndSendBrowser(vData.webSocketDebuggerUrl, async bSend => {
                        const targetRes = await bSend('Target.createTarget', {
                          url: accountTargetUrl,
                          newWindow: true
                        });
                        const newTargetId = targetRes?.result?.targetId;
                        if (newTargetId) {
                          console.log(`[navigateAds] ✅ Đã mở tài khoản thành công trong window mới! (Target ID: ${newTargetId})`);
                          windowOpened = true;

                          let newWindowId = null;
                          try {
                            const winRes = await bSend('Browser.getWindowForTarget', { targetId: newTargetId });
                            newWindowId = winRes?.result?.windowId;
                          } catch (errWin) {
                            console.log('[navigateAds] ⚠️ Không lấy được windowId của cửa sổ mới:', errWin.message);
                          }

                          if (newWindowId) {
                            await arrangeProfileAccountWindows(id, bSend, targetTab.id, { targetId: newTargetId, windowId: newWindowId });
                          }
                          await bSend('Target.activateTarget', { targetId: newTargetId }).catch(() => {});
                        }
                      }, 5000);
                    }
                  }
                } catch (e) {
                  console.log('[navigateAds] ⚠️ Không thể mở window mới qua Target.createTarget:', e.message);
                }

                // Đóng popup menu ở window chính để không chắn màn hình
                // try {
                //   await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 27 });
                //   await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27 });
                // } catch (_) {}

                if (!windowOpened) {
                  console.log('[navigateAds] 🖱️ Dự phòng: Click vào kết quả tìm kiếm với Shift để mở cửa sổ mới...');
                  if (foundAccount.rect?.x && foundAccount.rect?.y) {
                    const cx = foundAccount.rect.x + (foundAccount.rect.width / 2);
                    const cy = foundAccount.rect.y + (foundAccount.rect.height / 2);
                    try {
                      await send('Input.dispatchMouseEvent', {
                        type: 'mouseMoved',
                        x: cx,
                        y: cy
                      });
                      await send('Input.dispatchMouseEvent', {
                        type: 'mousePressed',
                        x: cx,
                        y: cy,
                        button: 'left',
                        buttons: 1,
                        clickCount: 1,
                        modifiers: 8
                      });
                      await new Promise(r => setTimeout(r, 60));
                      await send('Input.dispatchMouseEvent', {
                        type: 'mouseReleased',
                        x: cx,
                        y: cy,
                        button: 'left',
                        buttons: 0,
                        clickCount: 1,
                        modifiers: 8
                      });
                      console.log('[navigateAds] ✅ Đã gửi Shift+Click vào kết quả tìm kiếm.');
                      await new Promise(r => setTimeout(r, 1000));
                      try {
                        const vRes = await fetch(`http://127.0.0.1:${port}/json/version`);
                        if (vRes.ok) {
                          const vData = await vRes.json();
                          if (vData.webSocketDebuggerUrl) {
                            await connectAndSendBrowser(vData.webSocketDebuggerUrl, async bSend => {
                              await arrangeProfileAccountWindows(id, bSend, targetTab.id);
                            }, 3000);
                          }
                        }
                      } catch (_) {}
                    } catch (_) {}
                  }
                }
              } else {
                console.log(`[navigateAds] ⚠️ Không tìm thấy kết quả tìm kiếm tài khoản ${formattedTarget} sau thời gian chờ.`);
              }
            } else {
              console.log('[navigateAds] ⚠️ Không tìm thấy ô input tìm kiếm tài khoản.');
            }

            if (accIdx < targetList.length - 1) {
              await new Promise(r => setTimeout(r, 1200));
            }
          }
        }
      } else {
        console.log('[navigateAds] ℹ️ Không phát hiện chuyển tới /aw/overview trong thời gian chờ.');
      }
    }, 60000);

    // Kích hoạt tab và cửa sổ
    await fetch(`http://127.0.0.1:${port}/json/activate/${targetTab.id}`).catch(() => {});
    try {
      const vRes = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (vRes.ok) {
        const vData = await vRes.json();
        if (vData.webSocketDebuggerUrl) {
          await connectAndSendBrowser(vData.webSocketDebuggerUrl, async send => {
            await send('Target.activateTarget', { targetId: targetTab.id });
          }, 3000);
        }
      }
    } catch (_) {}
  } else {
    // Nếu chưa có page nào sẵn sàng (rất hiếm), tạo target mới tới trang ads
    try {
      const vRes = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (vRes.ok) {
        const vData = await vRes.json();
        if (vData.webSocketDebuggerUrl) {
          await connectAndSendBrowser(vData.webSocketDebuggerUrl, async send => {
            await send('Target.createTarget', { url: destUrl });
          });
        }
      }
    } catch (_) {}
  }

  return { ok: true, url: destUrl };
}, { profileArgument: 0 });

const runAdsVerificationBrowser = trace.traced('runAdsVerificationBrowser', async (id, { mccId = null, url = null, customerId = null, customerIds = null, accounts = null, actionUrl = null } = {}) => {
  const destUrl = 'https://ads.google.com/';
  const effectiveMcc = mccId || lastUsedMccId;
  const effectiveCustomer = accounts || customerIds || customerId || lastUsedCustomerId;
  const effectiveActionUrl = actionUrl || (url && url !== 'https://ads.google.com/' ? url : null);
  return navigateCurrentTabToAds(id, destUrl, effectiveMcc, effectiveCustomer, effectiveActionUrl);
}, { profileArgument: 0 });

const verifyAdsProfile = trace.traced('verifyAdsProfile', async (id, options = null) => {
  if (typeof options === 'object' && options !== null) {
    return runAdsVerificationBrowser(id, options);
  }
  return runAdsVerificationBrowser(id, { url: options });
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
        const mccId = (input && typeof input === 'object' && input.mccId) ? input.mccId : null;
        const customerId = (input && typeof input === 'object' && (input.customerId || input.targetAccountId || input.accountId))
          ? (input.customerId || input.targetAccountId || input.accountId)
          : null;
        const actionUrl = (input && typeof input === 'object' && input.actionUrl) ? input.actionUrl : null;
        if (mccId) lastUsedMccId = String(mccId).trim();
        if (customerId) lastUsedCustomerId = String(customerId).trim();
        return runAdsVerificationBrowser(id, { mccId, url, customerId, actionUrl });
      }));
      handle('v2:verify-ads-batch', trace.traced('ipc.verifyAdsBatch', input => {
        const id = (input && typeof input === 'object') ? input.id : input;
        const urls = (input && typeof input === 'object' && Array.isArray(input.urls)) ? input.urls : [];
        const mccId = (input && typeof input === 'object' && input.mccId) ? input.mccId : null;
        const customerId = (input && typeof input === 'object' && (input.customerId || input.targetAccountId || input.accountId))
          ? (input.customerId || input.targetAccountId || input.accountId)
          : null;
        const customerIds = (input && typeof input === 'object' && Array.isArray(input.customerIds)) ? input.customerIds : null;
        const accounts = (input && typeof input === 'object' && Array.isArray(input.accounts)) ? input.accounts : null;
        if (mccId) lastUsedMccId = String(mccId).trim();
        if (customerId) lastUsedCustomerId = String(customerId).trim();
        return runAdsVerificationBrowser(id, { mccId, urls, customerId, customerIds, accounts });
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
      // Server GCP (Ads API): settings.gcpAds = { activeId, servers }; settings.gcpAdsConfig là định dạng cũ (1 GCP)
      const localGcpAds = () => gcpServers.normalize(settings.gcpAds || gcpServers.fromLegacy(settings.gcpAdsConfig));
      const persistGcpAds = data => {
        const { gcpAdsConfig: _legacy, ...rest } = settings;
        const next = { ...rest, gcpAds: gcpServers.normalize(data) };
        fs.writeFileSync(`${settingsFile}.tmp`, secretConfig.stringify(next));
        fs.renameSync(`${settingsFile}.tmp`, settingsFile);
        settings = next;
        return next.gcpAds;
      };
      const pullGcpAdsFromFirebase = async () => {
        const remote = await firebaseService.getGcpAdsServersFromFirebase();
        return remote ? persistGcpAds(remote) : null;
      };
      // Server đang dùng; cục bộ thiếu thông tin thì thử lấy lại từ Firebase
      const activeGcpServer = async isReady => {
        let server = gcpServers.active(localGcpAds());
        if (!server || !isReady(server)) {
          try {
            await pullGcpAdsFromFirebase();
            server = gcpServers.active(localGcpAds());
          } catch (_) {}
        }
        return server || {};
      };
      handle('v2:gcp-ads-get', trace.traced('gcpAds.get', async () => {
        try {
          await pullGcpAdsFromFirebase();
        } catch (err) {
          console.warn('[firebase] Không thể tải cấu hình từ Firebase (dùng cấu hình cục bộ):', err.message);
        }
        return localGcpAds();
      }));
      handle('v2:gcp-ads-save', trace.traced('gcpAds.save', async input => {
        // 1. Lưu an toàn vào settings.json cục bộ
        const gcpAds = persistGcpAds(input);

        // 2. Đồng bộ lên Firebase Realtime Database
        try {
          await firebaseService.saveGcpAdsServersToFirebase(gcpAds);
        } catch (err) {
          console.error('[firebase] Lỗi đồng bộ lên Firebase:', err.message);
          throw new Error(`Đã lưu trên máy nhưng lỗi đồng bộ Firebase: ${err.message}`);
        }

        return gcpAds;
      }));
      handle('v2:gcp-ads-auth-link', trace.traced('gcpAds.authLink', async () => {
        const config = await activeGcpServer(s => s.clientId);
        if (!config.clientId) {
          throw new Error('Server GCP đang dùng chưa có Client ID. Vui lòng bấm "Cài đặt" để nhập Client ID trước.');
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
        return { url, redirectUri, clientId: config.clientId, serverName: config.name };
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

        const config = await activeGcpServer(s => s.clientId && s.clientSecret);
        if (!config.clientId || !config.clientSecret) {
          throw new Error('Server GCP đang dùng thiếu Client ID hoặc Client Secret trong Cài đặt.');
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

        const current = localGcpAds();
        const gcpAds = persistGcpAds({
          ...current,
          servers: current.servers.map(s => (s.id === config.id ? { ...s, refreshToken: data.refresh_token } : s)),
        });

        try {
          await firebaseService.saveGcpAdsServersToFirebase(gcpAds);
        } catch (err) {
          console.warn('[firebase] Lỗi lưu refresh token lên Firebase:', err.message);
        }

        return { ok: true, refreshToken: data.refresh_token, serverName: config.name };
      }));
      // Pool đang back off vì quota -> dừng cả lượt, báo thời gian chờ; không thử lại ngay
      const stopOnQuota = trace.traced('gcpAds.stopOnQuota', async run => {
        try {
          return await run();
        } catch (error) {
          if (!(error instanceof QuotaStopError)) throw error;
          const sec = Math.ceil(queryPool.blockedForMs / 1000);
          throw new Error(`${error.message}${sec > 0 ? ` Pool tạm dừng ~${sec} giây, thử lại sau.` : ''}`);
        }
      });
      handle('v2:gcp-ads-scan-verification', trace.traced('gcpAds.scanVerification', async mccId => {
        if (mccId) lastUsedMccId = String(mccId).trim();
        const config = await activeGcpServer(s => s.clientId && s.refreshToken);
        return await stopOnQuota(() => adsVerification.scanMccVerification(config, mccId));
      }));
      handle('v2:gcp-ads-scan-suspended', trace.traced('gcpAds.scanSuspended', async mccId => {
        if (mccId) lastUsedMccId = String(mccId).trim();
        const config = await activeGcpServer(s => s.clientId && s.refreshToken);
        return await stopOnQuota(() => adsVerification.scanMccSuspended(config, mccId));
      }));
      handle('v2:gcp-ads-list-mccs', trace.traced('gcpAds.listMccs', async () => {
        const config = await activeGcpServer(s => s.clientId && s.refreshToken);
        return await stopOnQuota(() => adsVerification.listAccessibleMccs(config));
      }));
      // Pool worker: GET /api/pool/stats, GET /api/pool/config, PUT /api/pool/config — ai cũng đổi được, lưu Firebase
      registerPoolRoutes(handle, {
        pool: queryPool,
        prefix: '/api/pool',
        taskTimeout: { get: getTaskTimeoutMs, set: setTaskTimeoutMs },
        load: () => firebaseService.getPoolConfigFromFirebase(),
        persist: async cfg => {
          try {
            await firebaseService.savePoolConfigToFirebase(cfg);
          } catch (err) {
            throw new Error(`Đã áp dụng cấu hình pool nhưng lỗi lưu Firebase: ${err.message}`);
          }
        },
      });
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
