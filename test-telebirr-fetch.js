// test-telebirr-fetch.js — diagnostic for Telebirr URL access
const https = require('https');
const http = require('http');
const dns = require('node:dns');

// Prefer IPv6
try { dns.setDefaultResultOrder('ipv6first'); } catch {}

const REF = process.argv[2] || 'DIN92X87AT';
const URL = 'https://transactioninfo.ethiotelecom.et/receipt/' + REF;

const COMMON = {
  'accept-language': 'en-US,en;q=0.9',
  'accept-encoding': 'gzip, deflate, br',
  'cache-control': 'no-cache',
  'pragma': 'no-cache',
  'upgrade-insecure-requests': '1',
};

const MOBILE_HINTS = {
  'sec-ch-ua-mobile': '?1',
  'sec-ch-ua-platform': '"Android"',
  'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'sec-fetch-site': 'none',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-user': '?1',
  'sec-fetch-dest': 'document',
};

const DESKTOP_HINTS = {
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
};

const ATTEMPTS = [
  {
    name: 'A_desktop_plain',
    headers: {
      ...COMMON,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  },
  {
    name: 'B_desktop_with_hints',
    headers: {
      ...COMMON,
      ...DESKTOP_HINTS,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    },
  },
  {
    name: 'C_android_mobile',
    headers: {
      ...COMMON,
      ...MOBILE_HINTS,
      'user-agent': 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    },
  },
  {
    name: 'D_iphone_safari',
    headers: {
      ...COMMON,
      'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  },
  {
    name: 'E_telebirr_app',
    headers: {
      ...COMMON,
      'user-agent': 'Telebirr/1.0 (Android)',
      'accept': 'text/html,application/xhtml+xml,*/*',
    },
  },
];

function attempt(cfg) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = https.request(
      URL,
      { method: 'GET', headers: cfg.headers, timeout: 15000 },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          resolve({
            name: cfg.name,
            status: res.statusCode,
            length: body.length,
            ms: Date.now() - started,
            headers: res.headers,
            snippet: body.slice(0, 300),
          });
        });
      },
    );
    req.on('error', (e) => {
      resolve({
        name: cfg.name,
        error: e.code || e.message,
        ms: Date.now() - started,
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ name: cfg.name, error: 'TIMEOUT', ms: Date.now() - started });
    });
    req.end();
  });
}

(async () => {
  console.log('Testing URL: ' + URL);
  console.log('IPv6-first: yes\n');

  for (const cfg of ATTEMPTS) {
    const r = await attempt(cfg);
    console.log('--- ' + r.name + ' ---');
    if (r.error) {
      console.log('  ERROR:', r.error, '(' + r.ms + 'ms)');
    } else {
      console.log('  status:', r.status, '| length:', r.length, '| ' + r.ms + 'ms');
      if (r.snippet) console.log('  first 200:', r.snippet.replace(/\s+/g, ' ').slice(0, 200));
    }
    console.log('');
  }

  console.log('Done. Whichever attempt shows status 200 with a large body (5000+ chars) is the winning config.');
})();