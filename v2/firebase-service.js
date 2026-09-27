const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const trace = require('./trace-log');
const gcpServers = require('./gcp-servers');

const SA_FILE = path.join(__dirname, '..', 'omini-305df-firebase-adminsdk-fbsvc-01607c9876.json');
const DATABASE_URL = 'https://omini-305df-default-rtdb.asia-southeast1.firebasedatabase.app';

let cachedToken = null;
let tokenExpiresAt = 0;

function loadServiceAccount() {
  if (!fs.existsSync(SA_FILE)) {
    throw new Error('Không tìm thấy tệp Service Account Firebase.');
  }
  const content = fs.readFileSync(SA_FILE, 'utf8');
  return JSON.parse(content);
}

function createServiceAccountJwt(sa) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/firebase.database',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url');
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(header + '.' + payload);
  const signature = signer.sign(sa.private_key, 'base64url');
  return header + '.' + payload + '.' + signature;
}

const getAccessToken = trace.traced('firebase.getAccessToken', async () => {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }
  const sa = loadServiceAccount();
  const jwt = createServiceAccountJwt(sa);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    throw new Error(`Xác thực Firebase thất bại (${res.status}).`);
  }
  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Không nhận được access_token từ Google OAuth2.');
  }
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + Math.max(60, (data.expires_in || 3600) - 120) * 1000;
  return cachedToken;
});

const readNode = trace.traced('firebase.readNode', async nodePath => {
  const token = await getAccessToken();
  const res = await fetch(`${DATABASE_URL}/${nodePath}.json?access_token=${token}`);
  if (!res.ok) {
    throw new Error(`Đọc cấu hình từ Firebase thất bại (${res.status}).`);
  }
  const data = await res.json();
  return data && typeof data === 'object' ? data : null;
});

// Trả về { activeId, servers }, hoặc null nếu Firebase chưa có cấu hình nào.
// Chưa có danh sách mới thì chuyển từ cấu hình 1 GCP cũ (gcpAdsConfig).
const getGcpAdsServersFromFirebase = trace.traced('firebase.getGcpAdsServers', async () => {
  const node = await readNode('gcpAdsServers');
  if (node) return gcpServers.normalize(node);
  const legacy = gcpServers.fromLegacy(await readNode('gcpAdsConfig'));
  return legacy.servers.length ? legacy : null;
});

const saveGcpAdsServersToFirebase = trace.traced('firebase.saveGcpAdsServers', async input => {
  const token = await getAccessToken();
  const url = `${DATABASE_URL}/gcpAdsServers.json?access_token=${token}`;
  const payload = { ...gcpServers.normalize(input), updatedAt: new Date().toISOString() };
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Lưu cấu hình lên Firebase thất bại (${res.status}).`);
  }
  return payload;
});

// Cấu hình pool worker (queryPool) — dùng chung cho mọi máy, ai cũng đổi được
const POOL_CONFIG_KEYS = ['start', 'min', 'hardCap', 'probeBatch', 'fallbackBlockMs', 'recoveryMs', 'taskTimeoutMs'];

const pickPoolConfig = trace.traced('firebase.pickPoolConfig', data => {
  const config = {};
  for (const key of POOL_CONFIG_KEYS) {
    if (Number.isFinite(Number(data?.[key])) && data?.[key] !== null) config[key] = Number(data[key]);
  }
  return config;
});

const getPoolConfigFromFirebase = trace.traced('firebase.getPoolConfig', async () => {
  const data = await readNode('poolConfig');
  return data ? pickPoolConfig(data) : null;
});

const savePoolConfigToFirebase = trace.traced('firebase.savePoolConfig', async config => {
  const token = await getAccessToken();
  const payload = { ...pickPoolConfig(config), updatedAt: new Date().toISOString() };
  const res = await fetch(`${DATABASE_URL}/poolConfig.json?access_token=${token}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Lưu cấu hình pool lên Firebase thất bại (${res.status}).`);
  }
  return payload;
});

module.exports = {
  getPoolConfigFromFirebase,
  savePoolConfigToFirebase,
  getAccessToken,
  getGcpAdsServersFromFirebase,
  saveGcpAdsServersToFirebase,
  createServiceAccountJwt,
};
