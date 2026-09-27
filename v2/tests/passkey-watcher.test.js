const test = require('node:test');
const assert = require('node:assert/strict');
const { traced: t } = require('../trace-log');
const { isChallengeUrl, CLICK_CONTINUE_JS } = require('../passkey-watcher');

test('isChallengeUrl accurately detects all passkey challenge variations', t('test.isChallengeUrl', () => {
  const presendUrl = 'https://accounts.google.com/v3/signin/challenge/pk/presend?TL=ADG-GRQE7wGqJBwPxTQeUToIXUXIGWQ9UU34tyyzAGeJJ3QhaHDjYe1r8-5Ee4ji&authuser=0&cid=1';
  assert.equal(isChallengeUrl(presendUrl), true);
  assert.equal(isChallengeUrl('https://accounts.google.com/v3/signin/challenge/pk'), true);
  assert.equal(isChallengeUrl('https://accounts.google.com/signin/v2/challenge/pk'), true);
  assert.equal(isChallengeUrl('https://accounts.google.com/signin/challenge/pk/presend'), true);
  assert.equal(isChallengeUrl('https://mail.google.com/mail/u/0/#inbox'), false);
  assert.equal(isChallengeUrl('https://accounts.google.com/v3/signin/challenge/pwd'), false);
  assert.equal(isChallengeUrl(''), false);
  assert.equal(isChallengeUrl(null), false);
}));

test('CLICK_CONTINUE_JS contains required selectors and multi-language labels', t('test.clickContinueJs', () => {
  assert.ok(CLICK_CONTINUE_JS.includes('#passkeyNext'));
  assert.ok(CLICK_CONTINUE_JS.includes('#next'));
  assert.ok(CLICK_CONTINUE_JS.includes('continue'));
  assert.ok(CLICK_CONTINUE_JS.includes('tiếp tục'));
  assert.ok(CLICK_CONTINUE_JS.includes('ok'));
  assert.ok(CLICK_CONTINUE_JS.includes('MouseEvent'));
}));

test('startPasskeyWatcher opens fresh tab with passkey when challenge detected', t('test.watcherNewTabWithPasskey', async () => {
  const { startPasskeyWatcher } = require('../passkey-watcher');
  const http = require('node:http');

  let newTabCalled = false;
  let closeOldTabCalled = false;
  let jsonCalls = 0;

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/json/close/tab-1')) {
      closeOldTabCalled = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url.startsWith('/json/new')) {
      newTabCalled = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'new-tab', webSocketDebuggerUrl: 'ws://127.0.0.1/ws' }));
      return;
    }
    if (req.url === '/json') {
      jsonCalls++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([
        { id: 'tab-1', type: 'page', url: 'https://accounts.google.com/v3/signin/challenge/pk', webSocketDebuggerUrl: 'ws://127.0.0.1:9999/dummy' }
      ]));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const EventEmitter = require('node:events');
  const fakeChild = new EventEmitter();
  fakeChild.killed = false;
  fakeChild.exitCode = null;

  const validBlob = Buffer.from(JSON.stringify({ credentialId: 'c1' })).toString('base64');
  startPasskeyWatcher(fakeChild, port, validBlob, 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d');

  // Chờ watcher chạy polling ít nhất 2 vòng
  await new Promise(r => setTimeout(r, 2200));

  fakeChild.emit('exit');
  server.close();

  assert.ok(jsonCalls >= 2, 'Watcher phải poll ít nhất 2 lần');
  assert.equal(closeOldTabCalled, true, 'Watcher phải đóng tab cũ bị vướng');
  assert.equal(newTabCalled, true, 'Watcher phải mở tab mới sạch (/json/new) để gắn CDP Virtual Authenticator');
}));

