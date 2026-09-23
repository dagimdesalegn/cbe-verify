require('dotenv').config();
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

async function verifyAndPoll(payload, key) {
  const r = await jfetch(BASE + '/api/verify?waitMs=30000', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'idempotency-key': require('crypto').randomUUID(),
    },
    body: JSON.stringify(payload),
  });

  if (r.status === 200) return r;

  if (r.status === 202 && r.body && r.body.statusUrl) {
    const url = BASE + r.body.statusUrl;
    for (let i = 0; i < 20; i++) {
      await new Promise((res) => setTimeout(res, 2000));
      const s = await jfetch(url, { headers: { 'x-api-key': key } });
      const ps = s.body && s.body.data && s.body.data.processingStatus;
      if (ps === 'completed' || ps === 'failed') {
        return { status: 200, body: s.body };
      }
    }
  }
  return r;
}

(async () => {
  console.log('\n=== 1. Health check ===');
  {
    const r = await jfetch(BASE + '/health/live');
    console.log('Status:', r.status, '| Body:', JSON.stringify(r.body));
  }

  console.log('\n=== 2. Create API key ===');
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
    console.log('\n>>> API KEY: ' + key);
  }

  console.log('\n=== 3. CBE - Verify by SMS ===');
  {
    const r = await verifyAndPoll({ bank: 'cbe', referenceNumber: FIXTURES.cbe.smsText }, key);
    console.log('Status:', r.status);
    console.log(JSON.stringify(r.body, null, 2));
  }

  console.log('\n=== 4. CBE - Verify by reference + suffix ===');
  {
    const r = await verifyAndPoll({
      bank: 'cbe',
      referenceNumber: FIXTURES.cbe.referenceNumber,
      accountSuffix: FIXTURES.cbe.accountSuffix,
    }, key);
    console.log('Status:', r.status);
    console.log(JSON.stringify(r.body, null, 2));
  }

  console.log('\n=== 5. Telebirr - Verify by SMS ===');
  {
    const r = await verifyAndPoll({ bank: 'telebirr', referenceNumber: FIXTURES.telebirr.smsText }, key);
    console.log('Status:', r.status);
    console.log(JSON.stringify(r.body, null, 2));
  }

  console.log('\n=== 6. Telebirr - Verify by transaction number ===');
  {
    const r = await verifyAndPoll({ bank: 'telebirr', referenceNumber: FIXTURES.telebirr.referenceNumber }, key);
    console.log('Status:', r.status);
    console.log(JSON.stringify(r.body, null, 2));
  }

  console.log('\n=== Done ===');
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
