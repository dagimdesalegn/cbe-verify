require('tsx/cjs');
const { fetchCbeReceipt } = require('./src/services/cbeScraper.ts');

async function main() {
  const arg = process.argv[2];
  const suffix = process.argv[3];
  if (!arg) {
    console.log('Usage: node test-scraper.js "<ref|url|sms>" [suffix]');
    process.exit(1);
  }
  console.log('Input:', arg.slice(0, 120) + (arg.length > 120 ? '...' : ''));
  console.log('Suffix:', suffix ?? '(none)');
  const start = Date.now();
  try {
    const result = await fetchCbeReceipt(arg, suffix);
    console.log('\n=== RESULT (' + (Date.now() - start) + 'ms) ===');
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error('\n=== ERROR ===');
    console.error(e?.stack ?? e);
  }
  process.exit(0);
}

main();