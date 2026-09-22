// The shipped engines ignore the screen-size flags in runtime testing.
const RESOLUTIONS = ['native'];
const { traced } = require('./trace-log');
const WINDOW_SIZES = ['1280x720', '1366x768', '1440x900', '1600x900', '1920x1080'];
const defaults = traced('fingerprint.defaults', () => {
  const local = Intl.DateTimeFormat().resolvedOptions();
  return { platform: 'windows', locale: local.locale, timezone: local.timeZone,
    resolution: 'native', windowSize: '1280x720', hardwareConcurrency: 8, gpu: 'auto', canvas: 'noise',
    audio: 'noise', clientrects: 'noise', font: 'noise', proxyUrl: '', proxyUsername: '', proxyPassword: '', webrtc: 'default' };
});
const normalize = traced('fingerprint.normalize', (input = {}) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Cấu hình fingerprint không hợp lệ.');
  const result = defaults();
  for (const key of Object.keys(result)) if (Object.hasOwn(input, key)) result[key] = input[key];
  const size = typeof result.windowSize === 'string' && /^(\d{3,4})x(\d{3,4})$/.exec(result.windowSize);
  if (!size || Number(size[1]) < 400 || Number(size[1]) > 7680 || Number(size[2]) < 300 || Number(size[2]) > 4320) throw new Error('Kích thước cửa sổ: rộng 400–7680 px, cao 300–4320 px.');
  result.windowSize = `${Number(size[1])}x${Number(size[2])}`;
  for (const [key, values] of Object.entries({ platform: ['windows', 'macos', 'linux'], resolution: RESOLUTIONS,
    gpu: ['auto', 'real'], canvas: ['noise', 'off'], audio: ['noise', 'off'],
    clientrects: ['noise', 'off'], font: ['noise', 'off'], webrtc: ['default', 'restrict'] })) {
    if (!values.includes(result[key])) throw new Error(`Giá trị ${key} không hợp lệ.`);
  }
  if (!Number.isInteger(result.hardwareConcurrency) || result.hardwareConcurrency < 1 || result.hardwareConcurrency > 128) throw new Error('Số luồng CPU phải từ 1 đến 128.');
  try {
    if (typeof result.locale !== 'string' || typeof result.timezone !== 'string') throw new Error();
    new Intl.DateTimeFormat(result.locale, { timeZone: result.timezone });
    if (!/^[A-Za-z0-9-]+$/.test(result.locale)) throw new Error();
  } catch { throw new Error('Ngôn ngữ hoặc múi giờ không hợp lệ.'); }
  if (typeof result.proxyUrl !== 'string') throw new Error('Proxy không hợp lệ.');
  result.proxyUrl = result.proxyUrl.trim();
  for (const key of ['proxyUsername', 'proxyPassword']) {
    if (typeof result[key] !== 'string' || result[key].length > 1024) throw new Error('User/password proxy không hợp lệ.');
  }
  if ((result.proxyUsername || result.proxyPassword) && !result.proxyUrl) throw new Error('Nhập địa chỉ proxy trước khi nhập user/password.');
  if (result.proxyUrl) {
    if (/^(\[[^\]]+\]|[a-z0-9.-]+):\d+$/i.test(result.proxyUrl)) result.proxyUrl = `http://${result.proxyUrl}`;
    let url;
    try { url = new URL(result.proxyUrl); } catch { throw new Error('Proxy cần có dạng http://host:port hoặc socks5://host:port.'); }
    if (!['http:', 'socks4:', 'socks5:'].includes(url.protocol) || !url.hostname || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Proxy hỗ trợ http://host:port, socks4://host:port hoặc socks5://host:port; không thêm đường dẫn hay query.');
    if (url.username || url.password) {
      let username, password;
      try { username = decodeURIComponent(url.username); password = decodeURIComponent(url.password); }
      catch { throw new Error('Thông tin xác thực trong URL proxy không hợp lệ.'); }
      if ((result.proxyUsername && result.proxyUsername !== username) || (result.proxyPassword && result.proxyPassword !== password)) throw new Error('User/password trong URL khác với hai ô xác thực. Chỉ nhập theo một cách.');
      if (username.length > 1024 || password.length > 1024) throw new Error('User/password proxy quá dài.');
      result.proxyUsername = username;
      result.proxyPassword = password;
    }
    if (result.proxyUsername && url.protocol === 'socks4:') throw new Error('Proxy có user/password hỗ trợ HTTP hoặc SOCKS5.');
    result.proxyUrl = `${url.protocol}//${url.host}`;
  }
  if (result.proxyPassword && !result.proxyUsername) throw new Error('Nhập username của proxy.');
  return result;
});
function template(input = {}) {
  const config = normalize(input);
  for (const [key, max] of [['name', 80], ['notes', 1000]]) {
    const value = input[key] ?? '';
    if (typeof value !== 'string' || value.length > max) throw new Error(`${key} không hợp lệ.`);
    config[key] = value.trim();
  }
  return config;
}
module.exports = { defaults, normalize, template, RESOLUTIONS, WINDOW_SIZES };
