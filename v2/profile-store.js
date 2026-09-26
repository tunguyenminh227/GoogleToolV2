const secretConfig = require('./secret-config');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createFingerprint, validateFingerprint } = require('./fingerprint');
const engine = require('./engine-config');
const { normalize } = require('./fingerprint-config');
const trace = require('./trace-log');
const PROFILE_DIRECTORY = engine.profileDirectory;
const cloneProfile = profile => ({ ...profile, fingerprint: { ...profile.fingerprint } });

const COLORS = ['blue', 'violet', 'green', 'orange', 'rose'];

function cleanText(value, label, max, required = false) {
  if (value != null && typeof value !== 'string') throw new Error(`${label} không hợp lệ.`);
  const text = (value || '').trim();
  if (required && !text) throw new Error(`Vui lòng nhập ${label.toLowerCase()}.`);
  if (text.length > max) throw new Error(`${label} tối đa ${max} ký tự.`);
  return text;
}

class ProfileStore {
  constructor(root) {
    this.root = root;
    this.file = path.join(root, 'profiles.json');
    fs.mkdirSync(root, { recursive: true });
    this.profiles = [];
    if (fs.existsSync(this.file)) {
      const data = secretConfig.parse(fs.readFileSync(this.file, 'utf8'));
      if (![1, 2].includes(data.version) || !Array.isArray(data.profiles)) throw new Error('Kho profile không hợp lệ. Hãy kiểm tra profiles.json trong thư mục dữ liệu v2.');
      const ids = new Set();
      const seeds = new Set();
      for (const p of data.profiles) {
        if (!p || typeof p.id !== 'string' || !/^[a-f0-9-]{36}$/.test(p.id) || ids.has(p.id) || typeof p.name !== 'string' || !COLORS.includes(p.color)) {
          throw new Error('Dữ liệu profile bị lỗi. Không thể mở kho profile.');
        }
        ids.add(p.id);
        if (data.version === 1) p.fingerprint = createFingerprint('auto', seeds);
        validateFingerprint(p.fingerprint);
        if (seeds.has(p.fingerprint.seed)) throw new Error('Kho profile chứa fingerprint seed bị trùng.');
        seeds.add(p.fingerprint.seed);
      }
      this.profiles = data.profiles;
      if (data.version === 1) {
        const backup = `${this.file}.before-adryfish${engine.major}`;
        if (!fs.existsSync(backup)) fs.copyFileSync(this.file, backup, fs.constants.COPYFILE_EXCL);
        this.save(this.profiles);
      }
    }
  }

  list() { return this.profiles.map(cloneProfile); }

  get(id) {
    const profile = this.profiles.find(p => p.id === id);
    if (!profile) throw new Error('Không tìm thấy profile.');
    return cloneProfile(profile);
  }

  directory(id) {
    this.get(id);
    return path.join(this.root, PROFILE_DIRECTORY, id);
  }

  save(profiles) {
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, secretConfig.stringify({ version: 2, profiles }), { mode: 0o600 });
    fs.renameSync(temp, this.file);
    this.profiles = profiles;
  }

  create = trace.traced('store.create', input => {
    if (!input || typeof input !== 'object') throw new Error('Thông tin profile không hợp lệ.');
    const name = cleanText(input.name, 'Tên profile', input.name === input.email ? 254 : 80, true);
    const email = cleanText(input.email, 'Email', 254);
    const notes = cleanText(input.notes, 'Ghi chú', 1000);
    const color = input.color || 'blue';
    if (!COLORS.includes(color)) throw new Error('Màu profile không hợp lệ.');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Địa chỉ email không hợp lệ.');
    if (this.profiles.some(p => p.name.toLocaleLowerCase('vi') === name.toLocaleLowerCase('vi'))) {
      throw new Error('Tên profile đã tồn tại. Vui lòng chọn tên khác.');
    }
    const config = normalize(input.fingerprint || { gpu: input.gpu || 'auto' });
    const fingerprint = { ...createFingerprint(config.gpu, new Set(this.profiles.map(p => p.fingerprint.seed))), ...config };
    const profile = { id: randomUUID(), name, email, notes, color, fingerprint, createdAt: new Date().toISOString(), lastOpenedAt: null };
    const dir = path.join(this.root, PROFILE_DIRECTORY, profile.id);
    fs.mkdirSync(dir, { recursive: true });
    const accountFile = path.join(dir, '.googletool-account');
    const defaultDirectory = path.join(dir, 'Default');
    const preferencesFile = path.join(defaultDirectory, 'Preferences');
    const securePreferencesFile = path.join(defaultDirectory, 'Secure Preferences');
    try {
      fs.mkdirSync(defaultDirectory);
      fs.writeFileSync(preferencesFile, JSON.stringify({ session: { restore_on_startup: 1 } }), { flag: 'wx', mode: 0o600 });
      fs.writeFileSync(securePreferencesFile, JSON.stringify({ session: { restore_on_startup: 1 } }), { flag: 'wx', mode: 0o600 });
      if (input.encryptedAccount) {
        if (typeof input.encryptedAccount !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(input.encryptedAccount)) throw new Error('Dữ liệu tài khoản mã hóa không hợp lệ.');
        fs.writeFileSync(accountFile, input.encryptedAccount, { flag: 'wx', mode: 0o600 });
      }
      this.save([...this.profiles, profile]);
    } catch (error) {
      if (fs.existsSync(accountFile)) fs.unlinkSync(accountFile);
      if (fs.existsSync(preferencesFile)) fs.unlinkSync(preferencesFile);
      if (fs.existsSync(securePreferencesFile)) fs.unlinkSync(securePreferencesFile);
      if (fs.existsSync(defaultDirectory)) fs.rmdirSync(defaultDirectory);
      fs.rmdirSync(dir);
      throw error;
    }
    return cloneProfile(profile);
  });

  markOpened(id) {
    this.get(id);
    this.save(this.profiles.map(p => p.id === id ? { ...p, lastOpenedAt: new Date().toISOString() } : p));
  }

  setMailStatus = trace.traced('store.setMailStatus', (id, mailStatus, mailError = null) => {
    this.get(id);
    const allowed = ['starting', 'email', 'password', 'password_reached', 'recovery', 'totp', 'selection', 'inbox', 'success', 'manual', 'error', 'recaptcha', 'skotp', 'verify_phone', 'rejected', 'passkey_enabled'];
    if (!allowed.includes(mailStatus)) throw new Error('Trạng thái Gmail không hợp lệ.');
    const errorString = typeof mailError === 'string' && mailError.trim()
      ? mailError.trim().slice(0, 500)
      : (mailError instanceof Error ? (mailError.message || '').trim().slice(0, 500) : null);
    this.save(this.profiles.map(trace.traced('store.mailStatusRow', p => {
      if (p.id !== id) return p;
      let nextError = null;
      if (errorString) {
        nextError = errorString;
      } else if (mailStatus === 'rejected') {
        nextError = 'Google đã từ chối đăng nhập (signin/rejected)';
      } else if (mailStatus === 'verify_phone') {
        nextError = 'Google yêu cầu xác minh số điện thoại (verify phone)';
      } else if (['error', 'manual'].includes(mailStatus)) {
        nextError = p.mailError || (mailStatus === 'manual' ? 'Cần thao tác thủ công' : 'Lỗi đăng nhập');
      }
      return { ...p, mailStatus, mailError: nextError, updatedAt: new Date().toISOString() };
    })));
  }, { profileArgument: 0 });

  updateNotes(id, input) {
    const current = this.get(id);
    const notes = cleanText(input.notes === undefined ? current.notes : input.notes, 'Note', 1000);
    const notes2 = cleanText(input.notes2 === undefined ? current.notes2 : input.notes2, 'Note 2', 1000);
    this.save(this.profiles.map(p => p.id === id ? { ...p, notes, notes2, updatedAt: new Date().toISOString() } : p));
    return this.get(id);
  }

  updateFingerprint(id, input) {
    const current = this.get(id);
    const config = normalize(input);
    const seed = input.seed ?? current.fingerprint.seed;
    const fingerprint = { ...current.fingerprint, ...config, seed };
    validateFingerprint(fingerprint);
    if (this.profiles.some(p => p.id !== id && p.fingerprint.seed === seed)) throw new Error('Seed đang được profile khác sử dụng.');
    this.save(this.profiles.map(p => p.id === id ? { ...p, fingerprint } : p));
    return this.get(id);
  }

  remove(id) {
    this.get(id);
    const parent = path.resolve(this.root, PROFILE_DIRECTORY);
    const dir = path.resolve(this.directory(id));
    if (path.dirname(dir) !== parent) throw new Error('Đường dẫn profile không hợp lệ.');
    const staged = path.join(parent, `.deleted-${id}-${randomUUID()}`);
    const exists = fs.existsSync(dir);
    if (exists) {
      if (fs.lstatSync(parent).isSymbolicLink() || fs.lstatSync(dir).isSymbolicLink()) {
        throw new Error('Không xóa profile qua đường dẫn liên kết.');
      }
      fs.renameSync(dir, staged);
    }
    try { this.save(this.profiles.filter(p => p.id !== id)); }
    catch (error) {
      if (exists) fs.renameSync(staged, dir);
      throw error;
    }
    return exists ? staged : null;
  }
}

module.exports = { ProfileStore, COLORS, PROFILE_DIRECTORY };
