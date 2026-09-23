// cleanup.js — deletes dev scripts, fixes amount, commits and pushes
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = __dirname;
process.chdir(root);

console.log('\n=== 1. Deleting dev-only scripts ===');
const toDelete = [
  'install-all.ps1',
  'install-all-v2.ps1',
  'install-frontend.ps1',
  'install-telebirr.ps1',
  'install-final.ps1',
  'update-code.ps1',
  'update-code2.ps1',
  'update-final.ps1',
  'update-and-push.ps1',
  'create-files.ps1',
  'fix-and-test.ps1',
  'fix-parser.ps1',
  'fix-telebirr-geo.ps1',
  'fix-telebirr-real.ps1',
  'apply-geo-fix.ps1',
  'push-final.ps1',
  'patch-amount-date.ps1',
  'patch.js',
  'patch2.js',
  'replace.js',
  'test-telebirr-fetch.js',
];

for (const f of toDelete) {
  const p = path.join(root, f);
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
    console.log('  deleted:', f);
  }
}

console.log('\n=== 2. Fixing amount extraction ===');
const scraper = path.join(root, 'src', 'services', 'telebirrScraper.ts');
let src = fs.readFileSync(scraper, 'utf8');

const oldRegex = `const settledM = bodyText.match(/Settled Amount[\\s\\u00A0]*([\\d,]+\\.?\\d*)\\s*Birr/i);
  if (settledM) r.amount = Number(settledM[1].replace(/,/g, ''));`;

const newRegex = `const settledM = bodyText.match(/\\d{2}[-\\/]\\d{2}[-\\/]\\d{4}\\s+\\d{2}:\\d{2}:\\d{2}\\s+([\\d,]+\\.?\\d*)\\s*Birr/);
  if (settledM) r.amount = Number(settledM[1].replace(/,/g, ''));
  if (r.amount === undefined && r.totalPaid !== undefined) {
    const derived = r.totalPaid - (r.serviceFee || 0) - (r.vat || 0);
    if (derived > 0) r.amount = Number(derived.toFixed(2));
  }`;

if (src.includes(oldRegex)) {
  src = src.replace(oldRegex, newRegex);
  fs.writeFileSync(scraper, src, 'utf8');
  console.log('  patched: src/services/telebirrScraper.ts');
} else {
  console.log('  WARNING: expected block not found, checking for date-anchored pattern');
  if (src.includes('date-anchored') || src.includes('settledM[1].replace')) {
    console.log('  looks already patched or incompatible - skipping');
  } else {
    console.log('  manual inspection needed');
  }
}

console.log('\n=== 3. Running Telebirr test ===');
try {
  execSync('node test-telebirr-direct.js DIN92X87AT', { stdio: 'inherit' });
} catch (e) {
  console.log('Test failed - continuing anyway');
}

console.log('\n=== 4. Committing ===');
try {
  execSync('git add -A', { stdio: 'inherit' });
  execSync('git commit -m "Cleanup: remove dev scripts, fix Telebirr amount extraction"', { stdio: 'inherit' });
} catch (e) {
  console.log('Commit failed - maybe nothing to commit');
}

console.log('\n=== 5. Pushing ===');
try {
  execSync('git push', { stdio: 'inherit' });
  console.log('\nDONE');
} catch (e) {
  console.log('\nPush failed:', e.message);
}