const test = require('node:test');
const assert = require('node:assert/strict');
const gcpServers = require('../gcp-servers');

test('fromLegacy wraps a single gcpAdsConfig into one active server', () => {
  const data = gcpServers.fromLegacy({ clientId: 'cid', clientSecret: 'sec', loginCustomerId: '123' });
  assert.equal(data.activeId, 'gcp-1');
  assert.deepEqual(data.servers, [{
    id: 'gcp-1', name: 'GCP 1', clientId: 'cid', clientSecret: 'sec', developerToken: '', refreshToken: '',
  }]);
  assert.deepEqual(gcpServers.fromLegacy({ clientId: '  ' }), { activeId: '', servers: [] });
  assert.deepEqual(gcpServers.fromLegacy(undefined), { activeId: '', servers: [] });
});

test('normalize accepts Firebase object-arrays, fixes names, duplicate ids and unknown activeId', () => {
  const data = gcpServers.normalize({
    activeId: 'missing',
    servers: { 0: { id: 'a', clientId: ' x ' }, 1: { id: 'a', name: 'Two' }, 2: null },
  });
  assert.deepEqual(data.servers.map(s => [s.id, s.name, s.clientId]), [['a', 'GCP 1', 'x'], ['a-2', 'Two', '']]);
  assert.equal(data.activeId, 'a');
  assert.equal(gcpServers.active(data).id, 'a');
});

test('active returns the selected server, or null when empty', () => {
  const data = gcpServers.normalize({ activeId: 'b', servers: [{ id: 'a' }, { id: 'b' }] });
  assert.equal(gcpServers.active(data).id, 'b');
  assert.equal(gcpServers.active(gcpServers.normalize({})), null);
});
