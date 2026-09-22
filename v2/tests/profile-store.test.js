const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProfileStore, PROFILE_DIRECTORY } = require('../profile-store');
const trace = require('../trace-log');

test('new profiles resume the previous session without changing existing preferences', trace.traced('test.startupPreference', t => {
  const store = setup(t);
  const first = store.create({ name: 'Startup default' });
  const file = path.join(store.directory(first.id), 'Default', 'Preferences');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).session.restore_on_startup, 1);
  fs.writeFileSync(file, JSON.stringify({ session: { restore_on_startup: 5 }, existing: true }));
  const reloaded = new ProfileStore(store.root);
  reloaded.create({ name: 'Second profile' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { session: { restore_on_startup: 5 }, existing: true });
}));

test('notes update independently and survive reload without changing fingerprint', t => {
  const store = setup(t);
  const p = store.create({ name: 'Notes', notes: 'Original' });
  store.updateNotes(p.id, { notes2: 'Second' });
  store.updateNotes(p.id, { notes: 'Updated' });
  const saved = new ProfileStore(store.root).get(p.id);
  assert.equal(saved.notes, 'Updated');
  assert.equal(saved.notes2, 'Second');
  assert.deepEqual(saved.fingerprint, p.fingerprint);
  assert.ok(saved.updatedAt);
  assert.throws(() => store.updateNotes(p.id, { notes: 'x'.repeat(1001) }));
  assert.equal(store.get(p.id).notes, 'Updated');
});

test('delete removes only the selected profile and stages its browser data', t => {
  const store = setup(t);
  const a = store.create({ name: 'Delete me' });
  const b = store.create({ name: 'Keep me' });
  const dir = store.directory(a.id);
  fs.writeFileSync(path.join(dir, 'cookie-fixture'), 'test');
  const staged = store.remove(a.id);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(fs.readFileSync(path.join(staged, 'cookie-fixture'), 'utf8'), 'test');
  assert.deepEqual(new ProfileStore(store.root).list().map(p => p.id), [b.id]);
  assert.ok(fs.existsSync(store.directory(b.id)));
  assert.throws(() => store.remove('../outside'));
  assert.throws(() => store.remove(a.id));
});

test('delete restores the directory if metadata persistence fails', t => {
  const store = setup(t);
  const p = store.create({ name: 'Keep on error' });
  const dir = store.directory(p.id);
  fs.writeFileSync(path.join(dir, 'fixture'), 'preserved');
  store.save = () => { throw new Error('disk failure'); };
  assert.throws(() => store.remove(p.id), /disk failure/);
  assert.equal(fs.readFileSync(path.join(dir, 'fixture'), 'utf8'), 'preserved');
  assert.equal(new ProfileStore(store.root).get(p.id).name, p.name);
});

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'googletool-v2-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new ProfileStore(root);
}

test('editing fingerprint preserves identity and browser data, persists and rejects duplicate seeds', t => {
  const store = setup(t);
  const a = store.create({ name: 'A', fingerprint: { audio: 'off', locale: 'vi-VN' } });
  const b = store.create({ name: 'B' });
  const dir = store.directory(a.id);
  fs.writeFileSync(path.join(dir, 'cookie-fixture'), 'keep');
  const edited = store.updateFingerprint(a.id, { ...a.fingerprint, hardwareConcurrency: 4, gpu: 'real' });
  assert.equal(edited.fingerprint.seed, a.fingerprint.seed);
  assert.equal(edited.fingerprint.audio, 'off');
  assert.equal(new ProfileStore(store.root).get(a.id).fingerprint.hardwareConcurrency, 4);
  assert.equal(fs.readFileSync(path.join(dir, 'cookie-fixture'), 'utf8'), 'keep');
  assert.throws(() => store.updateFingerprint(a.id, { ...edited.fingerprint, seed: b.fingerprint.seed }));
  assert.deepEqual(store.get(a.id), edited);
  store.save = () => { throw new Error('disk failure'); };
  assert.throws(() => store.updateFingerprint(a.id, { ...edited.fingerprint, canvas: 'off' }));
  assert.deepEqual(store.get(a.id), edited);
});

test('encrypted account payload is stored outside metadata and rolled back on save failure', t => {
  const store = setup(t);
  const cipher = Buffer.from('encrypted-test-placeholder').toString('base64');
  const p = store.create({ name: 'a@example.com', encryptedAccount: cipher });
  assert.equal(fs.readFileSync(path.join(store.directory(p.id), '.googletool-account'), 'utf8'), cipher);
  assert.equal(store.get(p.id).encryptedAccount, undefined);
  assert.ok(!fs.readFileSync(store.file, 'utf8').includes(cipher));
  store.save = () => { throw new Error('disk error'); };
  assert.throws(() => store.create({ name: 'b@example.com', encryptedAccount: cipher }));
  assert.deepEqual(fs.readdirSync(path.join(store.root, PROFILE_DIRECTORY)), [p.id]);
});

test('creates independent directories and persists profile metadata across restart', t => {
  const store = setup(t);
  const first = store.create({ name: ' Công việc ', email: 'work@gmail.com', color: 'violet', notes: 'Gmail chính' });
  const second = store.create({ name: 'Cá nhân' });
  assert.equal(first.name, 'Công việc');
  assert.notEqual(store.directory(first.id), store.directory(second.id));
  assert.ok(fs.statSync(store.directory(first.id)).isDirectory());
  assert.deepEqual(new ProfileStore(store.root).list(), [first, second]);
  store.markOpened(first.id);
  assert.ok(new ProfileStore(store.root).get(first.id).lastOpenedAt);
  assert.equal(store.get(second.id).lastOpenedAt, null);
});

test('rejects invalid fields and duplicate names without creating extra profiles', t => {
  const store = setup(t);
  store.create({ name: 'Work' });
  for (const input of [null, { name: ' ' }, { name: 'work' }, { name: 'A', email: 'invalid' }, { name: 'A', color: '../bad' }, { name: 'x'.repeat(81) }, { name: 'A', notes: {} }]) {
    assert.throws(() => store.create(input));
  }
  assert.equal(store.list().length, 1);
  assert.equal(fs.readdirSync(path.join(store.root, PROFILE_DIRECTORY)).length, 1);
});

test('profile names never become filesystem paths and unknown ids cannot escape storage', t => {
  const store = setup(t);
  const p = store.create({ name: '../../outside' });
  assert.equal(path.dirname(store.directory(p.id)), path.join(store.root, PROFILE_DIRECTORY));
  assert.throws(() => store.directory('../../outside'));
  assert.throws(() => store.markOpened('missing'));
});

test('does not overwrite corrupt storage', t => {
  const store = setup(t);
  fs.writeFileSync(store.file, '{broken');
  assert.throws(() => new ProfileStore(store.root));
  assert.equal(fs.readFileSync(store.file, 'utf8'), '{broken');
});

test('failed persistence leaves neither phantom metadata nor orphan profile directory', t => {
  const store = setup(t);
  store.save = () => { throw new Error('Disk unavailable'); };
  assert.throws(() => store.create({ name: 'New' }), /Disk unavailable/);
  assert.equal(store.list().length, 0);
  assert.deepEqual(fs.readdirSync(path.join(store.root, PROFILE_DIRECTORY)), []);
});

test('fingerprints are separate, persisted and cannot be mutated through list/get', t => {
  const store = setup(t);
  const a = store.create({ name: 'A', gpu: 'auto' });
  const b = store.create({ name: 'B', gpu: 'auto' });
  assert.notEqual(a.fingerprint.seed, b.fingerprint.seed);
  assert.equal(a.fingerprint.engine, require('../engine-config').id);
  assert.equal(a.fingerprint.gpu, 'auto');
  store.list()[0].fingerprint.seed = 1;
  store.get(a.id).fingerprint.gpu = 'amd-580';
  assert.deepEqual(new ProfileStore(store.root).get(a.id).fingerprint, a.fingerprint);
  assert.deepEqual(store.get(a.id).fingerprint, a.fingerprint);
  assert.throws(() => store.create({ name: 'C', gpu: 'unknown' }));
});

test('legacy profiles migrate once with a backup and separate Chromium browser directories', t => {
  const store = setup(t);
  const legacy = { id: 'a511684e-050e-4fd5-86de-8c47858f610f', name: 'Existing', email: '', notes: '', color: 'blue', createdAt: new Date().toISOString(), lastOpenedAt: null };
  const oldData = JSON.stringify({ version: 1, profiles: [legacy] });
  fs.writeFileSync(store.file, oldData);
  const oldDirectory = path.join(store.root, 'profiles', legacy.id);
  fs.mkdirSync(oldDirectory, { recursive: true });
  fs.writeFileSync(path.join(oldDirectory, 'cookie-fixture'), 'keep existing data');
  const migrated = new ProfileStore(store.root);
  const profile = migrated.get(legacy.id);
  assert.equal(profile.name, legacy.name);
  assert.ok(profile.fingerprint.seed);
  assert.equal(fs.readFileSync(`${store.file}.before-adryfish${require('../engine-config').major}`, 'utf8'), oldData);
  assert.notEqual(migrated.directory(legacy.id), oldDirectory);
  assert.equal(fs.readFileSync(path.join(oldDirectory, 'cookie-fixture'), 'utf8'), 'keep existing data');
  assert.deepEqual(new ProfileStore(store.root).get(legacy.id).fingerprint, profile.fingerprint);
});

