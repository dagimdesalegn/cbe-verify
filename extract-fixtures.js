// extract-fixtures.js — moves hardcoded test data into gitignored fixtures
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = __dirname;
process.chdir(root);

console.log('\n=== 1. Writing test-fixtures.json (gitignored, real data) ===');
const fixtures = {
  cbe: {
    smsText: "Dear Dagim Desalegn You have successfully transferred ETB1.00 from account 1********7333 to account 1********3794 (Abdulmejid Sehab Mohammed). Service charge of ETB 0.50 and VAT(15%) of ETB0.08 and Disaster Recovery(5%) of 0.03 with total of ETB1.61 .Your current balance is ETB3,338.74. Thanks for Banking with CBE. https://mbreciept.cbe.com.et/v2-hfHCxHaJXg7XVz9GQAvs",
    referenceNumber: "FT26262VQ6GV",
    accountSuffix: "35207333",
    receiptUrl: "https://mbreciept.cbe.com.et/v2-hfHCxHaJXg7XVz9GQAvs"
  },
  telebirr: {
    smsText: "Dear Dagim You have transferred ETB 1.00 to bertukan desalegn (2519****6052) on 23/09/2026 20:07:03. Your transaction number is DIN92X87AT. The service fee is ETB 0.87 and 15% VAT on the service fee is ETB 0.13. Your current E-Money Account balance is ETB 14.63. To download your payment information please click this link: https://transactioninfo.ethiotelecom.et/receipt/DIN92X87AT. Thank you for using telebirr",
    referenceNumber: "DIN92X87AT",
    receiptUrl: "https://transactioninfo.ethiotelecom.et/receipt/DIN92X87AT"
  }
};
fs.writeFileSync('test-fixtures.json', JSON.stringify(fixtures, null, 2), 'utf8');
console.log('  wrote: test-fixtures.json');

console.log('\n=== 2. Writing test-fixtures.example.json (committed, placeholders) ===');
const example = {
  cbe: {
    smsText: "Dear [Your Name] You have successfully transferred ETB[X] from account [XXXX] to account [XXXX] ([Receiver Name]). Service charge of ETB [X] and VAT(15%) of ETB[X] and Disaster Recovery(5%) of [X] with total of ETB[X]. Your current balance is ETB[X]. Thanks for Banking with CBE. https://mbreciept.cbe.com.et/v2-XXXXX",
    referenceNumber: "FTXXXXXXXXXX",
    accountSuffix: "XXXXXXXX",
    receiptUrl: "https://mbreciept.cbe.com.et/v2-XXXXX"
  },
  telebirr: {
    smsText: "Dear [Your Name] You have transferred ETB [X] to [Receiver Name] ([XXXX****XXXX]) on DD/MM/YYYY HH:MM:SS. Your transaction number is XXXXXXXXXX. The service fee is ETB [X] and 15% VAT on the service fee is ETB [X]. Your current E-Money Account balance is ETB [X]. To download your payment information please click this link: https://transactioninfo.ethiotelecom.et/receipt/XXXXXXXXXX. Thank you for using telebirr",
    referenceNumber: "XXXXXXXXXX",
    receiptUrl: "https://transactioninfo.ethiotelecom.et/receipt/XXXXXXXXXX"
  }
};
fs.writeFileSync('test-fixtures.example.json', JSON.stringify(example, null, 2), 'utf8');
console.log('  wrote: test-fixtures.example.json');

console.log('\n=== 3. Rewriting test-api.js to read from fixtures ===');
const testApi = `// test-api.js - local end-to-end test (reads from test-fixtures.json)
const fs = require('fs');
const path = require('path');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';
const ADMIN = process.env.ADMIN_API_KEY;

if (!ADMIN) {
  console.error('Missing ADMIN_API_KEY. Set it in .env or export it before running.');
  process.exit(1);
}

const fixturesPath = path.join(__dirname, 'test-fixtures.json');
if (!fs.existsSync(fixturesPath)) {
  console.error('Missing test-fixtures.json. Copy test-fixtures.example.json and fill it with real values.');
  process.exit(1);
}
const FIXTURES = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));

async function jfetch(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

(async () => {
  console.log('\\n=== 1. Health check ===');
  {
    const r = await jfetch(BASE + '/health/live');
    console.log('Status:', r.status, '| Body:', JSON.stringify(r.body));
  }

  console.log('\\n=== 2. Create API key ===');
  let key;
  {
    const r = await jfetch(BASE + '/api/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': ADMIN },
      body: JSON.stringify({ name: 'test-key-' + Date.now() }),
    });
    console.log('Status:', r.status);
    console.log(JSON.stringify(r.body, null, 2));
    key = r.body && r.body.data && r.body.data.key;
    if (!key) { console.error('No key - aborting'); process.exit(1); }
    console.log('\\n>>> API KEY: ' + key);
  }

  console.log('\\n=== 3. CBE - Verify by SMS ===');
  {
    const r = await jfetch(BASE + '/api/verify?waitMs=15000', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'idempotency-key': 'cbe-sms-' + Date.now(),
      },
      body: JSON.stringify({ bank: 'cbe', referenceNumber: FIXTURES.cbe.smsText }),
    });
    console.log('Status:', r.status);
    console.log(JSON.stringify(r.body, null, 2));
  }

  console.log('\\n=== 4. CBE - Verify by reference + suffix ===');
  {
    const r = await jfetch(BASE + '/api/verify?waitMs=30000', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'idempotency-key': 'cbe-ref-' + Date.now(),
      },
      body: JSON.stringify({
        bank: 'cbe',
        referenceNumber: FIXTURES.cbe.referenceNumber,
        accountSuffix: FIXTURES.cbe.accountSuffix,
      }),
    });
    console.log('Status:', r.status);
    console.log(JSON.stringify(r.body, null, 2));
  }

  console.log('\\n=== 5. Telebirr - Verify by SMS ===');
  {
    const r = await jfetch(BASE + '/api/verify?waitMs=30000', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'idempotency-key': 'tb-sms-' + Date.now(),
      },
      body: JSON.stringify({ bank: 'telebirr', referenceNumber: FIXTURES.telebirr.smsText }),
    });
    console.log('Status:', r.status);
    console.log(JSON.stringify(r.body, null, 2));
  }

  console.log('\\n=== 6. Telebirr - Verify by transaction number ===');
  {
    const r = await jfetch(BASE + '/api/verify?waitMs=30000', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'idempotency-key': 'tb-ref-' + Date.now(),
      },
      body: JSON.stringify({ bank: 'telebirr', referenceNumber: FIXTURES.telebirr.referenceNumber }),
    });
    console.log('Status:', r.status);
    console.log(JSON.stringify(r.body, null, 2));
  }

  console.log('\\n=== Done ===');
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
`;
fs.writeFileSync('test-api.js', testApi, 'utf8');
console.log('  rewrote: test-api.js');

console.log('\n=== 4. Rewriting test-telebirr-direct.js to read from fixtures ===');
const testTb = `// test-telebirr-direct.js - calls the scraper directly
const fs = require('fs');
const path = require('path');

require('tsx/cjs');
const { fetchTelebirrReceipt } = require('./src/services/telebirrScraper.ts');

const fixturesPath = path.join(__dirname, 'test-fixtures.json');
if (!fs.existsSync(fixturesPath)) {
  console.error('Missing test-fixtures.json. Copy test-fixtures.example.json and fill it.');
  process.exit(1);
}
const FIXTURES = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));

(async () => {
  const ref = process.argv[2] || FIXTURES.telebirr.referenceNumber;
  console.log('Testing Telebirr receipt:', ref);
  const start = Date.now();
  const result = await fetchTelebirrReceipt(ref);
  console.log('\\n=== RESULT (' + (Date.now() - start) + 'ms) ===');
  console.log(JSON.stringify(result, null, 2));

  const f = './debug-receipts/telebirr_' + ref + '.html';
  if (fs.existsSync(f)) {
    const html = fs.readFileSync(f, 'utf8');
    console.log('\\n=== HTML saved: ' + html.length + ' bytes ===');
  }
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e?.stack ?? e); process.exit(1); });
`;
fs.writeFileSync('test-telebirr-direct.js', testTb, 'utf8');
console.log('  rewrote: test-telebirr-direct.js');

console.log('\n=== 5. Updating .gitignore ===');
const gi = fs.readFileSync('.gitignore', 'utf8');
const additions = [];
if (!gi.includes('test-fixtures.json')) additions.push('test-fixtures.json');
if (!gi.includes('debug-receipts')) additions.push('debug-receipts/');
if (additions.length) {
  fs.appendFileSync('.gitignore', '\\n# Test fixtures with real receipt data\\n' + additions.join('\\n') + '\\n');
  console.log('  appended:', additions.join(', '));
} else {
  console.log('  already present');
}

console.log('\n=== 6. Committing and pushing ===');
try {
  execSync('git rm --cached test-fixtures.json', { stdio: 'ignore' });
} catch {}
try {
  execSync('git add -A', { stdio: 'inherit' });
  execSync('git commit -m "Remove hardcoded test data: move to gitignored test-fixtures.json"', { stdio: 'inherit' });
  execSync('git push', { stdio: 'inherit' });
  console.log('\\nDONE');
} catch (e) {
  console.log('\\nGit error:', e.message);
}