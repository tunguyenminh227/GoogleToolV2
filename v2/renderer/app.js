const $ = id => document.getElementById(id);
let state = { profiles: [], chromePath: null };
let saving = false;
let toastTimer;
let opener;
const opening = new Set();
const selected = new Set();
let sortKey = 'stt';
let sortDirection = 1;
let visibleIds = [];
let selectedAction = null;
let actionBusy = false;
const rememberedThreads = Number(localStorage.getItem('threadLimit'));
$('threadLimit').value = Number.isInteger(rememberedThreads) && rememberedThreads >= 1 && rememberedThreads <= 50 ? rememberedThreads : 1;
$('threadLimit').addEventListener('change', window.uiTrace('renderer.threadLimit', async () => {
  if (!$('threadLimit').reportValidity()) return;
  try {
    await window.googleTool.setOpenLimit(Number($('threadLimit').value));
    localStorage.setItem('threadLimit', $('threadLimit').value);
  } catch (error) { toast(error.message, true); }
}));
$('cancelOpenQueue').addEventListener('click', window.uiTrace('renderer.cancelQueue', async () => {
  try { await window.googleTool.cancelOpenQueue(); } catch (error) { toast(error.message, true); }
}));
const updateSelection = window.uiTrace('renderer.updateSelection', function () {
  const queue = state.openQueue || { pending: [], opening: [], errors: [], limit: 1 };
  $('openQueueControls').hidden = !selected.size && !queue.pending.length && !queue.opening.length && !queue.errors.length;
  $('openQueueStatus').textContent = `Đang mở ${state.profiles.filter(p => p.running).length}/${queue.limit} · Chờ ${queue.pending.length}${queue.errors.length ? ` · Lỗi ${queue.errors.length}: ${queue.errors[queue.errors.length - 1].message}` : ''}`;
  $('cancelOpenQueue').hidden = !queue.pending.length;
  $('profileActions').hidden = !selected.size;
  $('selectedCount').textContent = `Đã chọn ${selected.size}`;
  $('actionButton').disabled = actionBusy;
  $('runAction').disabled = actionBusy || !selected.size || !selectedAction;
  $('runAction').title = !selectedAction ? 'Chọn thao tác trước khi chạy' : '';
  $('runAction').textContent = actionBusy ? 'Đang chạy…' : '▶ Run';
  if (!selected.size) closeActionMenu();
  const count = visibleIds.filter(id => selected.has(id)).length;
  $('selectAll').checked = visibleIds.length > 0 && count === visibleIds.length;
  $('selectAll').indeterminate = count > 0 && count < visibleIds.length;
});
function closeActionMenu() {
  const menu = $('actionOptions');
  menu.hidden = true;
  menu.classList.remove('context-actions');
  menu.style.removeProperty('left');
  menu.style.removeProperty('top');
  const submenu = menu.querySelector('.submenu-options');
  if (submenu) submenu.classList.remove('open-left');
  $('actionButton').setAttribute('aria-expanded', 'false');
}

function adjustSubmenuPosition() {
  const menu = $('actionOptions');
  const submenu = menu.querySelector('.submenu-options');
  if (!submenu) return;
  const menuRect = menu.getBoundingClientRect();
  const submenuWidth = 185;
  if (menuRect.right + submenuWidth + 10 > window.innerWidth) {
    submenu.classList.add('open-left');
  } else {
    submenu.classList.remove('open-left');
  }
}

const copyTextToClipboard = async text => {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (_) {
    return false;
  }
};

const getTotpCode = async secret => {
  if (!secret) return '';
  try {
    if (window.googleTool && typeof window.googleTool.getTotp === 'function') {
      const code = await window.googleTool.getTotp(secret);
      if (code) return code;
    }
  } catch (_) {}
  try {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const normalized = String(secret || '').replace(/\s+/g, '').replace(/=+$/, '').toUpperCase();
    if (!/^[A-Z2-7]{16,}$/.test(normalized)) return '';
    let bits = 0, buffer = 0;
    const bytes = [];
    for (const char of normalized) {
      buffer = (buffer << 5) | alphabet.indexOf(char); bits += 5;
      if (bits >= 8) { bits -= 8; bytes.push((buffer >>> bits) & 255); }
    }
    const keyData = new Uint8Array(bytes);
    const cryptoKey = await window.crypto.subtle.importKey(
      'raw', keyData, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
    );
    const counter = Math.floor(Date.now() / 30000);
    const counterBytes = new Uint8Array(8);
    let temp = counter;
    for (let i = 7; i >= 0; i--) {
      counterBytes[i] = temp & 0xff;
      temp = Math.floor(temp / 256);
    }
    const sig = await window.crypto.subtle.sign('HMAC', cryptoKey, counterBytes);
    const sigBytes = new Uint8Array(sig);
    const offset = sigBytes[19] & 0x0f;
    const code = ((sigBytes[offset] & 0x7f) << 24) |
                 ((sigBytes[offset + 1] & 0xff) << 16) |
                 ((sigBytes[offset + 2] & 0xff) << 8) |
                 (sigBytes[offset + 3] & 0xff);
    return String(code % 1000000).padStart(6, '0');
  } catch (_) {
    return '';
  }
};

const copyProfileData = window.uiTrace('renderer.copyData', async fieldsToCopy => {
  if (!selected.size) return;
  const ids = visibleIds.filter(id => selected.has(id));
  if (!ids.length) return;

  const lines = [];
  for (const id of ids) {
    const p = state.profiles.find(item => item.id === id);
    if (!p) continue;
    if (fieldsToCopy === 'all') {
      const parts = [
        p.email || '',
        p.password || '',
        p.recoveryMail || '',
        p.twofa || '',
      ];
      if (p.securityCode) parts.push(p.securityCode);
      lines.push(parts.join('|'));
    } else if (fieldsToCopy === 'email') {
      lines.push(p.email || '');
    } else if (fieldsToCopy === 'password') {
      lines.push(p.password || '');
    } else if (fieldsToCopy === 'twofa-code') {
      const code = await getTotpCode(p.twofa);
      lines.push(code);
    } else if (fieldsToCopy === 'twofa') {
      lines.push(p.twofa || '');
    } else if (fieldsToCopy === 'recoveryMail') {
      lines.push(p.recoveryMail || '');
    } else if (fieldsToCopy === 'securityCode') {
      lines.push(p.securityCode || '');
    }
  }

  if (fieldsToCopy === 'twofa-code' && lines.every(c => !c)) {
    toast('Profile chưa có khóa 2FA để tạo mã.', true);
    return;
  }

  const textToCopy = lines.join('\n');
  const ok = await copyTextToClipboard(textToCopy);
  if (ok) {
    const labels = {
      all: 'tất cả dữ liệu',
      email: 'Email',
      password: 'Mật khẩu',
      'twofa-code': '2FA Code',
      twofa: '2FA Key',
      recoveryMail: 'Email khôi phục',
      securityCode: 'Security code'
    };
    const label = labels[fieldsToCopy] || 'dữ liệu';
    toast(`Đã sao chép ${label} (${lines.length} profile).`);
  } else {
    toast('Không thể sao chép vào clipboard.', true);
  }
});

$('actionButton').addEventListener('click', () => {
  const wasOpen = !$('actionOptions').hidden;
  closeActionMenu();
  $('actionOptions').hidden = wasOpen;
  $('actionButton').setAttribute('aria-expanded', String(!$('actionOptions').hidden));
  if (!$('actionOptions').hidden) adjustSubmenuPosition();
});
document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => {
  if (actionBusy) return;
  const runImmediately = $('actionOptions').classList.contains('context-actions');
  selectedAction = button.dataset.action;
  $('actionButton').textContent = `${button.textContent} ▾`;
  closeActionMenu(); updateSelection(); $('actionButton').focus();
  if (runImmediately) $('runAction').click();
}));
document.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', async event => {
  event.stopPropagation();
  const copyType = button.dataset.copy || 'all';
  closeActionMenu();
  await copyProfileData(copyType);
}));
document.addEventListener('click', event => { if (!event.target.closest('.action-picker')) closeActionMenu(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('actionOptions').hidden) { closeActionMenu(); $('actionButton').focus(); } });
window.addEventListener('resize', closeActionMenu);
document.querySelector('.table-wrap').addEventListener('scroll', closeActionMenu);
$('runAction').addEventListener('click', window.uiTrace('renderer.runAction', async () => {
  if (actionBusy || !selected.size || !['open', 'delete', 'login-gmail'].includes(selectedAction)) return;
  const ids = [...selected];
  const action = selectedAction;
  if (['open', 'login-gmail'].includes(action) && !$('threadLimit').reportValidity()) return;
  actionBusy = true; closeActionMenu(); updateSelection();
  let completed = 0, skipped = 0;
  const errors = [];
  try {
    if (action === 'open' || action === 'login-gmail') {
      const result = await window.googleTool.openProfiles({ ids, limit: Number($('threadLimit').value), action });
      toast(`Đã thêm ${result.added} profile vào hàng đợi ${action === 'login-gmail' ? 'Login gmail' : 'mở'}.`);
      return;
    } else if (action === 'delete') {
      const batch = await window.googleTool.deleteProfiles(ids);
      if (batch.cancelled) return;
      for (const result of batch.results) {
        if (result.deleted) { selected.delete(result.id); completed++; }
        else skipped++;
        if (result.error || result.warning) errors.push(result.error || result.warning);
      }
    } else {
    for (const id of ids) {
      const profile = state.profiles.find(p => p.id === id);
      if (!profile || ((action === 'open' || action === 'delete') && (profile.running || opening.has(id)))) { skipped++; continue; }
      try {
        if (action === 'open') await window.googleTool.openProfile(id);
        if (action === 'login-gmail') await window.googleTool.loginGmail(id);
        completed++;
      } catch (error) { errors.push(`${profile.name}: ${error.message}`); }
    }
    }
    render(await window.googleTool.load());
    toast(`Đã thực hiện ${completed}/${ids.length} profile.${skipped ? ` Bỏ qua ${skipped} profile.` : ''}${errors.length ? ` ${errors.join('; ')}` : ''}`, errors.length > 0);
  } catch (error) { toast(error.message, true); }
  finally { actionBusy = false; updateSelection(); }
}));
$('selectAll').addEventListener('change', event => {
  visibleIds.forEach(id => event.target.checked ? selected.add(id) : selected.delete(id));
  render();
});
document.querySelectorAll('[data-sort]').forEach(button => button.addEventListener('click', () => {
  sortDirection = sortKey === button.dataset.sort ? -sortDirection : 1;
  sortKey = button.dataset.sort;
  render();
}));
const dateFormatter = new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });

function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').classList.toggle('error', error);
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 8000 : 4500);
}

function icon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${id}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.append(use);
  return svg;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const mailLabels = {
  starting: 'Đang mở…',
  email: 'Nhập email…',
  password: 'Nhập mật khẩu…',
  password_reached: 'Chờ mật khẩu',
  recovery: 'Email khôi phục…',
  totp: 'Authenticator…',
  selection: 'Chọn xác minh…',
  skotp: 'Security Code…',
  verify_phone: 'Xác minh SĐT',
  rejected: 'Bị từ chối',
  inbox: 'Đang vào Gmail…',
  success: 'Đã đăng nhập',
  manual: 'Cần xử lý',
  error: 'Lỗi đăng nhập',
  recaptcha: 'Giải reCAPTCHA…'
};

const render = window.uiTrace('renderer.render', function (data = state) {
  state = data;
  const engineLabel = state.engineLabel || 'Chromium';
  document.querySelectorAll('[data-engine-label]').forEach(node => { node.textContent = engineLabel; });
  const profiles = state.profiles;
  const count = profiles.length;
  $('navCount').textContent = count;
  $('chromeStatus').textContent = state.chromePath ? `Chromium ${state.chromeVersion}` : `Cần cài ${engineLabel}`;
  $('chromeStatus').title = state.chromeError || state.chromePath;
  $('chromeDot').classList.toggle('ready', Boolean(state.chromePath));
  const query = $('search').value.trim().toLocaleLowerCase('vi');
  const visible = profiles.filter(p =>
    [p.name, p.email, p.recoveryMail, p.notes, p.notes2, p.mailError, mailLabels[p.mailStatus]].some(value => String(value || '').toLocaleLowerCase('vi').includes(query))).slice();
  const order = new Map(profiles.map((p, index) => [p.id, index + 1]));
  visible.sort((a, b) => {
    const value = p => sortKey === 'stt' ? order.get(p.id) : sortKey === 'updatedAt' ? p.updatedAt || p.lastOpenedAt || p.createdAt : p[sortKey] || '';
    const x = value(a), y = value(b);
    return sortDirection * (typeof x === 'number' || typeof x === 'boolean' ? Number(x) - Number(y) : String(x).localeCompare(String(y), 'vi'));
  });
  for (const id of selected) if (!order.has(id)) selected.delete(id);
  visibleIds = visible.map(p => p.id);
  document.querySelectorAll('[data-sort]').forEach(button => button.parentElement.setAttribute('aria-sort', button.dataset.sort === sortKey ? sortDirection === 1 ? 'ascending' : 'descending' : 'none'));
  const fragment = document.createDocumentFragment();
  for (const p of visible) {
    const row = document.createElement('tr');
    const email = element('td', '', p.email || 'Chưa thêm Gmail');
    email.title = p.email || '';
    const status = document.createElement('td');
    status.append(element('span', `status${p.running ? ' running' : ''}`, p.running ? 'Đang mở' : 'Chưa mở'));
    const created = element('td', '', dateFormatter.format(new Date(p.createdAt)));
    row.dataset.id = p.id;
    row.addEventListener('contextmenu', event => {
      event.preventDefault();
      if (actionBusy) return;
      // Keep a multi-selection only when the clicked row belongs to it.
      if (!selected.has(p.id)) { selected.clear(); selected.add(p.id); }
      document.querySelectorAll('#profileRows tr').forEach(item => {
        const checked = selected.has(item.dataset.id);
        item.classList.toggle('selected-row', checked);
        item.querySelector('input[type="checkbox"]').checked = checked;
      });
      updateSelection(); closeActionMenu();
      const menu = $('actionOptions');
      menu.classList.add('context-actions'); menu.hidden = false;
      menu.style.left = `${Math.max(8, Math.min(event.clientX, innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(event.clientY, innerHeight - menu.offsetHeight - 8))}px`;
      $('actionButton').setAttribute('aria-expanded', 'true');
      adjustSubmenuPosition();
      menu.querySelector('button').focus({ preventScroll: true });
    });
    row.classList.toggle('selected-row', selected.has(p.id));
    const selection = element('td', '');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.checked = selected.has(p.id);
    checkbox.setAttribute('aria-label', `Chọn ${p.name}`);
    checkbox.addEventListener('change', () => {
      checkbox.checked ? selected.add(p.id) : selected.delete(p.id);
      row.classList.toggle('selected-row', checkbox.checked); updateSelection();
    });
    selection.append(checkbox);
    status.replaceChildren(element('span', `status-dot${p.running ? ' running' : ''}`, ''));
    status.title = p.running ? 'Đang mở' : 'Chưa mở';
    status.setAttribute('aria-label', status.title);
    email.textContent = p.email || p.name;
    const isError = Boolean(p.mailError) || ['error', 'rejected', 'verify_phone'].includes(p.mailStatus);
    const isSuccess = p.mailStatus === 'success';
    const isProgress = ['starting', 'email', 'password', 'recovery', 'totp', 'selection', 'skotp', 'recaptcha', 'inbox'].includes(p.mailStatus);
    const statusClass = isError ? ' status-error' : (isSuccess ? ' status-success' : (isProgress ? ' status-progress' : ''));
    const displayText = p.mailError || mailLabels[p.mailStatus] || '—';
    const mailStatus = element('td', `mail-status${statusClass}`, displayText);
    mailStatus.title = p.mailError ? `Lỗi: ${p.mailError}` : (mailLabels[p.mailStatus] || 'Chưa kiểm tra đăng nhập Gmail');
    const accountCell = (key, secret = false) => {
      const td = element('td', 'account-cell');
      if (p.accountError) { td.textContent = 'Lỗi đọc'; td.title = p.accountError; return td; }
      if (!p[key]) { td.textContent = '—'; return td; }
      const text = element('span', '', secret ? '••••••••' : p[key]);
      td.append(text);
      if (secret) {
        const toggle = element('button', 'reveal-account', 'Hiện');
        toggle.type = 'button'; toggle.setAttribute('aria-label', `Hiện ${key} của ${p.name}`);
        toggle.addEventListener('click', () => {
          const show = toggle.textContent === 'Hiện'; text.textContent = show ? p[key] : '••••••••';
          toggle.textContent = show ? 'Ẩn' : 'Hiện'; toggle.setAttribute('aria-label', `${show ? 'Ẩn' : 'Hiện'} ${key} của ${p.name}`);
        });
        td.append(toggle);
      }
      return td;
    };
    const noteCell = key => {
      const td = element('td', ''); const input = document.createElement('input');
      input.className = 'note-input'; input.value = p[key] || ''; input.maxLength = 1000;
      input.placeholder = 'Ghi chú…'; input.setAttribute('aria-label', `${key === 'notes' ? 'Note' : 'Note 2'} của ${p.name}`);
      input.addEventListener('change', async () => {
        input.disabled = true;
        try {
          const result = await window.googleTool.saveNotes({ id: p.id, [key]: input.value });
          Object.assign(p, result); input.value = p[key]; created.textContent = dateFormatter.format(new Date(p.updatedAt));
          toast('Đã lưu ghi chú.');
        } catch (error) { input.value = p[key] || ''; toast(error.message, true); }
        finally { input.disabled = false; }
      });
      td.append(input); return td;
    };
    const proxy = element('td', '', p.fingerprint.proxyUrl ? p.fingerprint.proxyUrl.split(':')[0].toUpperCase() : 'None');
    proxy.title = p.fingerprint.proxyUrl || 'Không cấu hình proxy';
    created.textContent = dateFormatter.format(new Date(p.updatedAt || p.lastOpenedAt || p.createdAt));
    row.append(selection, element('td', '', order.get(p.id)), status, mailStatus, email,
      accountCell('password', true), accountCell('recoveryMail'), accountCell('twofa', true), accountCell('securityCode', true), proxy,
      noteCell('notes'), noteCell('notes2'), created);
    fragment.append(row);
  }
  $('profileRows').replaceChildren(fragment);
  updateSelection();
  $('emptyState').hidden = count === 0 || visible.length > 0;
  $('emptyTitle').textContent = count ? 'Không tìm thấy profile phù hợp' : 'Bắt đầu với profile đầu tiên';
  $('emptyDescription').textContent = count
    ? 'Thử từ khóa khác hoặc thay đổi bộ lọc trạng thái.'
    : 'Tạo một không gian Chromium riêng cho tài khoản Gmail. Cookie và phiên đăng nhập được lưu riêng cho từng profile.';
  $('createEmpty').hidden = count > 0;
  $('resultCount').textContent = `Hiển thị ${visible.length} / ${count} profiles`;
});

async function launch(id) {
  opening.add(id);
  render();
  try { await window.googleTool.openProfile(id); toast(`Đã mở profile bằng ${state.engineLabel || 'Chromium'}.`); }
  catch (error) { toast(error.message, true); }
  finally { opening.delete(id); render(); }
}

function showCreate(event) {
  opener = event.currentTarget;
  $('formError').hidden = true;
  $('createProgress').hidden = true;
  $('createDialog').showModal();
  $('newProfileInput').focus();
}

function closeCreate() { if (!saving) $('createDialog').close(); }
$('createTop').addEventListener('click', showCreate);
$('createEmpty').addEventListener('click', showCreate);
$('closeDialog').addEventListener('click', closeCreate);
$('cancelDialog').addEventListener('click', closeCreate);
$('createDialog').addEventListener('cancel', event => { if (saving) event.preventDefault(); });
$('createDialog').addEventListener('close', () => { if (opener && !opener.hidden) opener.focus(); else $('createTop').focus(); });
$('createTemplate').addEventListener('click', () => showFingerprint(null));
window.googleTool.onCreateProgress(({ done, total }) => {
  if (saving) { $('createProgress').hidden = false; $('createProgress').textContent = `Đang tạo ${done}/${total} profile…`; }
});
$('createForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (saving) return;
  saving = true;
  $('formError').hidden = true;
  const text = $('newProfileInput').value;
  const controls = Array.from($('createForm').elements);
  controls.forEach(control => { control.disabled = true; });
  $('submitProfile').querySelector('span').textContent = 'Đang tạo…';
  try {
    const result = await window.googleTool.createProfiles(text);
    $('search').value = '';
    render(await window.googleTool.load());
    const failures = result.results.filter(r => !r.ok);
    const message = `Đã tạo ${result.created}/${result.total} profile.`;
    $('createProgress').hidden = false; $('createProgress').textContent = message;
    if (failures.length) {
      const failedLines = new Set();
      for (const failure of failures) for (let line = failure.lineNumber; line <= (failure.endLineNumber ?? failure.lineNumber); line++) failedLines.add(line);
      $('newProfileInput').value = text.split(/\r?\n/).filter((_, i) => failedLines.has(i + 1)).join('\n');
      $('formError').textContent = failures.map(r => `Dòng ${r.lineNumber}: ${r.error}`).join('\n');
      $('formError').hidden = false;
    } else { $('newProfileInput').value = ''; $('createDialog').close(); }
    toast(message, failures.length > 0);
  } catch (error) { $('formError').textContent = error.message; $('formError').hidden = false; }
  finally {
    saving = false; controls.forEach(control => { control.disabled = false; });
    $('submitProfile').querySelector('span').textContent = 'Thêm profile';
  }
});

$('search').addEventListener('input', () => render());
$('chooseChrome').addEventListener('click', async () => {
  $('chooseChrome').disabled = true;
  try { render(await window.googleTool.chooseChrome()); }
  catch (error) { toast(error.message, true); }
  finally { $('chooseChrome').disabled = false; }
});

async function init() {
  try {
    window.googleTool.onChanged(render);
    render(await window.googleTool.load());
    $('createTop').disabled = false;
    $('createEmpty').disabled = false;
  } catch (error) {
    $('emptyTitle').textContent = 'Không tải được dữ liệu';
    $('emptyDescription').textContent = error.message;
    $('resultCount').textContent = 'Không thể tải profiles';
    toast(error.message, true);
  }
}
let fingerprintTarget = null;
let fingerprintDefaults;
let fingerprintBusy = false;
const configFields = [
  ['platform', 'Hệ điều hành', [['windows','Windows'],['macos','macOS'],['linux','Linux']]],
  ['name', 'Tên profile mặc định'], ['locale', 'Ngôn ngữ (language)'],
  ['timezone', 'Múi giờ (timezone)'],
  ['resolution', 'Độ phân giải', ['native']],
  ['windowSize', 'Kích thước cửa sổ', ['1280x720', '1366x768', '1440x900', '1600x900', '1920x1080']],
  ['hardwareConcurrency', 'Luồng CPU', 'number'],
  ['canvas', 'Canvas', [['noise','Noise theo seed'],['off','Không thêm noise']]],
  ['audio', 'AudioContext', [['noise','Noise theo seed'],['off','Không thêm noise']]],
  ['clientrects', 'Client Rects', [['noise','Noise theo seed'],['off','Không thêm noise']]],
  ['font', 'Fonts', [['noise','Theo seed'],['off','Font thật']]],
  ['gpu', 'WebGL Vendor / Renderer', [['auto','Tự động theo seed'],['real','GPU thật của máy']]],
  ['webrtc', 'WebRTC', [['default','Mặc định engine'],['restrict','Chặn UDP ngoài proxy']]],
  ['proxyUrl', 'Proxy (để trống = mặc định hệ thống)'],
  ['proxyUsername', 'Proxy username'],
  ['proxyPassword', 'Proxy password'],
  ['notes', 'Ghi chú mặc định'], ['seed', 'Fingerprint seed', 'number'],
];
const fillFingerprint = window.uiTrace('renderer.fillFingerprint', function (value) {
  $('fingerprintFields').replaceChildren();
  for (const [key, label, options] of configFields) {
    if ((fingerprintTarget && ['name','notes'].includes(key)) || (!fingerprintTarget && key === 'seed')) continue;
    const field = element('label', 'field', label);
    const input = document.createElement(Array.isArray(options) ? 'select' : 'input');
    input.name = key; input.id = `fp-${key}`;
    if (Array.isArray(options)) for (const item of options) {
      const [v, text] = Array.isArray(item) ? item : [item, item === 'native' ? 'Theo máy' : item];
      input.add(new Option(text, v));
    } else {
      input.type = options === 'number' ? 'number' : 'text';
      if (options === 'number') { input.min = '1'; input.max = key === 'seed' ? '2147483646' : '128'; input.required = true; }
    }
    if (key === 'proxyUrl') input.placeholder = 'host:port hoặc http://user:pass@host:port';
    if (key === 'proxyPassword') { input.type = 'password'; input.autocomplete = 'new-password'; }
    if (key === 'timezone') input.placeholder = 'Asia/Ho_Chi_Minh';
    if (key === 'locale') input.placeholder = 'en-US';
    input.value = value[key] ?? '';
    if (key === 'windowSize') {
      input.add(new Option('Custom', 'custom'));
      if (!options.includes(value[key])) input.value = 'custom';
    }
    field.append(input); $('fingerprintFields').append(field);
    if (key === 'windowSize') {
      const custom = element('div', 'custom-window-size');
      const parts = (value[key] || '1280x720').split('x');
      for (const [index, axis, label, min, max] of [[0, 'width', 'Chiều rộng (px)', 400, 7680], [1, 'height', 'Chiều cao (px)', 300, 4320]]) {
        const caption = element('span', '', label);
        const dimension = document.createElement('input');
        dimension.type = 'number'; dimension.id = `fp-window-${axis}`;
        dimension.min = min; dimension.max = max; dimension.step = 1; dimension.value = parts[index];
        dimension.setAttribute('aria-label', label); caption.append(dimension); custom.append(caption);
      }
      const toggle = window.uiTrace('renderer.windowSizeChange', () => {
        custom.hidden = input.value !== 'custom';
        for (const dimension of custom.querySelectorAll('input')) { dimension.required = !custom.hidden; dimension.disabled = custom.hidden; }
      });
      input.addEventListener('change', toggle); field.append(custom); toggle();
    }
    if (key === 'resolution') { input.disabled = true; field.append(element('small', '', 'Bản engine hiện tại chưa hỗ trợ đổi độ phân giải báo cho website.')); }
  }
});
async function showFingerprint(profile) {
  try {
    const data = await window.googleTool.getTemplate();
    fingerprintTarget = profile;
    fingerprintDefaults = data.defaults;
    $('fingerprintTitle').textContent = profile ? `Cấu hình: ${profile.name}` : 'Template tạo profile';
    $('fingerprintDescription').textContent = profile ? 'Lưu cấu hình mới cho lần mở tiếp theo. Cookie và phiên đăng nhập được giữ nguyên.' : 'Áp dụng cho profile tạo mới. Mỗi profile nhận một seed riêng; profile cũ không thay đổi.';
    $('fingerprintSave').textContent = profile ? 'Lưu cấu hình' : 'Lưu template';
    $('fingerprintError').hidden = true;
    fillFingerprint(profile ? { ...data.defaults, ...profile.fingerprint } : data.current);
    $('fingerprintDialog').showModal();
  } catch (error) { toast(error.message, true); }
}
$('fingerprintClose').addEventListener('click', () => { if (!fingerprintBusy) $('fingerprintDialog').close(); });
$('fingerprintDialog').addEventListener('cancel', event => { if (fingerprintBusy) event.preventDefault(); });
$('fingerprintReset').addEventListener('click', () => fillFingerprint({ ...fingerprintDefaults, ...(fingerprintTarget ? { seed: fingerprintTarget.fingerprint.seed } : {}) }));
$('fingerprintForm').addEventListener('submit', window.uiTrace('renderer.saveFingerprint', async event => {
  event.preventDefault();
  if (fingerprintBusy) return;
  const config = Object.fromEntries(new FormData(event.currentTarget));
  if (config.windowSize === 'custom') config.windowSize = `${$('fp-window-width').value}x${$('fp-window-height').value}`;
  config.resolution = 'native';
  config.hardwareConcurrency = Number(config.hardwareConcurrency);
  if (config.seed) config.seed = Number(config.seed);
  fingerprintBusy = true;
  const controls = [...event.currentTarget.elements]; controls.forEach(c => { c.disabled = true; });
  try {
    if (fingerprintTarget) await window.googleTool.editFingerprint({ id: fingerprintTarget.id, fingerprint: config });
    else await window.googleTool.saveTemplate(config);
    $('fingerprintDialog').close();
    toast(fingerprintTarget ? 'Đã lưu cấu hình fingerprint.' : 'Đã lưu template cho profile mới.');
  } catch (error) { $('fingerprintError').textContent = error.message; $('fingerprintError').hidden = false; }
  finally { fingerprintBusy = false; controls.forEach(c => { c.disabled = c.name === 'resolution' || Boolean(c.closest('.custom-window-size')?.hidden); }); }
}));
init();

