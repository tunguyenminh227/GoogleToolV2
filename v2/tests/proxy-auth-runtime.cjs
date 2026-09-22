const { app } = require('electron');
const assert = require('node:assert/strict');
const http = require('node:http');
const { proxyArgs, closeProxy } = require('../proxy-auth');
const secrets = require('../secret-config');
const { normalize } = require('../fingerprint-config');
const { traced: t } = require('../trace-log');
app.whenReady().then(t('test.proxyAuth', async () => {
  const config = { proxyUsername: 'fixture-user', proxyPassword: 'fixture:p@ss' };
  const persisted = secrets.stringify(config);
  assert.ok(!persisted.includes(config.proxyPassword));
  assert.deepEqual(secrets.parse(persisted), config);
  let authenticated = false;
  const upstream = http.createServer(t('test.upstream', (req, res) => {
    authenticated = req.headers['proxy-authorization'] === 'Basic ' + Buffer.from(config.proxyUsername + ':' + config.proxyPassword).toString('base64');
    res.writeHead(authenticated ? 200 : 407); res.end(authenticated ? 'proxy-ok' : 'denied');
  }));
  await new Promise(t('test.listen', resolve => upstream.listen(0, '127.0.0.1', resolve)));
  const id = '11111111-1111-4111-8111-111111111111';
  try {
    const normalized = normalize({ ...config, proxyUrl: `http://127.0.0.1:${upstream.address().port}` });
    const args = await proxyArgs(id, [`--proxy-server=${normalized.proxyUrl}`], normalized);
    assert.equal(args.length, 1);
    assert.ok(!args[0].includes(config.proxyPassword));
    const local = new URL(args[0].slice('--proxy-server='.length));
    const body = await new Promise(t('test.request', (resolve, reject) => {
      const req = http.get({ hostname: local.hostname, port: local.port, path: 'http://fixture.invalid/' }, t('test.response', res => {
        let data = ''; res.on('data', t('test.data', chunk => { data += chunk; }));
        res.on('end', t('test.end', () => resolve(data)));
      }));
      req.on('error', reject);
    }));
    assert.equal(authenticated, true); assert.equal(body, 'proxy-ok');
    console.log('PROXY_AUTH_PASS');
  } finally {
    await closeProxy(id);
    await new Promise(t('test.stopUpstream', resolve => upstream.close(resolve)));
  }
})).then(t('test.exit', () => app.exit(0))).catch(t('test.failed', () => { console.error('PROXY_AUTH_FAIL'); app.exit(1); }));
