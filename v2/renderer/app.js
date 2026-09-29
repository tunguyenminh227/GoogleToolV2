const $ = id => document.getElementById(id);
let state = { profiles: [], chromePath: null };
let saving = false;
let toastTimer;
let opener;
const opening = new Set();
const selected = new Set();
let sortKey = 'stt';
let sortDirection = 1;
let selectedMailStatus = 'all';
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
    } else if (fieldsToCopy === 'passkey') {
      lines.push(p.passkey || '');
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
      securityCode: 'Security code',
      passkey: 'Passkey'
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
  if (selectedAction === 'verify-ads' || selectedAction === 'appeal-ads' || runImmediately) $('runAction').click();
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
  if (actionBusy || !selected.size || !['open', 'delete', 'login-gmail', 'enable-passkey', 'verify-ads', 'appeal-ads'].includes(selectedAction)) return;
  const ids = [...selected];
  const action = selectedAction;
  if (action === 'verify-ads' || action === 'appeal-ads') {
    closeActionMenu();
    openVerifyAdsModal(action === 'appeal-ads' ? 'appeal' : 'verify');
    return;
  }
  if (['open', 'login-gmail', 'enable-passkey'].includes(action) && !$('threadLimit').reportValidity()) return;
  actionBusy = true; closeActionMenu(); updateSelection();
  let completed = 0, skipped = 0;
  const errors = [];
  try {
    if (['open', 'login-gmail', 'enable-passkey', 'verify-ads'].includes(action)) {
      const result = await window.googleTool.openProfiles({ ids, limit: Number($('threadLimit').value), action });
      const actionName = action === 'login-gmail' ? 'Login gmail' : action === 'enable-passkey' ? 'bật Passkey' : action === 'verify-ads' ? 'xác minh Ads' : 'mở';
      toast(`Đã thêm ${result.added} profile vào hàng đợi ${actionName}.`);
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
        if (action === 'enable-passkey') await window.googleTool.enablePasskey(id);
        if (action === 'verify-ads') await window.googleTool.verifyAds(id);
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
$('mailStatusTabs')?.addEventListener('click', window.uiTrace('renderer.statusFilter', event => {
  const button = event.target.closest('[data-status]');
  if (!button) return;
  const status = button.dataset.status;
  if (selectedMailStatus === status) return;
  selectedMailStatus = status;
  render();
}));
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
  verify_phone: 'Verify Phone',
  rejected: 'Rejected',
  inbox: 'Đang vào Gmail…',
  success: 'Success',
  manual: 'Manual',
  error: 'Error',
  recaptcha: 'Giải reCAPTCHA…',
  passkey_enabled: 'Đã bật Passkey',
  passkey_creating: 'Đang tạo Passkey…'
};

function getProfileCategory(p) {
  if (!p) return 'new';
  if (p.mailStatus === 'rejected') return 'rejected';
  if (p.mailStatus === 'verify_phone') return 'verify_phone';
  if (p.mailStatus === 'manual') return 'manual';
  if (p.mailStatus === 'success' || p.mailStatus === 'passkey_enabled') return 'success';
  if (p.mailStatus === 'error' || Boolean(p.mailError)) return 'error';
  if (!p.mailStatus) return 'new';
  return p.mailStatus;
}

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

  const counts = {
    all: profiles.length,
    new: 0,
    success: 0,
    error: 0,
    rejected: 0,
    verify_phone: 0,
    manual: 0
  };
  for (const p of profiles) {
    const cat = getProfileCategory(p);
    if (counts[cat] !== undefined) counts[cat]++;
  }
  document.querySelectorAll('#mailStatusTabs [data-status]').forEach(tab => {
    const status = tab.dataset.status;
    const badge = tab.querySelector('.tab-count');
    const cnt = counts[status] ?? 0;
    if (badge) {
      badge.textContent = cnt;
      badge.classList.toggle('has-count', cnt > 0);
    }
    const isSel = status === selectedMailStatus;
    tab.classList.toggle('selected', isSel);
    tab.setAttribute('aria-selected', isSel ? 'true' : 'false');
  });

  const query = $('search').value.trim().toLocaleLowerCase('vi');
  const filteredByStatus = selectedMailStatus === 'all'
    ? profiles
    : profiles.filter(p => getProfileCategory(p) === selectedMailStatus);

  const visible = filteredByStatus.filter(p =>
    [p.name, p.email, p.recoveryMail, p.notes, p.notes2, p.passkey, p.mailError, mailLabels[p.mailStatus], !p.mailStatus ? 'NEW' : ''].some(value => String(value || '').toLocaleLowerCase('vi').includes(query))).slice();
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
    const isError = Boolean(p.mailError) || ['error', 'rejected', 'verify_phone', 'manual'].includes(p.mailStatus);
    const isSuccess = p.mailStatus === 'success' || p.mailStatus === 'passkey_enabled';
    const isProgress = ['starting', 'email', 'password', 'recovery', 'totp', 'selection', 'skotp', 'recaptcha', 'inbox', 'passkey_creating'].includes(p.mailStatus);
    const statusClass = isError ? ' status-error' : (isSuccess ? ' status-success' : (isProgress ? ' status-progress' : ''));
    const displayText = (p.mailStatus && mailLabels[p.mailStatus]) ? mailLabels[p.mailStatus] : (p.mailError || 'NEW');
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
      accountCell('password', true), accountCell('recoveryMail'), accountCell('twofa', true), accountCell('securityCode', true),
      accountCell('passkey', true), proxy,
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

$('search').addEventListener('input', window.uiTrace('renderer.search', () => render()));
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
// Settings Dialog — danh sách server GCP (Ads API)
const GCP_FIELDS = ['clientId', 'clientSecret', 'developerToken', 'refreshToken'];
let gcpCardSeq = 0;
const newGcpServerId = () => `gcp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const gcpCards = () => [...$('gcpServerList').querySelectorAll('.gcp-server-card')];
const gcpActiveRadio = card => card.querySelector('.gcp-server-active input');

function refreshGcpServerList() {
  const cards = gcpCards();
  $('gcpServerEmpty').hidden = cards.length > 0;
  if (cards.length && !cards.some(card => gcpActiveRadio(card).checked)) gcpActiveRadio(cards[0]).checked = true;
}

function addGcpServerCard(server, active) {
  const card = $('gcpServerTemplate').content.firstElementChild.cloneNode(true);
  const uid = ++gcpCardSeq;
  card.dataset.id = server.id;
  card.querySelector('[data-field="name"]').value = server.name || '';
  GCP_FIELDS.forEach(field => {
    const input = card.querySelector(`[data-field="${field}"]`);
    input.id = `gcp-${field}-${uid}`;
    input.value = server[field] || '';
  });
  card.querySelectorAll('label[data-for]').forEach(label => { label.htmlFor = `gcp-${label.dataset.for}-${uid}`; });
  const radio = gcpActiveRadio(card);
  radio.value = server.id;
  radio.checked = Boolean(active);
  $('gcpServerList').append(card);
  refreshGcpServerList();
  return card;
}

function readGcpServerCard(card, index) {
  const server = { id: card.dataset.id, name: card.querySelector('[data-field="name"]').value.trim() || `GCP ${index + 1}` };
  GCP_FIELDS.forEach(field => { server[field] = card.querySelector(`[data-field="${field}"]`).value.trim(); });
  return server;
}

$('openGcpSettings').addEventListener('click', async () => {
  $('gcpSettingsError').hidden = true;
  $('gcpServerList').replaceChildren();
  $('gcpServerEmpty').hidden = true;
  $('gcpSettingsDialog').showModal();
  $('gcpSettingsSave').disabled = true;
  $('gcpSettingsSave').textContent = 'Đang đồng bộ Firebase…';
  try {
    const data = await window.googleTool.getGcpAdsServers();
    data.servers.forEach(server => addGcpServerCard(server, server.id === data.activeId));
    if (!data.servers.length) addGcpServerCard({ id: newGcpServerId(), name: 'GCP 1' }, true);
  } catch (error) {
    toast(error.message, true);
    refreshGcpServerList();
  } finally {
    $('gcpSettingsSave').disabled = false;
    $('gcpSettingsSave').textContent = 'Lưu cài đặt';
  }
});

// Pool worker: ô trạng thái trên thanh trên cùng + bảng cấu hình trong dialog Cài đặt (chỉ poll khi dialog mở)
window.poolApi.setPoolBase('/api/pool'); // khớp prefix ở main process
window.mountPoolStatus($('poolStatus'));
const poolPanel = window.createPoolPanel($('poolPanel'));
$('openGcpSettings').addEventListener('click', poolPanel.start);
$('gcpSettingsDialog').addEventListener('close', poolPanel.stop);

$('gcpAddServer').addEventListener('click', () => {
  const card = addGcpServerCard({ id: newGcpServerId(), name: `GCP ${gcpCards().length + 1}` }, false);
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  card.querySelector('[data-field="clientId"]').focus({ preventScroll: true });
});

$('gcpServerList').addEventListener('click', event => {
  const card = event.target.closest('.gcp-server-card');
  if (!card) return;
  if (event.target.closest('.gcp-server-remove')) {
    card.remove();
    refreshGcpServerList();
    return;
  }
  if (event.target.closest('.gcp-upload-json')) card.querySelector('.gcp-json-file').click();
});

$('gcpServerList').addEventListener('change', event => {
  const fileInput = event.target.closest('.gcp-json-file');
  const file = fileInput?.files?.[0];
  if (!file) return;
  const card = fileInput.closest('.gcp-server-card');
  const setField = (field, value) => { if (value) card.querySelector(`[data-field="${field}"]`).value = value; };
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      const oauth = data.installed || data.web || data;
      setField('clientId', oauth.client_id);
      setField('clientSecret', oauth.client_secret);
      setField('developerToken', data.developer_token || data.developerToken);
      setField('refreshToken', data.refresh_token || data.refreshToken);      toast('Đã nạp thông tin từ file JSON.');
    } catch {
      toast('Không thể đọc file JSON hợp lệ.', true);
    } finally {
      fileInput.value = '';
    }
  };
  reader.readAsText(file);
});

const closeGcpSettings = () => $('gcpSettingsDialog').close();
$('closeGcpSettings').addEventListener('click', closeGcpSettings);
$('gcpSettingsCancel').addEventListener('click', closeGcpSettings);

$('gcpSettingsForm').addEventListener('submit', async event => {
  event.preventDefault();
  const cards = gcpCards();
  const servers = cards.map(readGcpServerCard);
  const missing = servers.findIndex(server => !server.clientId);
  if (missing >= 0) {
    $('gcpSettingsError').textContent = `Server "${servers[missing].name}" chưa có Client ID.`;
    $('gcpSettingsError').hidden = false;
    cards[missing].querySelector('[data-field="clientId"]').focus();
    return;
  }
  const activeCard = cards.find(card => gcpActiveRadio(card).checked);
  $('gcpSettingsError').hidden = true;

  $('gcpSettingsSave').disabled = true;
  $('gcpSettingsSave').textContent = 'Đang lưu lên Firebase…';
  try {
    await window.googleTool.saveGcpAdsServers({ activeId: activeCard?.dataset.id || '', servers });
    $('gcpSettingsDialog').close();
    toast('Đã lưu cài đặt và đồng bộ lên Firebase thành công.');
  } catch (error) {
    $('gcpSettingsError').textContent = error.message;
    $('gcpSettingsError').hidden = false;
  } finally {
    $('gcpSettingsSave').disabled = false;
    $('gcpSettingsSave').textContent = 'Lưu cài đặt';
  }
});

// Dialog Tạo link đăng nhập Ads
$('btnAdsLoginLink').addEventListener('click', async () => {
  $('adsLinkError').hidden = true;
  $('adsLinkSuccess').hidden = true;
  $('adsAuthCodeInput').value = '';
  $('adsOauthUrl').value = 'Đang tạo link…';
  $('adsLinkDialog').showModal();
  try {
    const res = await window.googleTool.getGcpAdsAuthLink();
    $('adsOauthUrl').value = res.url;
  } catch (error) {
    $('adsOauthUrl').value = '';
    $('adsLinkError').textContent = error.message;
    $('adsLinkError').hidden = false;
  }
});

const closeAdsLink = () => $('adsLinkDialog').close();
$('closeAdsLink').addEventListener('click', closeAdsLink);
$('cancelAdsLink').addEventListener('click', closeAdsLink);

$('btnCopyAdsLink').addEventListener('click', async () => {
  const url = $('adsOauthUrl').value;
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    toast('Đã sao chép link đăng nhập Ads.');
  } catch {
    $('adsOauthUrl').select();
    document.execCommand('copy');
    toast('Đã sao chép link đăng nhập Ads.');
  }
});

$('btnOpenAdsLink').addEventListener('click', async () => {
  const url = $('adsOauthUrl').value;
  if (!url) return;
  try {
    await window.googleTool.openExternal(url);
  } catch (error) {
    toast(error.message, true);
  }
});

$('btnExchangeAdsCode').addEventListener('click', async () => {
  const codeOrUrl = $('adsAuthCodeInput').value.trim();
  if (!codeOrUrl) {
    $('adsLinkError').textContent = 'Vui lòng dán URL chuyển hướng hoặc mã Authorization Code.';
    $('adsLinkError').hidden = false;
    return;
  }
  $('adsLinkError').hidden = true;
  $('adsLinkSuccess').hidden = true;
  $('btnExchangeAdsCode').disabled = true;
  $('btnExchangeAdsCode').textContent = 'Đang đổi token…';
  try {
    const res = await window.googleTool.exchangeGcpAdsCode({ codeOrUrl });
    $('adsLinkSuccess').textContent = `✅ Đã đổi mã code lấy Refresh Token và lưu thành công vào server GCP "${res.serverName || ''}" & Firebase!`;
    $('adsLinkSuccess').hidden = false;
    toast('Đã cập nhật Refresh Token thành công.');
  } catch (error) {
    $('adsLinkError').textContent = error.message;
    $('adsLinkError').hidden = false;
  } finally {
    $('btnExchangeAdsCode').disabled = false;
    $('btnExchangeAdsCode').textContent = 'Đổi Refresh Token & Lưu';
  }
});

// Dialog Quét MCC — dùng chung cho "Xác minh tài khoản ads" (verify) và "Kháng" (appeal)
let currentSelectedProfilesForVerify = [];
let currentScannedVerifyAccounts = [];
let currentScannedMccId = null;
const VERIFY_MODES = {
  verify: {
    title: 'Xác minh tài khoản Google Ads',
    subtitle: 'Chọn tài khoản quản lý (MCC) để quét danh sách các tài khoản con cần xác minh danh tính nhà quảng cáo (Advertiser Verification).',
    help: 'Danh sách MCC gồm các MCC mà tài khoản Google của server GCP đang dùng (trong Cài đặt) truy cập trực tiếp, lấy qua Google Ads API.',
    scan: mccId => window.googleTool.scanMccVerification(mccId),
    list: res => res.needingVerification || [],
    summary: (count, total, mcc, res) => {
      const list = res.needingVerification || [];
      const live = list.filter(a => a.accountStatus === 'ENABLED').length;
      const suspended = list.filter(a => a.accountStatus === 'SUSPENDED').length;
      return `Kết quả: Tìm thấy ${count} tài khoản cần xác minh (${live} Live, ${suspended} Suspend) / Tổng số ${total} tài khoản trong MCC ${mcc}${res.skippedCount ? `, bỏ qua ${res.skippedCount} tài khoản đã hủy/đóng` : ''}.`;
    },
    empty: '🎉 Tất cả tài khoản trong MCC đều đã xác minh hoặc không có yêu cầu xác minh lúc này.',
    verb: 'Verify', noun: 'xác minh',
  },
  appeal: {
    title: 'Kháng tài khoản Google Ads bị tạm ngưng',
    subtitle: 'Chọn tài khoản quản lý (MCC) để quét danh sách các tài khoản con đang bị tạm ngưng (Suspended) và mở từng tài khoản để gửi kháng nghị.',
    help: 'Danh sách MCC gồm các MCC mà tài khoản Google của server GCP đang dùng (trong Cài đặt) truy cập trực tiếp, lấy qua Google Ads API.',
    scan: mccId => window.googleTool.scanMccSuspended(mccId),
    list: res => res.suspended || [],
    summary: (count, total, mcc) => `Kết quả: Tìm thấy ${count} tài khoản bị tạm ngưng / Tổng số ${total} tài khoản trong MCC ${mcc}.`,
    empty: '🎉 Không có tài khoản nào trong MCC bị tạm ngưng.',
    verb: 'Kháng', noun: 'kháng',
  },
};
let verifyMode = VERIFY_MODES.verify;
// Ô nhập ID MCC thủ công hoặc dropdown MCC lấy tự động từ Ads API
function showMccInput(manual) {
  $('mccIdInput').hidden = !manual;
  $('mccSelect').hidden = manual;
  $('mccFieldLabel').htmlFor = manual ? 'mccIdInput' : 'mccSelect';
  $('mccFieldLabel').textContent = manual ? 'ID MCC cần quét' : 'MCC cần quét';
}

let mccLoadSeq = 0;
async function loadAccessibleMccs() {
  const seq = ++mccLoadSeq;
  const select = $('mccSelect');
  showMccInput(false);
  select.disabled = true;
  $('btnScanMcc').disabled = true;
  select.replaceChildren(new Option('Đang tải danh sách MCC từ Google Ads API…', ''));
  try {
    const mccs = await window.googleTool.listAccessibleMccs();
    if (seq !== mccLoadSeq) return;
    if (!mccs.length) throw new Error('Tài khoản Google của server GCP đang dùng không truy cập trực tiếp MCC nào.');
    select.replaceChildren(...mccs.map(m => new Option(`${m.name} (${m.formattedId})`, m.id)));
    select.disabled = false;
  } catch (error) {
    if (seq !== mccLoadSeq) return;
    showMccInput(true);
    $('verifyAdsError').textContent = `${error.message} Bạn có thể nhập ID MCC thủ công.`;
    $('verifyAdsError').hidden = false;
  } finally {
    if (seq === mccLoadSeq) $('btnScanMcc').disabled = false;
  }
}

// Trạng thái tài khoản Google Ads (customer_client.status): Live / Suspend
const accountStatusBadge = window.uiTrace('renderer.accountStatusBadge', status => {
  if (status === 'ENABLED') return '<span class="account-badge is-live">Live</span>';
  if (status === 'SUSPENDED') return '<span class="account-badge is-suspended">Suspend</span>';
  return '<span class="account-badge">—</span>';
});

const escapeAttr = value => String(value ?? '').replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);

const openVerifyAdsModal = window.uiTrace('renderer.openVerifyAdsModal', async (mode = 'verify') => {
  if (VERIFY_MODES[mode] !== verifyMode) {
    currentScannedVerifyAccounts = [];
    $('verifyAdsTableBody').innerHTML = '';
  }
  verifyMode = VERIFY_MODES[mode];
  $('verifyAdsTitle').textContent = verifyMode.title;
  $('verifyAdsSubtitle').textContent = verifyMode.subtitle;
  $('verifyAdsHelp').textContent = verifyMode.help;
  mccLoadSeq++;
  showMccInput(true);
  $('btnScanMcc').disabled = false;
  currentSelectedProfilesForVerify = [...selected];
  $('verifyAdsError').hidden = true;
  $('verifyAdsSuccess').hidden = true;
  $('verifyAdsResults').hidden = true;
  $('verifyAdsLoading').style.display = 'none';

  const selectEl = $('verifyProfileSelect');
  if (selectEl) {
    selectEl.innerHTML = '';
    // Chỉ thực hiện trên profile đã chọn khi mở thao tác; chưa chọn profile nào thì cho chọn trong toàn bộ danh sách
    const allProfiles = state?.profiles || [];
    const chosen = allProfiles.filter(p => currentSelectedProfilesForVerify.includes(p.id));
    const profileList = chosen.length ? chosen : allProfiles;
    selectEl.disabled = chosen.length === 1;
    if (profileList.length > 0) {
      profileList.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        const name = p.name || 'Profile';
        opt.textContent = p.email && p.email !== name ? `${name} (${p.email})` : name;
        selectEl.appendChild(opt);
      });
    } else {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '-- Chưa có profile nào trong danh sách --';
      selectEl.appendChild(opt);
    }
  }

  $('verifyAdsDialog').showModal();
  loadAccessibleMccs();
});

const closeVerifyAds = window.uiTrace('renderer.closeVerifyAds', () => $('verifyAdsDialog').close());
$('closeVerifyAds').addEventListener('click', closeVerifyAds);
$('cancelVerifyAds').addEventListener('click', closeVerifyAds);

$('mccIdInput').addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    $('btnScanMcc').click();
  }
});

$('btnScanMcc').addEventListener('click', window.uiTrace('renderer.scanMccVerification', async () => {
  const mccId = ($('mccSelect').hidden ? $('mccIdInput').value : $('mccSelect').value).trim();
  if (!mccId) {
    $('verifyAdsError').textContent = $('mccSelect').hidden ? 'Vui lòng nhập ID MCC (10 chữ số).' : 'Vui lòng chọn MCC.';
    $('verifyAdsError').hidden = false;
    return;
  }

  $('verifyAdsError').hidden = true;
  $('verifyAdsSuccess').hidden = true;
  $('verifyAdsResults').hidden = true;
  $('verifyAdsLoading').style.display = 'flex';
  $('verifyAdsLoadingText').textContent = `Đang kết nối Google Ads API và quét danh sách tài khoản trong MCC ${mccId}…`;
  $('btnScanMcc').disabled = true;

  const mode = verifyMode;
  try {
    const res = await mode.scan(mccId);
    currentScannedVerifyAccounts = mode.list(res);
    currentScannedMccId = res.mccId || res.formattedMccId || mccId;

    const total = res.totalAccounts || 0;
    const needCount = currentScannedVerifyAccounts.length;

    $('verifyAdsSummary').textContent = mode.summary(needCount, total, res.formattedMccId, res);

    const tbody = $('verifyAdsTableBody');
    tbody.innerHTML = '';

    if (needCount === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.style.cssText = 'padding: 16px; text-align: center; color: #188038; font-weight: 500;';
      td.textContent = mode.empty;
      tr.append(td);
      tbody.appendChild(tr);
    } else {
      currentScannedVerifyAccounts.forEach(item => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid #edf0f5';

        let badgeClass = 'badge-verify-action';
        if (item.status === 'PENDING_REVIEW') badgeClass = 'badge-verify-review';
        else if (item.status === 'SUCCESS' || item.status === 'NOT_REQUIRED') badgeClass = 'badge-verify-ok';

        const url = escapeAttr(item.actionUrl);
        tr.innerHTML = `
          <td style="padding: 8px 10px; font-weight: 600; color: #25314a;">${escapeAttr(item.formattedId)}</td>
          <td style="padding: 8px 10px; color: #475674; max-width: 170px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeAttr(item.name)}">${escapeAttr(item.name)}</td>
          <td class="account-status-col">${accountStatusBadge(item.accountStatus)}</td>
          <td style="padding: 8px 10px;"><span class="${badgeClass}" title="${escapeAttr([item.deadline && `Hạn xác minh: ${item.deadline}`, item.linkExpiresAt && `Link hết hạn: ${item.linkExpiresAt}`].filter(Boolean).join('\n'))}">${escapeAttr(item.statusText)}</span></td>
          <td style="padding: 8px 10px; text-align: right; white-space: nowrap;">
            <button type="button" class="button primary small btn-verify-one" data-url="${url}" data-id="${escapeAttr(item.formattedId)}" style="padding: 4px 10px; font-size: 11px; margin-right: 4px; font-weight: 600;" title="${mode.verb} tài khoản này">
              <svg style="width: 12px; height: 12px; vertical-align: -1px; margin-right: 2px;"><use href="#i-check"/></svg> ${mode.verb}
            </button>
            <button type="button" class="button secondary small btn-copy-one-verify" data-url="${url}" style="padding: 4px 8px; font-size: 11px; margin-right: 4px;" title="Copy link ${mode.noun}">
              <svg style="width: 12px; height: 12px;"><use href="#i-copy"/></svg> Copy
            </button>
            <button type="button" class="button secondary small btn-open-one-verify" data-url="${url}" style="padding: 4px 8px; font-size: 11px;" title="Mở link trên trình duyệt mặc định">
              <svg style="width: 12px; height: 12px;"><use href="#i-external"/></svg> Mở
            </button>
          </td>
        `;
        tbody.appendChild(tr);
      });
    }

    const btnBatch = $('btnOpenSelectedProfilesVerify');
    if (currentScannedVerifyAccounts.length > 0) {
      btnBatch.hidden = false;
      const count = Math.min(currentSelectedProfilesForVerify.length, currentScannedVerifyAccounts.length);
      if (currentSelectedProfilesForVerify.length > 0) {
        btnBatch.querySelector('span').textContent = `${mode.verb} trên ${count} profile đã chọn`;
      } else {
        btnBatch.querySelector('span').textContent = `${mode.verb} tất cả link (${currentScannedVerifyAccounts.length})`;
      }
    } else {
      btnBatch.hidden = true;
    }

    $('verifyAdsResults').hidden = false;
  } catch (error) {
    $('verifyAdsError').textContent = error.message;
    $('verifyAdsError').hidden = false;
  } finally {
    $('verifyAdsLoading').style.display = 'none';
    $('btnScanMcc').disabled = false;
  }
}));

$('btnCopyAllVerifyLinks').addEventListener('click', window.uiTrace('renderer.copyAllVerifyLinks', async () => {
  if (!currentScannedVerifyAccounts || !currentScannedVerifyAccounts.length) {
    toast('Không có tài khoản nào để copy.', true);
    return;
  }
  const lines = currentScannedVerifyAccounts.map(a => `${a.formattedId}\t${a.name}\t${a.actionUrl}`);
  const ok = await copyTextToClipboard(lines.join('\n'));
  if (ok) {
    toast(`Đã sao chép link ${verifyMode.noun} của ${currentScannedVerifyAccounts.length} tài khoản.`);
  } else {
    toast('Không thể sao chép vào clipboard.', true);
  }
}));

$('verifyAdsTableBody').addEventListener('click', window.uiTrace('renderer.tableVerifyActions', async event => {
  const verifyBtn = event.target.closest('.btn-verify-one');
  if (verifyBtn) {
    const url = verifyBtn.dataset.url;
    const id = verifyBtn.dataset.id;
    if (!url) return;

    const chosenProfileId = $('verifyProfileSelect')?.value || currentSelectedProfilesForVerify[0];
    const rawMcc = ($('mccSelect').hidden ? $('mccIdInput').value : $('mccSelect').value).trim();
    const mccId = rawMcc || currentScannedMccId;
    if (chosenProfileId) {
      try {
        toast(`Đang mở profile và chuyển tab hiện tại tới Google Ads...`);
        await window.googleTool.verifyAds({ id: chosenProfileId, url: 'https://ads.google.com/', mccId: mccId || id, customerId: id, actionUrl: url });
        toast(`Đã chuyển tới trang Google Ads thành công.`);
      } catch (err) {
        toast(err.message, true);
      }
    } else {
      toast('Vui lòng chọn một profile trong mục "Profile thực hiện" phía trên.', true);
    }
    return;
  }

  const copyBtn = event.target.closest('.btn-copy-one-verify');
  if (copyBtn) {
    const url = copyBtn.dataset.url;
    if (url) {
      const ok = await copyTextToClipboard(url);
      toast(ok ? `Đã sao chép link ${verifyMode.noun}.` : 'Lỗi khi sao chép.', !ok);
    }
    return;
  }

  const openBtn = event.target.closest('.btn-open-one-verify');
  if (openBtn) {
    const url = openBtn.dataset.url;
    if (url) {
      try {
        await window.googleTool.openExternal(url);
      } catch (err) {
        toast(err.message, true);
      }
    }
    return;
  }
}));

$('btnOpenSelectedProfilesVerify').addEventListener('click', window.uiTrace('renderer.openSelectedProfilesVerify', async () => {
  if (!currentScannedVerifyAccounts.length) return;
  const btn = $('btnOpenSelectedProfilesVerify');
  btn.disabled = true;
  const chosenProfileId = $('verifyProfileSelect')?.value || currentSelectedProfilesForVerify[0];
  const rawMcc = ($('mccSelect').hidden ? $('mccIdInput').value : $('mccSelect').value).trim();
  const mccId = rawMcc || currentScannedMccId;
  try {
    if (chosenProfileId) {
      toast(`Đang mở profile và thực hiện xác minh ${currentScannedVerifyAccounts.length} tài khoản...`);
      const accounts = currentScannedVerifyAccounts.map(a => ({
        id: a.formattedId || a.id,
        actionUrl: a.actionUrl
      }));
      await window.googleTool.verifyAdsBatch({
        id: chosenProfileId,
        mccId,
        accounts,
        customerIds: accounts.map(a => a.id),
        urls: accounts.map(a => a.actionUrl)
      });
      toast(`Đã mở và sắp xếp các cửa sổ tài khoản thành công.`);
      $('verifyAdsDialog').close();
    } else {
      toast('Vui lòng chọn một profile trong mục "Profile thực hiện" phía trên.', true);
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}));

init();

