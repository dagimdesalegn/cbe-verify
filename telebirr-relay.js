// telebirr-relay.js
// Deploy this on an Ethiopian server (Ethio Telecom network).
// It proxies Telebirr receipt fetches from your main API so that
// geo-restricted receipt URLs respond correctly.
//
// Run:  node telebirr-relay.js
// Env:  PORT=4000  RELAY_SECRET=change_me
// Then set on your main API:
//   TELEBIRR_PROXY_URL=http://your-ethiopian-server:4000/relay
//   TELEBIRR_PROXY_SECRET=change_me

const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 4000);
const SECRET = process.env.RELAY_SECRET || '';
const ALLOWED_HOST = 'transactioninfo.ethiotelecom.et';

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, 'http://localhost:' + PORT);

  if (reqUrl.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (reqUrl.pathname !== '/relay') {
    res.writeHead(404);
    return res.end('Use /relay?url=<encoded>');
  }

  if (SECRET && req.headers['x-relay-secret'] !== SECRET) {
    res.writeHead(401);
    return res.end('Unauthorized');
  }

  const targetUrl = reqUrl.searchParams.get('url');
  if (!targetUrl) {
    res.writeHead(400);
    return res.end('Missing ?url=');
  }

  let parsed;
  try { parsed = new URL(targetUrl); } catch {
    res.writeHead(400);
    return res.end('Invalid URL');
  }

  if (parsed.hostname !== ALLOWED_HOST) {
    res.writeHead(403);
    return res.end('Only ' + ALLOWED_HOST + ' is allowed');
  }

  https
    .get(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0 TelebirrRelay/1.0' } }, (upstream) => {
      res.writeHead(upstream.statusCode || 502, {
        'content-type': upstream.headers['content-type'] || 'text/html',
      });
      upstream.pipe(res);
    })
    .on('error', (e) => {
      res.writeHead(502);
      res.end('Upstream error: ' + e.message);
    });
});

server.listen(PORT, () => {
  console.log('Telebirr relay listening on port ' + PORT);
  console.log('Deploy on an Ethiopian/Ethio Telecom server.');
  console.log('Set TELEBIRR_PROXY_URL on your main API to enable URL-based Telebirr verification.');
});