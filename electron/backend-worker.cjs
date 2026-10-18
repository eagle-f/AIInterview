const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { once } = require('node:events');

(async () => {
  const { server } = await import(pathToFileURL(path.join(__dirname, '../dist-electron/server.mjs')).href);
  if (!server.listening) await once(server, 'listening');
  process.parentPort.postMessage({ type: 'ready', port: server.address().port });
})().catch((error) => {
  process.parentPort.postMessage({ type: 'startup-error', message: error.message });
  process.exit(1);
});
