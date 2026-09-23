// test-telebirr-direct.js - calls the scraper directly
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
  console.log('\n=== RESULT (' + (Date.now() - start) + 'ms) ===');
  console.log(JSON.stringify(result, null, 2));

  const f = './debug-receipts/telebirr_' + ref + '.html';
  if (fs.existsSync(f)) {
    const html = fs.readFileSync(f, 'utf8');
    console.log('\n=== HTML saved: ' + html.length + ' bytes ===');
  }
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e?.stack ?? e); process.exit(1); });
