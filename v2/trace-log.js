const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();

function validProfileId(value) {
  return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
}
function withProfile(profileId, fn) {
  if (!validProfileId(profileId)) throw new Error('Invalid trace profile ID');
  return context.run({ profileId: profileId.toLowerCase() }, fn);
}

// Logger primitives deliberately do not trace themselves (would recurse).
let logDirectory;
const retiredProfiles = new Set();
function configure(directory) {
  if (!directory) { logDirectory = undefined; return; }
  fs.mkdirSync(directory, { recursive: true });
  logDirectory = directory;
}
function write(record) {
  if (!logDirectory) return;
  try {
    const day = new Date().toISOString().slice(0, 10);
    const directory = record.profileId && !retiredProfiles.has(record.profileId) ? path.join(logDirectory, 'profiles', record.profileId) : path.join(logDirectory, 'app');
    fs.mkdirSync(directory, { recursive: true });
    const line = JSON.stringify({ timestamp: new Date().toISOString(), pid: process.pid, ...record });
    fs.appendFileSync(path.join(directory, `trace-${day}.jsonl`), line + '\n', { mode: 0o600 });
  } catch { console.error('[trace] Cannot write trace file'); }
}
function traceIn(name) {
  const span = { name, callId: randomUUID(), profileId: context.getStore()?.profileId, start: performance.now(), ended: false };
  write({ event: 'trace in', name, callId: span.callId, profileId: span.profileId });
  return span;
}
function traceOut(span, status = 'ok') {
  if (span.ended) return;
  span.ended = true;
  write({ event: 'trace out', name: span.name, callId: span.callId, profileId: span.profileId,
    durationMs: Math.round((performance.now() - span.start) * 1000) / 1000, status });
}
function traced(name, fn, options = {}) {
  return function (...args) {
    const execute = () => {
    const span = traceIn(name);
    try {
      const result = fn.apply(this, args);
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).then(value => { traceOut(span); return value; },
          error => { traceOut(span, 'error'); throw error; });
      }
      traceOut(span);
      return result;
    } catch (error) { traceOut(span, 'error'); throw error; }
    };
    const arg = args[options.profileArgument];
    const id = typeof arg === 'string' ? arg : arg?.id;
    if (options.profileArgument !== undefined && validProfileId(id)) return withProfile(id, execute);
    return execute();
  };
}
function recordUi(record) {
  if (!record || !/^renderer\.(render|updateSelection|runAction|fillFingerprint|windowSizeChange|saveFingerprint|threadLimit|cancelQueue|pool[A-Za-z]+)$/.test(record.name) ||
      !validProfileId(record.callId) || !['trace in', 'trace out'].includes(record.event)) return;
  const clean = { name: record.name, callId: record.callId, event: record.event };
  if (record.event === 'trace out') {
    clean.status = record.status === 'error' ? 'error' : 'ok';
    clean.durationMs = Number.isFinite(record.durationMs) ? Math.max(0, record.durationMs) : 0;
  }
  write(clean);
}
const deleteProfileLogs = traced('logs.deleteProfileLogs', async (id, trash) => {
  if (!validProfileId(id) || !logDirectory) throw new Error('Invalid profile log directory');
  id = id.toLowerCase();
  const parent = path.resolve(logDirectory, 'profiles');
  const target = path.resolve(parent, id);
  if (path.dirname(target) !== parent) throw new Error('Invalid profile log path');
  if (fs.existsSync(target)) {
    for (const directory of [logDirectory, parent, target]) {
      if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Cannot delete linked log directory');
    }
  }
  // Late trace-out/events belong to the app audit log; never recreate deleted profile logs.
  retiredProfiles.add(id);
  try { if (fs.existsSync(target)) await trash(target); }
  catch (error) { retiredProfiles.delete(id); throw error; }
}, { profileArgument: 0 });
module.exports = { configure, traceIn, traceOut, traced, withProfile, recordUi, deleteProfileLogs };
