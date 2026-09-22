const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const trace = require('../trace-log');

test('deleting profile logs preserves other profiles and prevents late recreation', trace.traced('test.deleteLogs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'googletool-log-delete-'));
  const id = randomUUID(), other = randomUUID();
  trace.configure(root);
  try {
    trace.withProfile(other, trace.traced('test.otherProfile', () => {}));
    await trace.withProfile(id, trace.traced('test.deleteProfile', async () => {
      await trace.deleteProfileLogs(id, trace.traced('test.trash', async target => {
        assert.equal(target, path.join(root, 'profiles', id));
        fs.renameSync(target, path.join(root, 'trashed'));
      }));
    }));
    assert.equal(fs.existsSync(path.join(root, 'profiles', id)), false);
    assert.equal(fs.existsSync(path.join(root, 'profiles', other)), true);
    assert.equal(fs.existsSync(path.join(root, 'trashed')), true);
    assert.equal(fs.existsSync(path.join(root, 'app')), true);
    await assert.rejects(trace.deleteProfileLogs('../outside', trace.traced('test.invalidTrash', () => assert.fail())));
  } finally { trace.configure(undefined); }
}));
