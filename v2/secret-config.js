const { traced: t } = require('./trace-log');
const SENSITIVE_KEYS = new Set(['proxyPassword', 'clientSecret', 'developerToken', 'refreshToken']);

const stringify = t('config.stringify', value => JSON.stringify(value, t('config.encryptSecrets', (key, item) => {
  if (!SENSITIVE_KEYS.has(key) || !item || typeof item !== 'string') return item;
  const { safeStorage } = require('electron');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Không thể mã hóa thông tin bảo mật trên máy này.');
  if (key === 'proxyPassword') {
    return { encryptedProxyPassword: safeStorage.encryptString(item).toString('base64') };
  }
  return { encryptedSecret: safeStorage.encryptString(item).toString('base64') };
}), 2));

const parse = t('config.parse', value => JSON.parse(value, t('config.decryptSecrets', (key, item) => {
  if (!SENSITIVE_KEYS.has(key) || !item || typeof item !== 'object') return item;
  try {
    const { safeStorage } = require('electron');
    if (key === 'proxyPassword' && item.encryptedProxyPassword) {
      return safeStorage.decryptString(Buffer.from(item.encryptedProxyPassword, 'base64'));
    }
    if (item.encryptedSecret) {
      return safeStorage.decryptString(Buffer.from(item.encryptedSecret, 'base64'));
    }
    return item;
  } catch {
    throw new Error('Không giải mã được thông tin bảo mật trên máy này.');
  }
})));

module.exports = { stringify, parse };
