require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
      'idempotency-key': crypto.randomUUID(),
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

function heading(n, title) {
  console.log('\n=== ' + n + '. ' + title + ' ===');
}

(async () => {
  heading(1, 'Health check');
  {
    const r = await jfetch(BASE + '/health/live');
    console.log('Status:', r.status, '| Body:', JSON.stringify(r.body));
  }

  heading(2, 'Create API key');
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

  // ============================================================
  // CBE
  // ============================================================

  heading(3, 'CBE - Verify by SMS');
  if (FIXTURES.cbe && FIXTURES.cbe.smsText) {
    const r = await verifyAndPoll(
      { bank: 'cbe', referenceNumber: FIXTURES.cbe.smsText },
      key,
    );
    console.log('Status:', r.status);
    console.log(JSON.stringify(r.body, null, 2));
  } else {
    console.log('skipped (no fixture)');
  }

  heading(4, 'CBE - Verify by reference + suffix');
  if (FIXTURES.cbe && FIXTURES.cbe.referenceNumber) {
    const r = await verifyAndPoll(
      {
        bank: 'cbe',
        referenceNumber: FIXTURES.cbe.referenceNumber,
        accountSuffix: FIXTURES.cbe.accountSuffix,
      },
      key,
    );
    console.log('Status:', r.status);
    console.log(JSON.stringify(r.body, null, 2));
  } else {
    console.log('skipped (no fixture)');
  }

  // ============================================================
  // Telebirr
  // ============================================================

  heading(5, 'Telebirr - Verify by SMS');
  if (FIXTURES.telebirr && FIXTURES.telebirr.smsText) {
    const r = await verifyAndPoll(
      { bank: 'telebirr', referenceNumber: FIXTURES.telebirr.smsText },
      key,
    );
    console.log('Status:', r.status);
    console.log(JSON.stringify(r.body, null, 2));
  } else {
    console.log('skipped (no fixture)');
  }

  heading(6, 'Telebirr - Verify by transaction number');
  if (FIXTURES.telebirr && FIXTURES.telebirr.referenceNumber) {
    const r = await verifyAndPoll(
      { bank: 'telebirr', referenceNumber: FIXTURES.telebirr.referenceNumber },
      key,
    );
    console.log('Status:', r.status);
    console.log(JSON.stringify(r.body, null, 2));
    if (r.body && r.body.data && r.body.data[0] && r.body.data[0].geoBlocked) {
      console.log('\n>>> Geo-blocked (expected outside Ethiopian network).');
    }
  } else {
    console.log('skipped (no fixture)');
  }

  // ============================================================
  // BOA
  // ============================================================

  heading(7, 'BOA - Verify by reference + suffix');
  if (FIXTURES.boa && FIXTURES.boa.referenceNumber) {
    const r = await verifyAndPoll(
      {
        bank: 'boa',
        referenceNumber: FIXTURES.boa.referenceNumber,
        accountSuffix: FIXTURES.boa.accountSuffix,
      },
      key,
    );
    console.log('Status:', r.status);
    console.log(JSON.stringify(r.body, null, 2));
  } else {
    console.log('skipped (no fixture)');
  }

  // ============================================================
  // Dashen
  // ============================================================

  heading(8, 'Dashen - Verify by reference');
  if (FIXTURES.dashen && FIXTURES.dashen.referenceNumber) {
    const r = await verifyAndPoll(
      { bank: 'dashen', referenceNumber: FIXTURES.dashen.referenceNumber },
      key,
    );
    console.log('Status:', r.status);
    console.log(JSON.stringify(r.body, null, 2));
  } else {
    console.log('skipped (no fixture)');
  }

  // ============================================================
  // M-Pesa
  // ============================================================

  heading(9, 'M-Pesa - Verify by transaction id');
  if (FIXTURES.mpesa && FIXTURES.mpesa.referenceNumber) {
    const r = await verifyAndPoll(
      { bank: 'mpesa', referenceNumber: FIXTURES.mpesa.referenceNumber },
      key,
    );
    console.log('Status:', r.status);
    console.log(JSON.stringify(r.body, null, 2));
    if (r.body && r.body.data && r.body.data[0] && r.body.data[0].geoBlocked) {
      console.log('\n>>> Geo-blocked (expected outside Ethiopian network).');
    }
  } else {
    console.log('skipped (no fixture)');
  }

  heading(10, 'M-Pesa - Verify by SMS');
  if (FIXTURES.mpesa && FIXTURES.mpesa.smsText) {
    const r = await verifyAndPoll(
      { bank: 'mpesa', referenceNumber: FIXTURES.mpesa.smsText },
      key,
    );
    console.log('Status:', r.status);
    console.log(JSON.stringify(r.body, null, 2));
  } else {
    console.log('skipped (no fixture)');
  }

  console.log('\n=== Done ===');
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});