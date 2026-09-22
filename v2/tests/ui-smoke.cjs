// Run with the Electron binary, not Node. Exercises the actual v2 main/preload/UI.
// Uses a temporary appData location, so it never reads or changes real profiles.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { ProfileStore } = require('../profile-store');
const engine = require('../engine-config');
let deleteResponse = 0;
let deletePromptCount = 0;
require('electron').dialog.showMessageBox = async () => { deletePromptCount++; return { response: deleteResponse }; };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'googletool-v2-ui-'));
app.disableHardwareAcceleration();
app.setPath('appData', root);
app.on('browser-window-created', (_event, win) => win.hide());
const errors = [];
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (_event, level, message) => {
    if (level >= 3) errors.push(message);
  });
  contents.on('render-process-gone', (_event, details) => errors.push(`Renderer terminated: ${details.reason}`));
});

require('../main');

const timeout = setTimeout(() => {
  console.error('UI_SMOKE_FAIL: timeout');
  app.exit(1);
}, 30000);

app.whenReady().then(async () => {
  try {
    const win = BrowserWindow.getAllWindows()[0];
    assert.ok(win, 'Main window exists');
    if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    const result = await win.webContents.executeJavaScript(`(async () => {
      const waitFor = async predicate => {
        for (let i = 0; i < 100; i++) {
          if (predicate()) return;
          await new Promise(resolve => setTimeout(resolve, 30));
        }
        throw new Error('UI condition timed out');
      };
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      await waitFor(() => !document.getElementById('createTop').disabled);
      check(document.getElementById('navCount').textContent === '0', 'Initial empty state');
      document.getElementById('createTop').click();
      await waitFor(() => document.getElementById('createDialog').open);
      document.getElementById('createTemplate').click();
      await waitFor(() => document.getElementById('fingerprintDialog').open);
      document.getElementById('fingerprintClose').click();
      check(document.getElementById('createDialog').open, 'Import stays open after template');
      document.getElementById('newProfileInput').value = 'work@example.com|fake-password-for-test||JBSWY3DPEHPK3PXP\\npersonal@example.com\\t\\trecovery@example.com\\t\\ninvalid-email';
      document.getElementById('createForm').requestSubmit();
      await waitFor(() => !document.getElementById('submitProfile').disabled && !document.getElementById('formError').hidden);
      check(document.getElementById('newProfileInput').value === 'invalid-email', 'Only failed input retained');
      check((await window.googleTool.load()).profiles.length === 2, 'Partial successes persisted');
      document.getElementById('newProfileInput').value = 'project@example.com';
      document.getElementById('createForm').requestSubmit();
      await waitFor(() => !document.getElementById('createDialog').open);
      check(document.querySelectorAll('#profileRows tr').length === 3, 'Three profiles rendered');
      check(document.getElementById('dialogTitle').textContent === 'Tạo profile mới', 'Vietnamese dialog title preserved');
      check(document.getElementById('submitProfile').textContent.includes('Thêm profile'), 'Vietnamese submit label preserved');
      document.getElementById('search').value = 'work@';
      document.getElementById('search').dispatchEvent(new Event('input'));
      check(document.querySelectorAll('#profileRows tr').length === 1, 'Search filters profiles');
      document.getElementById('search').value = '';
      document.getElementById('search').dispatchEvent(new Event('input'));
      document.getElementById('createTop').click();
      await waitFor(() => document.getElementById('createDialog').open);
      document.getElementById('newProfileInput').value = 'work@example.com';
      document.getElementById('createForm').requestSubmit();
      await waitFor(() => !document.getElementById('formError').hidden);
      check(document.getElementById('formError').textContent.includes('đã tồn tại'), 'Duplicate validation');
      document.getElementById('cancelDialog').click();
      const hostile = await window.googleTool.createProfile({ name: '<img src=x onerror=alert(1)>', notes: '<script>bad</script>' });
      await waitFor(() => document.querySelectorAll('#profileRows tr').length === 4);
      check(!document.querySelector('#profileRows img, #profileRows script'), 'User input rendered as text');
      const profiles = (await window.googleTool.load()).profiles;
      check(profiles.length === 4, 'Profiles persisted via IPC');
      check(profiles.every(p => !p.running), 'No Chrome launched in test');
      check(new Set(profiles.map(p => p.fingerprint.seed)).size === 4, 'Independent persisted seeds');
      check(profiles[0].fingerprint.gpu === 'auto' && profiles[1].fingerprint.gpu === 'auto', 'Automatic GPU configuration persisted');
      check(document.querySelectorAll('.fingerprint-detail').length === 0, 'No GPU subtitle in profile list');
      const runtime = await window.googleTool.load();
      check(runtime.engineLabel === ${JSON.stringify(engine.label)}, 'Correct Chromium mode');
      check([...document.querySelectorAll('[data-engine-label]')].every(node => node.textContent === runtime.engineLabel), 'Engine labels match selected runtime');
      if (${!process.argv.includes('--allow-missing-runtime')}) {
        check(runtime.chromeVersion === ${JSON.stringify(engine.version)} && Boolean(runtime.chromePath), 'Verified Chromium runtime selected');
      } else {
        check(!runtime.chromePath && Boolean(runtime.chromeError), 'Incomplete runtime remains unavailable');
      }
      check(document.querySelector('.panel-heading h2').textContent === 'Profiles', 'Minimal header');
      check(!document.querySelector('.selection-toolbar, .tabs, .action-heading, .delete-button, #templateButton'), 'Removed header controls and actions');
      check(document.querySelectorAll('#profileTable th').length === 12, 'Table without action column');
      document.getElementById('selectAll').click();
      check(document.querySelectorAll('#profileRows input[type=checkbox]:checked').length === 4, 'Select visible profiles');
      check(!document.getElementById('profileActions').hidden, 'Selection shows Actions and Run');
      check(document.getElementById('actionButton').textContent === 'Thao tác ▾', 'No default action');
      check(document.getElementById('runAction').disabled, 'Run disabled until action selected');
      check([...document.querySelectorAll('[data-action]')].map(b => b.dataset.action).join(',') === 'open,login-gmail,delete', 'Open, Login gmail and Delete actions');
      document.getElementById('actionButton').click();
      document.querySelector('[data-action="login-gmail"]').click();
      check(!document.getElementById('runAction').disabled, 'Login Gmail is enabled');
      document.getElementById('actionButton').click();
      document.querySelector('[data-action="open"]').click();
      check(document.getElementById('actionButton').textContent === 'Mở ▾' && !document.getElementById('runAction').disabled, 'Selected action updates label and enables Run');
      check((await window.googleTool.load()).profiles.every(p => !p.running), 'Selecting action does not launch browsers');
      document.getElementById('selectAll').click();
      check(document.querySelectorAll('#profileRows input[type=checkbox]:checked').length === 0, 'Clear selection');
      check(document.getElementById('profileActions').hidden, 'Actions hidden without selection');
      const firstCheckbox = document.querySelector('#profileRows input[type=checkbox]');
      firstCheckbox.click();
      document.getElementById('actionButton').click();
      document.querySelector('[data-action="delete"]').click();
      check(document.getElementById('actionButton').textContent === 'Xóa ▾', 'Delete selection updates label');
      check((await window.googleTool.load()).profiles.length === 4, 'Selecting Delete does not delete profiles');
      firstCheckbox.click();
      const work = profiles.find(p => p.email === 'work@example.com');
      const row = document.querySelector('[data-id="' + work.id + '"]');
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: innerWidth - 2, clientY: innerHeight - 2 }));
      check(row.querySelector('input[type=checkbox]').checked, 'Right click selects target profile');
      const contextMenu = document.getElementById('actionOptions');
      check(!contextMenu.hidden && contextMenu.classList.contains('context-actions'), 'Right click opens action dropdown');
      const bounds = contextMenu.getBoundingClientRect();
      check(bounds.right <= innerWidth && bounds.bottom <= innerHeight, 'Context menu stays in viewport');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      check(contextMenu.hidden, 'Escape closes context menu');
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
      document.querySelector('[data-action="delete"]').click();
      await waitFor(() => !document.getElementById('actionButton').disabled);
      check((await window.googleTool.load()).profiles.length === 4, 'Cancelling context delete keeps profiles');
      row.querySelector('input[type=checkbox]').click();
      check(!row.textContent.includes('fake-password-for-test'), 'Password masked initially');
      row.querySelector('.reveal-account').click();
      check(row.textContent.includes('fake-password-for-test'), 'Reveal imported password');
      row.querySelector('.reveal-account').click();
      const note = row.querySelectorAll('.note-input')[1];
      note.value = 'Saved second note'; note.dispatchEvent(new Event('change'));
      await waitFor(() => !note.disabled);
      check((await window.googleTool.load()).profiles.find(p => p.id === work.id).notes2 === 'Saved second note', 'Inline Note 2 persisted');
      return { count: profiles.length, hostileId: hostile.id };
    })()`);
    assert.equal(result.count, 4);
    assert.equal(deletePromptCount, 1, 'Context delete runs immediately and requests confirmation');
    assert.equal(new ProfileStore(path.join(root, engine.dataNamespace)).list().length, 4);
    const importedStore = new ProfileStore(path.join(root, engine.dataNamespace));
    const imported = importedStore.list().find(p => p.email === 'work@example.com');
    const secretText = fs.readFileSync(path.join(importedStore.directory(imported.id), '.googletool-account'), 'utf8');
    assert.ok(!secretText.includes('fake-password-for-test'));
    const account = JSON.parse(require('electron').safeStorage.decryptString(Buffer.from(secretText, 'base64')));
    assert.equal(account.password, 'fake-password-for-test');
    assert.equal(account.recoveryMail, '');
    assert.equal(account.twofa, 'JBSWY3DPEHPK3PXP');
    assert.ok(!fs.readFileSync(importedStore.file, 'utf8').includes('fake-password-for-test'));

    const reloaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    win.webContents.reload();
    await reloaded;
    await win.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 100 && document.getElementById('createTop').disabled; i++) await new Promise(resolve => setTimeout(resolve, 30));
      if (document.getElementById('navCount').textContent !== '4') throw new Error('Profiles missing after reload');
    })()`);
    await win.webContents.executeJavaScript(`document.getElementById('search').value = ''; document.getElementById('search').dispatchEvent(new Event('input')); document.getElementById('toast').hidden = true;`);
    const output = path.join(__dirname, '..', 'artifacts');
    fs.mkdirSync(output, { recursive: true });
    await new Promise(resolve => setTimeout(resolve, 300));
    fs.writeFileSync(path.join(output, 'profiles.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`document.getElementById('createTop').click(); document.getElementById('newProfileInput').value = 'marketing@example.com|password|recovery@example.com|JBSWY3DPEHPK3PXP';`);
    await new Promise(resolve => setTimeout(resolve, 300));
    fs.writeFileSync(path.join(output, 'create-profile.png'), (await win.webContents.capturePage()).toPNG());
    win.setSize(960, 640);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(await win.webContents.executeJavaScript(`document.documentElement.scrollWidth <= window.innerWidth`), 'No horizontal page overflow at minimum window size');
    assert.ok(await win.webContents.executeJavaScript(`document.getElementById('createDialog').getBoundingClientRect().height <= window.innerHeight`), 'Dialog fits minimum window height');
    assert.deepEqual(errors, [], 'No renderer errors');
    await win.webContents.executeJavaScript(`document.getElementById('createDialog').close();`);
    await win.webContents.executeJavaScript(`(async () => {
      const waitFor = async f => { for(let i=0;i<150;i++){if(await f())return;await new Promise(r=>setTimeout(r,50));}throw new Error('Fingerprint editor timeout'); };
      const before = (await window.googleTool.load()).profiles;
      document.getElementById('createTop').click(); document.getElementById('createTemplate').click();
      await waitFor(()=>document.getElementById('fingerprintDialog').open);
      document.getElementById('fp-locale').value='vi-VN';
      document.getElementById('fp-windowSize').value='custom';
      document.getElementById('fp-windowSize').dispatchEvent(new Event('change'));
      document.getElementById('fp-window-width').value='1500';
      document.getElementById('fp-window-height').value='850';
      document.getElementById('fp-hardwareConcurrency').value='4';
      document.getElementById('fp-audio').value='off';
      document.getElementById('fingerprintForm').requestSubmit();
      await waitFor(()=>!document.getElementById('fingerprintDialog').open);
      const tpl=(await window.googleTool.getTemplate()).current;
      if(tpl.locale!=='vi-VN'||tpl.hardwareConcurrency!==4||tpl.audio!=='off')throw new Error('Template not saved');
      if(JSON.stringify((await window.googleTool.load()).profiles)!==JSON.stringify(before))throw new Error('Template changed existing profiles');
      document.getElementById('createDialog').close();
      const created=await window.googleTool.createProfile({name:'Template inheritance check'});
      if(created.fingerprint.locale!=='vi-VN'||created.fingerprint.hardwareConcurrency!==4||created.fingerprint.audio!=='off')throw new Error('New profile did not inherit template');
      if(created.fingerprint.windowSize!=='1500x850')throw new Error('New profile did not inherit custom window size');
      window.templateTestProfileId=created.id;
    })()`);
    deleteResponse = 1;
    await win.webContents.executeJavaScript(`(async()=>{document.getElementById('createTop').click(); document.getElementById('createTemplate').click();for(let i=0;i<100&&!document.getElementById('fingerprintDialog').open;i++)await new Promise(r=>setTimeout(r,30));})()`);
    fs.writeFileSync(path.join(output, 'fingerprint-template.png'), (await win.webContents.capturePage()).toPNG());
    assert.ok(await win.webContents.executeJavaScript(`document.getElementById('fingerprintDialog').getBoundingClientRect().width<=innerWidth`));
    await win.webContents.executeJavaScript(`document.getElementById('fingerprintDialog').close();document.getElementById('createDialog').close()`);
    const templateDelete = await win.webContents.executeJavaScript(`window.googleTool.deleteProfile(window.templateTestProfileId)`);
    assert.equal(templateDelete.deleted, true);
    deleteResponse = 0;
    const deletion = await win.webContents.executeJavaScript(`window.googleTool.load().then(s => s.profiles[0])`);
    const cancelled = await win.webContents.executeJavaScript(`window.googleTool.deleteProfile(${JSON.stringify(deletion.id)})`);
    assert.equal(cancelled.deleted, false);
    assert.equal(new ProfileStore(path.join(root, engine.dataNamespace)).list().length, 4);
    deleteResponse = 1;
    await win.webContents.executeJavaScript(`window.googleTool.deleteProfile(${JSON.stringify(deletion.id)})`);
    for (let i = 0; i < 100; i++) {
      if (new ProfileStore(path.join(root, engine.dataNamespace)).list().length === 3) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(new ProfileStore(path.join(root, engine.dataNamespace)).list().length, 3);
    const batchIds = new ProfileStore(path.join(root, engine.dataNamespace)).list().slice(0, 2).map(p => p.id);
    const promptsBeforeCancel = deletePromptCount;
    deleteResponse = 0;
    const batchCancel = await win.webContents.executeJavaScript(`window.googleTool.deleteProfiles(${JSON.stringify(batchIds)})`);
    assert.equal(batchCancel.cancelled, true);
    assert.equal(deletePromptCount, promptsBeforeCancel + 1, 'One confirmation for cancelling a batch');
    assert.equal(new ProfileStore(path.join(root, engine.dataNamespace)).list().length, 3);
    deleteResponse = 1;
    const promptsBeforeDelete = deletePromptCount;
    const batchDelete = await win.webContents.executeJavaScript(`window.googleTool.deleteProfiles(${JSON.stringify(batchIds)})`);
    assert.equal(deletePromptCount, promptsBeforeDelete + 1, 'One confirmation for deleting two profiles');
    assert.equal(batchDelete.results.filter(r => r.deleted).length, 2);
    assert.equal(new ProfileStore(path.join(root, engine.dataNamespace)).list().length, 1);
    const activeStore = new ProfileStore(path.join(root, engine.dataNamespace));
    const { PROFILE_DIRECTORY } = require('../profile-store');
    assert.ok(!fs.readdirSync(path.join(activeStore.root, PROFILE_DIRECTORY)).some(name => name.startsWith('.deleted-')));
    console.log(`UI_SMOKE_PASS: batch import, partial failure/retry, encrypted credentials, create, duplicate validation, search, minimal header, text escaping, persistent storage, template save/inheritance, cancel deletion, deletion IPC. Screenshots: ${output}`);
    clearTimeout(timeout);
    app.exit(0);
  } catch (error) {
    clearTimeout(timeout);
    console.error('UI_SMOKE_FAIL:', error);
    app.exit(1);
  }
});
