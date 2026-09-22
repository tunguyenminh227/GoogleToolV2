const { traced: t } = require('./trace-log');
const bridges = new Map();
const proxyArgs = t('proxy.args', async (id, args, config) => {
  if (!config.proxyUrl || !config.proxyUsername) return args;
  let server = bridges.get(id);
  if (!server) {
    const { Server } = await import('proxy-chain');
    const upstream = new URL(config.proxyUrl);
    upstream.username = config.proxyUsername;
    upstream.password = config.proxyPassword || '';
    server = new Server({ host: '127.0.0.1', port: 0, verbose: false,
      prepareRequestFunction: t('proxy.upstream', () => ({ upstreamProxyUrl: upstream.href })) });
    try { await server.listen(); }
    catch { throw new Error('Không khởi động được proxy xác thực.'); }
    bridges.set(id, server);
  }
  return [...args.filter(t('proxy.filterArg', arg => !arg.startsWith('--proxy-server='))), `--proxy-server=http://127.0.0.1:${server.port}`];
}, { profileArgument: 0 });
const closeProxy = t('proxy.close', async id => {
  const server = bridges.get(id);
  if (!server) return;
  bridges.delete(id);
  try { await server.close(true); } catch { /* Already closed. */ }
}, { profileArgument: 0 });
module.exports = { proxyArgs, closeProxy };
