const { traced: t } = require('./trace-log');
const stringify = t('config.stringify', value => JSON.stringify(value, t('config.encryptProxyPassword', (key, item) => {
  if (key !== 'proxyPassword' || !item) return item;
  const { safeStorage } = require('electron');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Không thể mã hóa mật khẩu proxy trên máy này.');
  return { encryptedProxyPassword: safeStorage.encryptString(item).toString('base64') };
}), 2));
const parse = t('config.parse', value => JSON.parse(value, t('config.decryptProxyPassword', (key, item) => {
  if (key !== 'proxyPassword' || !item || typeof item !== 'object') return item;
  try { return require('electron').safeStorage.decryptString(Buffer.from(item.encryptedProxyPassword, 'base64')); }
  catch { throw new Error('Không giải mã được mật khẩu proxy trên máy này.'); }
})));
module.exports = { stringify, parse };
