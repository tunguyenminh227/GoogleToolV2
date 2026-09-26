const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const trace = require('./trace-log');

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

const getGcpAdsConfigFromFirebase = trace.traced('firebase.getGcpAdsConfig', async () => {
  const token = await getAccessToken();
  const url = `${DATABASE_URL}/gcpAdsConfig.json?access_token=${token}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Đọc cấu hình từ Firebase thất bại (${res.status}).`);
  }
  const data = await res.json();
  if (!data || typeof data !== 'object') return null;
  return {
    clientId: typeof data.clientId === 'string' ? data.clientId : '',
    clientSecret: typeof data.clientSecret === 'string' ? data.clientSecret : '',
    developerToken: typeof data.developerToken === 'string' ? data.developerToken : '',
    refreshToken: typeof data.refreshToken === 'string' ? data.refreshToken : '',
    loginCustomerId: typeof data.loginCustomerId === 'string' ? data.loginCustomerId : '',
    updatedAt: data.updatedAt || null,
  };
});

const saveGcpAdsConfigToFirebase = trace.traced('firebase.saveGcpAdsConfig', async config => {
  const token = await getAccessToken();
  const url = `${DATABASE_URL}/gcpAdsConfig.json?access_token=${token}`;
  const payload = {
    clientId: typeof config?.clientId === 'string' ? config.clientId.trim() : '',
    clientSecret: typeof config?.clientSecret === 'string' ? config.clientSecret.trim() : '',
    developerToken: typeof config?.developerToken === 'string' ? config.developerToken.trim() : '',
    refreshToken: typeof config?.refreshToken === 'string' ? config.refreshToken.trim() : '',
    loginCustomerId: typeof config?.loginCustomerId === 'string' ? config.loginCustomerId.trim() : '',
    updatedAt: new Date().toISOString(),
  };
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

module.exports = {
  getAccessToken,
  getGcpAdsConfigFromFirebase,
  saveGcpAdsConfigToFirebase,
  createServiceAccountJwt,
};
