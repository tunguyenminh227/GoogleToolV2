// Danh sách server GCP (Google Ads API): { activeId, servers: [{ id, name, clientId, ... }] }
const FIELDS = ['clientId', 'clientSecret', 'developerToken', 'refreshToken'];

const str = value => (typeof value === 'string' ? value.trim() : '');

function hasCredentials(config) {
  return Boolean(config && FIELDS.some(key => str(config[key])));
}

function normalize(data) {
  const raw = data?.servers;
  // Firebase RTDB có thể trả mảng dưới dạng object { "0": ..., "1": ... }
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.values(raw) : []);
  const usedIds = new Set();
  const servers = list.filter(item => item && typeof item === 'object').map((item, index) => {
    let id = str(item.id) || `gcp-${index + 1}`;
    while (usedIds.has(id)) id = `${id}-${index + 1}`;
    usedIds.add(id);
    const server = { id, name: str(item.name) || `GCP ${index + 1}` };
    FIELDS.forEach(key => { server[key] = str(item[key]); });
    return server;
  });
  const activeId = servers.some(s => s.id === data?.activeId) ? data.activeId : (servers[0]?.id || '');
  return { activeId, servers };
}

// Chuyển cấu hình 1 GCP cũ (gcpAdsConfig) thành danh sách 1 server
function fromLegacy(config) {
  if (!hasCredentials(config)) return { activeId: '', servers: [] };
  return normalize({ activeId: 'gcp-1', servers: [{ ...config, id: 'gcp-1', name: 'GCP 1' }] });
}

function active(data) {
  return data.servers.find(s => s.id === data.activeId) || data.servers[0] || null;
}

module.exports = { FIELDS, hasCredentials, normalize, fromLegacy, active };
