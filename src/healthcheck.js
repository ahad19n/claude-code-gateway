'use strict';
// Docker HEALTHCHECK: GET /health on the local port, over HTTPS when the server
// has TLS on. The certificate is for the public domain, not 127.0.0.1, so it
// isn't verified here.

const useTls = !!(process.env.TLS_CERT_FILE && process.env.TLS_KEY_FILE);
const lib = require(useTls ? 'https' : 'http');

const req = lib.get({
  host: '127.0.0.1',
  port: Number(process.env.PORT) || 8443,
  path: '/health',
  rejectUnauthorized: false,
  timeout: 4000,
}, (res) => {
  res.resume();
  process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on('timeout', () => req.destroy(new Error('timeout')));
req.on('error', () => process.exit(1));
