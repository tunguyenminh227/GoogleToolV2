const trace = require('./trace-log');
const t = trace.traced;

const API_VERSION = 'v25';
const BASE_URL = 'https://googleads.googleapis.com';

const cleanCustomerId = t('adsVerification.cleanCustomerId', id => {
  if (!id) return '';
  return String(id).replace(/\D/g, '');
});

const formatCustomerId = t('adsVerification.formatCustomerId', id => {
  const clean = cleanCustomerId(id);
  if (clean.length === 10) {
    return `${clean.slice(0, 3)}-${clean.slice(3, 6)}-${clean.slice(6, 10)}`;
  }
  return id || '';
});

const getAccessToken = t('adsVerification.getAccessToken', async config => {
  const clientId = config?.clientId?.trim();
  const clientSecret = config?.clientSecret?.trim();
  const refreshToken = config?.refreshToken?.trim();

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Chưa cấu hình Client ID, Client Secret hoặc chưa có Refresh Token. Vui lòng bấm "Cài đặt GCP" hoặc "Tạo link đăng nhập ads".');
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const msg = data.error_description || data.error || `HTTP ${res.status}`;
    throw new Error(`Không thể làm mới Access Token từ Google: ${msg}`);
  }

  return data.access_token;
});

const queryMccAccounts = t('adsVerification.queryMccAccounts', async (accessToken, developerToken, mccCleanId) => {
  const url = `${BASE_URL}/${API_VERSION}/customers/${mccCleanId}/googleAds:search`;
  const query = 'SELECT customer_client.id, customer_client.descriptive_name, customer_client.status, customer_client.manager FROM customer_client WHERE customer_client.manager = FALSE';

  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'login-customer-id': mccCleanId,
    'Content-Type': 'application/json',
  };
  if (developerToken) {
    headers['developer-token'] = developerToken;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    let errMsg = `HTTP ${res.status}`;
    if (data.error && data.error.message) errMsg = data.error.message;
    if (data.error && Array.isArray(data.error.details)) {
      for (const d of data.error.details) {
        if (Array.isArray(d.errors) && d.errors[0] && d.errors[0].message) {
          errMsg = d.errors[0].message;
          break;
        }
      }
    }
    // Nếu lỗi do ID này không phải MCC (hoặc tài khoản đơn), fallback trả về chính tài khoản này
    if (errMsg.includes('NOT_ADS_USER') || errMsg.includes('CUSTOMER_NOT_FOUND')) {
      throw new Error(`Không tìm thấy tài khoản Google Ads với ID: ${formatCustomerId(mccCleanId)} (${errMsg})`);
    }
    console.warn(`[ads-verification] Query customer_client thất bại (${errMsg}) -> Thử kiểm tra trực tiếp tài khoản ${mccCleanId}`);
    return [{ id: mccCleanId, name: `Tài khoản ${formatCustomerId(mccCleanId)}` }];
  }

  const results = [];
  if (Array.isArray(data.results)) {
    for (const row of data.results) {
      if (row.customerClient && row.customerClient.id) {
        results.push({
          id: String(row.customerClient.id),
          name: row.customerClient.descriptiveName || `Tài khoản ${formatCustomerId(row.customerClient.id)}`,
        });
      }
    }
  }

  if (results.length === 0) {
    results.push({ id: mccCleanId, name: `Tài khoản ${formatCustomerId(mccCleanId)}` });
  }

  return results;
});

const startCustomerVerification = t('adsVerification.startCustomerVerification', async (accessToken, developerToken, mccCleanId, customerId) => {
  const cleanId = cleanCustomerId(customerId);
  const url = `${BASE_URL}/${API_VERSION}/customers/${cleanId}:startIdentityVerification`;
  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'login-customer-id': mccCleanId,
    'Content-Type': 'application/json',
  };
  if (developerToken) {
    headers['developer-token'] = developerToken;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      verificationProgram: 'ADVERTISER_IDENTITY_VERIFICATION'
    }),
  }).catch(() => null);

  return Boolean(res && res.ok);
});

const getCustomerVerification = t('adsVerification.getCustomerVerification', async (accessToken, developerToken, mccCleanId, customerId) => {
  const cleanId = cleanCustomerId(customerId);
  const defaultUrl = `https://ads.google.com/aw/billing/advertiserverification?ocid=${cleanId}`;
  const url = `${BASE_URL}/${API_VERSION}/customers/${cleanId}/getIdentityVerification`;

  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'login-customer-id': mccCleanId,
    'Content-Type': 'application/json',
  };
  if (developerToken) {
    headers['developer-token'] = developerToken;
  }

  let res = await fetch(url, { method: 'GET', headers }).catch(() => null);
  if (!res || !res.ok) {
    const fallbackUrl = `${BASE_URL}/${API_VERSION}/customers/${cleanId}/identityVerification`;
    res = await fetch(fallbackUrl, { method: 'GET', headers }).catch(() => null);
  }

  if (!res || !res.ok) {
    return {
      customerId: cleanId,
      formattedId: formatCustomerId(cleanId),
      required: false,
      status: 'NOT_REQUIRED',
      statusText: 'Không yêu cầu',
      actionUrl: defaultUrl,
      deadline: null,
    };
  }

  const data = await res.json().catch(() => ({}));
  const list = data.identityVerification || data.identityVerifications || [];

  if (!Array.isArray(list) || list.length === 0) {
    return {
      customerId: cleanId,
      formattedId: formatCustomerId(cleanId),
      required: false,
      status: 'NOT_REQUIRED',
      statusText: 'Không yêu cầu',
      actionUrl: defaultUrl,
      deadline: null,
    };
  }

  let required = false;
  let status = 'NOT_REQUIRED';
  let statusText = 'Đã xác minh';
  let actionUrl = defaultUrl;
  let deadline = null;

  for (const item of list) {
    if (item.verificationProgram === 'ADVERTISER_IDENTITY_VERIFICATION') {
      const prog = item.verificationProgress || item.identityVerificationProgress || {};
      const req = item.identityVerificationRequirement || {};
      const pStatus = prog.programStatus || '';

      if (prog.actionUrl) {
        actionUrl = prog.actionUrl;
      }

      if (pStatus === 'SUCCESS') {
        required = false;
        status = 'SUCCESS';
        statusText = 'Đã xác minh';
      } else {
        required = true;
        status = pStatus || 'REQUIRED';
        statusText = pStatus === 'PENDING_USER_ACTION' ? 'Cần thao tác' : 'Chưa bắt đầu - Cần thao tác';
        deadline = req.verificationStartDeadlineTime || req.verificationCompletionDeadlineTime || req.verificationStartDeadline || req.verificationCompletionDeadline || null;
      }
    }
  }

  if (required && actionUrl === defaultUrl) {
    try {
      const started = await startCustomerVerification(accessToken, developerToken, mccCleanId, cleanId);
      if (started) {
        const refreshRes = await fetch(url, { method: 'GET', headers }).catch(() => null);
        if (refreshRes && refreshRes.ok) {
          const refreshData = await refreshRes.json().catch(() => ({}));
          const refreshList = refreshData.identityVerification || refreshData.identityVerifications || [];
          const targetItem = refreshList.find(i => i.verificationProgram === 'ADVERTISER_IDENTITY_VERIFICATION');
          if (targetItem?.verificationProgress?.actionUrl) {
            actionUrl = targetItem.verificationProgress.actionUrl;
          }
        }
      }
    } catch (_) {}
  }

  return {
    customerId: cleanId,
    formattedId: formatCustomerId(cleanId),
    required,
    status,
    statusText,
    actionUrl: actionUrl || defaultUrl,
    deadline,
  };
});

const scanMccVerification = t('adsVerification.scanMccVerification', async (config, mccId) => {
  const mccCleanId = cleanCustomerId(mccId);
  if (!mccCleanId || mccCleanId.length < 5) {
    throw new Error('Vui lòng nhập ID MCC hợp lệ (10 chữ số).');
  }

  const developerToken = config?.developerToken?.trim() || '';

  console.log(`[ads-verification] Bắt đầu quét tài khoản MCC: ${formatCustomerId(mccCleanId)}`);
  const accessToken = await getAccessToken(config);

  const clientAccounts = await queryMccAccounts(accessToken, developerToken, mccCleanId);
  console.log(`[ads-verification] Tìm thấy ${clientAccounts.length} tài khoản trong MCC ${formatCustomerId(mccCleanId)}.`);

  const allResults = [];
  const needingVerification = [];

  // Quét song song theo từng đợt 5 tài khoản để tối ưu tốc độ và không chạm giới hạn
  const BATCH_SIZE = 5;
  for (let i = 0; i < clientAccounts.length; i += BATCH_SIZE) {
    const chunk = clientAccounts.slice(i, i + BATCH_SIZE);
    await Promise.all(chunk.map(async client => {
      try {
        const v = await getCustomerVerification(accessToken, developerToken, mccCleanId, client.id);
        const info = {
          ...v,
          name: client.name,
        };
        allResults.push(info);
        if (info.required) {
          needingVerification.push(info);
        }
      } catch (err) {
        console.warn(`[ads-verification] Lỗi kiểm tra tài khoản ${client.id}:`, err.message);
        const fallbackInfo = {
          customerId: client.id,
          formattedId: formatCustomerId(client.id),
          name: client.name,
          required: true,
          status: 'CHECK_MANUAL',
          statusText: 'Cần kiểm tra link',
          actionUrl: `https://ads.google.com/aw/billing/advertiserverification?ocid=${client.id}`,
          deadline: null,
        };
        allResults.push(fallbackInfo);
        needingVerification.push(fallbackInfo);
      }
    }));

    if (i + BATCH_SIZE < clientAccounts.length) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  console.log(`[ads-verification] Quét hoàn tất: ${needingVerification.length}/${clientAccounts.length} tài khoản cần xác minh.`);

  return {
    mccId: mccCleanId,
    formattedMccId: formatCustomerId(mccCleanId),
    totalAccounts: clientAccounts.length,
    needingVerification,
    allResults,
  };
});

module.exports = {
  cleanCustomerId,
  formatCustomerId,
  getAccessToken,
  queryMccAccounts,
  getCustomerVerification,
  scanMccVerification,
};
