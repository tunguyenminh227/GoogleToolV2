const test = require('node:test');
const assert = require('node:assert/strict');
const { OpenQueue } = require('../open-queue');
const { traced: t } = require('../trace-log');

test('login jobs share the open limit and wait for both flow completion and browser closure', t('test.loginQueue', async () => {
  const active = new Set(), started = [], finish = new Map();
  const queue = new OpenQueue({ activeIds: t('test.loginActive', () => [...active]),
    changed: t('test.loginChanged', () => {}), open: t('test.wrongRunner', () => assert.fail('Wrong runner')) });
  const login = t('test.loginRunner', async id => {
    started.push(id); active.add(id);
    await new Promise(t('test.loginPending', resolve => finish.set(id, resolve)));
  });
  queue.enqueue(['a', 'b', 'c', 'd', 'e'], 4, login);
  assert.deepEqual(started, ['a', 'b', 'c', 'd']);
  active.delete('a'); queue.pump();
  assert.equal(started.length, 4);
  finish.get('a')();
  await new Promise(t('test.loginTick', resolve => setImmediate(resolve)));
  assert.deepEqual(started, ['a', 'b', 'c', 'd', 'e']);
  for (const resolve of finish.values()) resolve();
}));
test('queue holds slots until browsers close, deduplicates and cancels pending only', t('test.queue', async () => {
  const active = new Set(); const started = [];
  const queue = new OpenQueue({ activeIds: t('test.active', () => [...active]), changed: t('test.changed', () => {}),
    open: t('test.open', async id => { started.push(id); active.add(id); }) });
  queue.enqueue(['a', 'b', 'c', 'd', 'a'], 2);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['a', 'b']);
  assert.deepEqual(queue.snapshot().pending, ['c', 'd']);
  assert.equal(queue.enqueue(['a', 'b', 'c'], 2).added, 0);
  active.delete('a'); queue.pump();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['a', 'b', 'c']);
  queue.cancel(); active.delete('b'); queue.pump();
  assert.deepEqual(started, ['a', 'b', 'c']);
  assert.ok(active.has('c'));
  assert.throws(() => queue.enqueue(['e'], 0));
}));
test('pending launches reserve slots and a failure allows the next profile', t('test.queueFailure', async () => {
  let rejectFirst;
  const active = new Set(); const started = [];
  const queue = new OpenQueue({ activeIds: t('test.active', () => [...active]), changed: t('test.changed', () => {}),
    open: t('test.open', async id => {
      started.push(id);
      if (id === 'bad') await new Promise((resolve, reject) => { rejectFirst = reject; });
      else active.add(id);
    }) });
  queue.enqueue(['bad', 'good'], 1); queue.pump();
  assert.deepEqual(started, ['bad']);
  rejectFirst(new Error('Fixture failure'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['bad', 'good']);
  assert.equal(queue.snapshot().errors.length, 1);
}));
