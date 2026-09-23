require('tsx/cjs');
const { fetchTelebirrReceipt } = require('./src/services/telebirrScraper.ts');
const fs = require('fs');

(async () => {
  const ref = process.argv[2] || 'DIN92X87AT';
  console.log('Testing Telebirr receipt:', ref);
  const start = Date.now();
  const result = await fetchTelebirrReceipt(ref);
  console.log('\n=== RESULT (' + (Date.now() - start) + 'ms) ===');
  console.log(JSON.stringify(result, null, 2));

  const f = './debug-receipts/telebirr_' + ref + '.html';
  if (fs.existsSync(f)) {
    const html = fs.readFileSync(f, 'utf8');
    console.log('\n=== HTML saved: ' + html.length + ' bytes ===');
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    console.log('First 1500 chars of visible text:');
    console.log(text.slice(0, 1500));
  }
  process.exit(0);
})().catch(e => { console.error('FATAL:', e?.stack ?? e); process.exit(1); });