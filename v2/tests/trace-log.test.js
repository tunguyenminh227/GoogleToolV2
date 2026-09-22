const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const trace = require('../trace-log');

test('trace pairs sync/async calls, including errors, without logging arguments', trace.traced('test.trace', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'googletool-trace-'));
  try {
    trace.configure(directory);
    const sync = trace.traced('sync', value => value);
    assert.equal(sync('private-test-secret'), 'private-test-secret');
    assert.throws(() => trace.traced('sync-error', () => { throw new Error('private-test-secret'); })());
    assert.equal(await trace.traced('async', async () => 42)(), 42);
    await assert.rejects(trace.traced('async-error', async () => { throw new Error('private-test-secret'); })());
    const appDirectory = path.join(directory, 'app');
    const text = fs.readFileSync(path.join(appDirectory, fs.readdirSync(appDirectory)[0]), 'utf8');
    assert.ok(!text.includes('private-test-secret'));
    const entries = text.trim().split('\n').map(JSON.parse);
    assert.equal(entries.length, 8);
    for (let i = 0; i < entries.length; i += 2) {
      assert.equal(entries[i].event, 'trace in');
      assert.equal(entries[i + 1].event, 'trace out');
      assert.equal(entries[i].callId, entries[i + 1].callId);
      assert.equal(entries[i + 1].status, entries[i].name.endsWith('error') ? 'error' : 'ok');
      assert.ok(entries[i + 1].durationMs >= 0);
    }
    const ids = ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'];
    const child = trace.traced('child', async () => { await Promise.resolve(); });
    const task = trace.traced('profile-task', async () => { await Promise.resolve(); await child(); }, { profileArgument: 0 });
    await Promise.all([task(ids[0]), task({ id: ids[1] })]);
    for (const id of ids) {
      const folder = path.join(directory, 'profiles', id);
      const rows = fs.readFileSync(path.join(folder, fs.readdirSync(folder)[0]), 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(rows.length, 4);
      assert.ok(rows.every(row => row.profileId === id));
      assert.equal(rows.filter(row => row.event === 'trace out').length, 2);
    }
    assert.equal(fs.readFileSync(path.join(appDirectory, fs.readdirSync(appDirectory)[0]), 'utf8'), text);
    assert.throws(() => trace.withProfile('../outside', child));
  } finally { trace.configure(null); fs.rmSync(directory, { recursive: true, force: true }); }
}));
