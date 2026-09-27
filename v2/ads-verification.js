const trace = require('./trace-log');
const { queryPool, QuotaStopError, AdsApiError, isAdsQuotaError, getTaskTimeoutMs } = require('./query-pool');
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
    throw new Error('Chưa cấu hình Client ID, Client Secret hoặc chưa có Refresh Token. Vui lòng bấm "Cài đặt" hoặc "Tạo link đăng nhập ads".');
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

const apiErrorMessage = t('adsVerification.apiErrorMessage', (data, status) => {
  let errMsg = `HTTP ${status}`;
  if (data.error && data.error.message) errMsg = data.error.message;
  if (data.error && Array.isArray(data.error.details)) {
    for (const d of data.error.details) {
      if (Array.isArray(d.errors) && d.errors[0] && d.errors[0].message) {
        errMsg = d.errors[0].message;
        break;
      }
    }
  }
  return errMsg;
});

const adsHeaders = t('adsVerification.adsHeaders', (accessToken, developerToken, loginCustomerId) => {
  const headers = { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  if (loginCustomerId) headers['login-customer-id'] = loginCustomerId;
  if (developerToken) headers['developer-token'] = developerToken;
  return headers;
});

// MỌI lệnh gọi Google Ads API phải đi qua đây: xếp hàng trong queryPool (tự dò trần concurrency),
// có thời gian chờ bằng AbortSignal. Lỗi quota ném AdsApiError để pool ghi trần + back off, rồi đổi thành
// QuotaStopError cho nơi gọi. Lỗi thường trả { ok: false } như Response để giữ nguyên cách xử lý cũ.
const adsRequest = t('adsVerification.adsRequest', async (url, init = {}) => {
  try {
    return await queryPool.run(async () => {
      const timeoutMs = getTaskTimeoutMs();
      let res, text;
      try {
        res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        text = await res.text();
      } catch (error) {
        if (error?.name === 'TimeoutError') throw new Error(`Google Ads API không phản hồi sau ${Math.round(timeoutMs / 1000)} giây.`);
        throw error;
      }
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
      if (!res.ok) {
        const error = new AdsApiError(res.status, data, res.headers.get('retry-after'));
        if (isAdsQuotaError(error)) throw error;
      }
      return { ok: res.ok, status: res.status, data };
    });
  } catch (error) {
    if (isAdsQuotaError(error)) throw new QuotaStopError(`Google Ads API báo vượt quota: ${apiErrorMessage(error.body || {}, error.status)}`);
    throw error;
  }
});

// Như adsRequest nhưng lỗi thường (mạng, timeout) trả null. QuotaStopError vẫn ném ra để dừng cả lượt.
const adsRequestOrNull = t('adsVerification.adsRequestOrNull', async (url, init) => {
  try {
    return await adsRequest(url, init);
  } catch (error) {
    if (error instanceof QuotaStopError) throw error;
    return null;
  }
});

const queryMccAccounts = t('adsVerification.queryMccAccounts', async (accessToken, developerToken, mccCleanId) => {
  const url = `${BASE_URL}/${API_VERSION}/customers/${mccCleanId}/googleAds:search`;
  const query = 'SELECT customer_client.id, customer_client.descriptive_name, customer_client.status, customer_client.manager FROM customer_client WHERE customer_client.manager = FALSE';

  const res = await adsRequest(url, {
    method: 'POST',
    headers: adsHeaders(accessToken, developerToken, mccCleanId),
    body: JSON.stringify({ query }),
  });

  const data = res.data;
  if (!res.ok) {
    const errMsg = apiErrorMessage(data, res.status);
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
          status: row.customerClient.status || '',
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
  const res = await adsRequestOrNull(url, {
    method: 'POST',
    headers: adsHeaders(accessToken, developerToken, mccCleanId),
    body: JSON.stringify({
      verificationProgram: 'ADVERTISER_IDENTITY_VERIFICATION'
    }),
  });

  if (res && res.ok) return { ok: true, error: '' };
  return { ok: false, error: res ? apiErrorMessage(res.data, res.status) : 'không kết nối được' };
});

// Đọc mục ADVERTISER_IDENTITY_VERIFICATION trong GetIdentityVerificationResponse -> trạng thái hiển thị.
// program_status: PENDING_USER_ACTION | PENDING_REVIEW | SUCCESS | FAILURE; không có verificationProgress = chưa bắt đầu.
const parseIdentityVerification = t('adsVerification.parseIdentityVerification', data => {
  const list = Array.isArray(data?.identityVerification) ? data.identityVerification : [];
  const item = list.find(i => i.verificationProgram === 'ADVERTISER_IDENTITY_VERIFICATION');
  if (!item) return null;
  const prog = item.verificationProgress || {};
  const req = item.identityVerificationRequirement || {};
  const status = prog.programStatus || 'NOT_STARTED';
  const statusText = {
    NOT_STARTED: 'Chưa bắt đầu - Cần thao tác',
    PENDING_USER_ACTION: 'Cần thao tác',
    PENDING_REVIEW: 'Đang chờ Google duyệt',
    SUCCESS: 'Đã xác minh',
    FAILURE: 'Xác minh thất bại',
  }[status] || `Cần kiểm tra (${status})`;
  const expiresAt = prog.invitationLinkExpirationTime || null;
  // Hạn link là chuỗi ngày giờ; chỉ coi là hết hạn khi parse được (không parse được thì vẫn dùng link)
  const expiresMs = expiresAt ? Date.parse(String(expiresAt).replace(' ', 'T')) : NaN;
  return {
    required: status !== 'SUCCESS',
    status,
    statusText,
    actionUrl: prog.actionUrl || '',
    linkExpiresAt: expiresAt,
    linkExpired: Number.isFinite(expiresMs) && expiresMs <= Date.now(),
    deadline: req.verificationCompletionDeadlineTime || req.verificationStartDeadlineTime || null,
  };
});

const getCustomerVerification = t('adsVerification.getCustomerVerification', async (accessToken, developerToken, mccCleanId, customerId, options = {}) => {
  const cleanId = cleanCustomerId(customerId);
  const defaultUrl = `https://ads.google.com/aw/billing/advertiserverification?ocid=${cleanId}`;
  const url = `${BASE_URL}/${API_VERSION}/customers/${cleanId}/getIdentityVerification`;
  const headers = adsHeaders(accessToken, developerToken, mccCleanId);
  const base = { customerId: cleanId, formattedId: formatCustomerId(cleanId), linkExpiresAt: null, deadline: null };

  const res = await adsRequestOrNull(url, { method: 'GET', headers });
  if (!res || !res.ok) {
    // Lỗi API (quyền, tài khoản...) không có nghĩa là "không yêu cầu" -> báo để kiểm tra thủ công
    const reason = res ? apiErrorMessage(res.data, res.status) : 'không kết nối được';
    return { ...base, required: true, status: 'API_ERROR', statusText: `Lỗi API: ${reason}`, actionUrl: defaultUrl };
  }

  // Khởi tạo phiên xác minh rồi đọc lại: action_url API trả về là link wizard
  // https://ads.google.com/identity/advertiser-verification?ocid=...&ivid=... (ivid = mã phiên). Dùng nguyên văn.
  const startAndRefresh = t('adsVerification.startAndRefresh', async () => {
    const started = await startCustomerVerification(accessToken, developerToken, mccCleanId, cleanId);
    if (!started.ok) return { started, info: null };
    const refreshRes = await adsRequestOrNull(url, { method: 'GET', headers });
    return { started, info: refreshRes?.ok ? parseIdentityVerification(refreshRes.data) : null };
  });

  let info = parseIdentityVerification(res.data);
  if (!info) {
    // Rỗng = API cho biết tài khoản không thuộc chương trình xác minh bắt buộc.
    // Tài khoản Suspend thì giao diện Google Ads vẫn có thể đòi xác minh -> thử khởi tạo phiên để lấy link ivid.
    if (options.startWhenEmpty) {
      const attempt = await startAndRefresh();
      if (attempt.info) info = attempt.info;
      else {
        const why = attempt.started.ok ? 'API không trả link sau khi khởi tạo phiên' : `không khởi tạo được phiên: ${attempt.started.error}`;
        return { ...base, required: false, status: 'NOT_REQUIRED', statusText: 'Không yêu cầu', startError: why, actionUrl: defaultUrl };
      }
    } else {
      return { ...base, required: false, status: 'NOT_REQUIRED', statusText: 'Không yêu cầu', actionUrl: defaultUrl };
    }
  }

  // Cần link mới: chưa bắt đầu, UNKNOWN, hoặc đang chờ người dùng mà link thiếu/hết hạn.
  // StartIdentityVerification chỉ thành công khi không có phiên nào đang chạy.
  const needsSession = ['NOT_STARTED', 'UNKNOWN'].includes(info.status) ||
    ((!info.actionUrl || info.linkExpired) && !['SUCCESS', 'PENDING_REVIEW'].includes(info.status));
  if (needsSession) {
    const attempt = await startAndRefresh();
    if (attempt.info) info = attempt.info;
  }

  return {
    ...base,
    ...info,
    actionUrl: info.actionUrl && !info.linkExpired ? info.actionUrl : defaultUrl,
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

  // Chỉ quét tài khoản Live (ENABLED) và Suspend (SUSPENDED); bỏ tài khoản đã hủy/đóng.
  // status rỗng = dòng fallback chính MCC khi không truy vấn được customer_client -> vẫn quét.
  const activeAccounts = clientAccounts.filter(client => !client.status || ['ENABLED', 'SUSPENDED'].includes(client.status));
  const skippedCount = clientAccounts.length - activeAccounts.length;

  const allResults = [];
  const needingVerification = [];

  // Đẩy cả lượt vào queryPool — pool tự giới hạn và dò concurrency. Dính quota thì cả lượt dừng (QuotaStopError).
  await Promise.all(activeAccounts.map(async client => {
    try {
      const v = await getCustomerVerification(accessToken, developerToken, mccCleanId, client.id, { startWhenEmpty: client.status === 'SUSPENDED' });
      const info = {
        ...v,
        name: client.name,
        accountStatus: client.status,
      };
      // Tài khoản Suspend: IdentityVerificationService thường trả rỗng dù giao diện Google Ads vẫn đòi xác minh
      // (yêu cầu gắn với lý do tạm ngưng, API không cung cấp) -> vẫn liệt kê để kiểm tra thủ công.
      if (client.status === 'SUSPENDED' && !info.required) {
        info.required = true;
        info.status = 'SUSPENDED_CHECK';
        info.statusText = info.startError ? `Suspend - cần kiểm tra (${info.startError})` : 'Suspend - API không báo, cần kiểm tra';
      }
      allResults.push(info);
      if (info.required) {
        needingVerification.push(info);
      }
    } catch (err) {
      if (err instanceof QuotaStopError) throw err;
      console.warn(`[ads-verification] Lỗi kiểm tra tài khoản ${client.id}:`, err.message);
      const fallbackInfo = {
        customerId: client.id,
        formattedId: formatCustomerId(client.id),
        name: client.name,
        accountStatus: client.status,
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

  console.log(`[ads-verification] Quét hoàn tất: ${needingVerification.length}/${activeAccounts.length} tài khoản cần xác minh (bỏ qua ${skippedCount} tài khoản đã hủy/đóng).`);

  return {
    mccId: mccCleanId,
    formattedMccId: formatCustomerId(mccCleanId),
    totalAccounts: clientAccounts.length,
    skippedCount,
    needingVerification,
    allResults,
  };
});

// Các MCC mà tài khoản Google (chủ Refresh Token) truy cập trực tiếp
const listAccessibleMccs = t('adsVerification.listAccessibleMccs', async config => {
  const developerToken = config?.developerToken?.trim() || '';
  const accessToken = await getAccessToken(config);

  const res = await adsRequest(`${BASE_URL}/${API_VERSION}/customers:listAccessibleCustomers`, {
    method: 'GET',
    headers: adsHeaders(accessToken, developerToken),
  });
  if (!res.ok) {
    throw new Error(`Không lấy được danh sách tài khoản Google Ads: ${apiErrorMessage(res.data, res.status)}`);
  }
  const ids = (res.data.resourceNames || []).map(name => cleanCustomerId(name)).filter(Boolean);

  const query = 'SELECT customer.id, customer.descriptive_name, customer.manager FROM customer LIMIT 1';
  const mccs = [];
  // Đẩy cả lượt vào queryPool — pool tự giới hạn và dò concurrency
  await Promise.all(ids.map(async id => {
    // Tài khoản bị hủy/tạm ngưng có thể trả lỗi khi truy vấn — bỏ qua vì không phải MCC dùng được
    const r = await adsRequestOrNull(`${BASE_URL}/${API_VERSION}/customers/${id}/googleAds:search`, {
      method: 'POST',
      headers: adsHeaders(accessToken, developerToken, id),
      body: JSON.stringify({ query }),
    });
    if (!r || !r.ok) return;
    const customer = r.data.results?.[0]?.customer;
    if (!customer?.manager) return;
    mccs.push({
      id,
      formattedId: formatCustomerId(id),
      name: customer.descriptiveName || `MCC ${formatCustomerId(id)}`,
    });
  }));
  mccs.sort((a, b) => a.name.localeCompare(b.name));
  return mccs;
});

// Trang tổng quan tài khoản — banner "tạm ngưng" ở đây có link gửi kháng nghị
const appealUrl = t('adsVerification.appealUrl', customerId => `https://ads.google.com/aw/overview?__e=${cleanCustomerId(customerId)}`);

const scanMccSuspended = t('adsVerification.scanMccSuspended', async (config, mccId) => {
  const mccCleanId = cleanCustomerId(mccId);
  if (!mccCleanId || mccCleanId.length < 5) {
    throw new Error('Vui lòng nhập ID MCC hợp lệ (10 chữ số).');
  }

  const developerToken = config?.developerToken?.trim() || '';
  const accessToken = await getAccessToken(config);

  const query = 'SELECT customer_client.id, customer_client.descriptive_name, customer_client.status FROM customer_client WHERE customer_client.manager = FALSE';
  const res = await adsRequest(`${BASE_URL}/${API_VERSION}/customers/${mccCleanId}/googleAds:search`, {
    method: 'POST',
    headers: adsHeaders(accessToken, developerToken, mccCleanId),
    body: JSON.stringify({ query }),
  });
  const data = res.data;
  if (!res.ok) {
    throw new Error(`Không lấy được danh sách tài khoản trong MCC ${formatCustomerId(mccCleanId)}: ${apiErrorMessage(data, res.status)}`);
  }

  const accounts = (Array.isArray(data.results) ? data.results : [])
    .map(row => row.customerClient)
    .filter(client => client && client.id);
  const suspended = accounts
    .filter(client => client.status === 'SUSPENDED')
    .map(client => ({
      customerId: String(client.id),
      formattedId: formatCustomerId(client.id),
      name: client.descriptiveName || `Tài khoản ${formatCustomerId(client.id)}`,
      accountStatus: 'SUSPENDED',
      status: 'SUSPENDED',
      statusText: 'Bị tạm ngưng',
      actionUrl: appealUrl(client.id),
    }));

  console.log(`[ads-verification] MCC ${formatCustomerId(mccCleanId)}: ${suspended.length}/${accounts.length} tài khoản bị tạm ngưng.`);

  return {
    mccId: mccCleanId,
    formattedMccId: formatCustomerId(mccCleanId),
    totalAccounts: accounts.length,
    suspended,
  };
});

module.exports = {
  cleanCustomerId,
  formatCustomerId,
  getAccessToken,
  queryMccAccounts,
  getCustomerVerification,
  scanMccVerification,
  scanMccSuspended,
  listAccessibleMccs,
};
