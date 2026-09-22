const { traced: t } = require('./trace-log');
class OpenQueue {
  constructor({ activeIds, open, changed }) {
    this.activeIds = activeIds; this.open = open; this.changed = changed;
    this.pending = []; this.inFlight = new Set(); this.limit = 1; this.errors = []; this.pumping = false;
    this.runners = new Map();
  }
  snapshot = t('queue.snapshot', () => ({ pending: [...this.pending], opening: [...this.inFlight], limit: this.limit, errors: [...this.errors] }));
  setLimit = t('queue.setLimit', limit => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Số luồng phải từ 1 đến 50.');
    this.limit = limit; this.pump(); this.changed();
  });
  enqueue = t('queue.enqueue', (ids, limit, runner = this.open) => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Số luồng phải từ 1 đến 50.');
    this.limit = limit; this.errors = [];
    const known = new Set([...this.activeIds(), ...this.inFlight, ...this.pending]);
    let added = 0;
    for (const id of ids) if (!known.has(id)) { this.pending.push(id); this.runners.set(id, runner); known.add(id); added++; }
    this.pump(); this.changed(); return { added };
  });
  cancel = t('queue.cancel', () => { for (const id of this.pending) this.runners.delete(id); this.pending = []; this.changed(); });
  pump = t('queue.pump', () => {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.pending.length && new Set([...this.activeIds(), ...this.inFlight]).size < this.limit) {
        const id = this.pending.shift();
        if (this.activeIds().includes(id)) { this.runners.delete(id); continue; }
        this.inFlight.add(id);
        this.start(id);
      }
    } finally { this.pumping = false; }
  });
  start = t('queue.start', async id => {
    const runner = this.runners.get(id) || this.open;
    this.runners.delete(id);
    try { await runner(id); }
    catch (error) { this.errors.push({ id, message: error.message }); }
    finally { this.inFlight.delete(id); this.pump(); this.changed(); }
  }, { profileArgument: 0 });
}
module.exports = { OpenQueue };
