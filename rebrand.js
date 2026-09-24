const fs = require('fs');
const path = require('path');

function replace(file, replacements) {
  const full = path.join(__dirname, file);
  if (!fs.existsSync(full)) return;
  let s = fs.readFileSync(full, 'utf8');
  for (const [from, to] of replacements) {
    s = s.split(from).join(to);
  }
  fs.writeFileSync(full, s, 'utf8');
  console.log('  updated:', file);
}

replace('package.json', [
  ['"name": "cbe-verify-api"', '"name": "ethio-pay-verify"'],
  ['"description": "Ethiopian bank payment verification API"', '"description": "Verify Ethiopian payments from CBE, Telebirr, BOA, Dashen, M-Pesa"'],
  ['"repository": {"type": "git", "url": "https://github.com/dagimdesalegn/cbe-verify.git"}', '"repository": {"type": "git", "url": "https://github.com/dagimdesalegn/ethio-pay-verify.git"}'],
]);

replace('sdks/typescript/package.json', [
  ['"name": "@cbe-verify/sdk"', '"name": "ethio-pay-verify"'],
  ['"description": "Official TypeScript SDK for Ethiopian payment verification"', '"description": "Official TypeScript SDK for Ethiopian payment verification (CBE, Telebirr, BOA, Dashen, M-Pesa)"'],
  ['"Homepage = \\"https://github.com/dagimdesalegn/cbe-verify\\""', '"Homepage = \\"https://github.com/dagimdesalegn/ethio-pay-verify\\""'],
]);

replace('sdks/typescript/README.md', [
  ['@cbe-verify/sdk', 'ethio-pay-verify'],
  ['cbe-verify', 'ethio-pay-verify'],
  ['Ethiopian Payment Verification API](https://github.com/dagimdesalegn/cbe-verify)', 'Ethiopian Payment Verification API](https://github.com/dagimdesalegn/ethio-pay-verify)'],
]);

replace('sdks/python/pyproject.toml', [
  ['name = "cbe-verify"', 'name = "ethio-pay-verify"'],
  ['description = "Official Python SDK for the Ethiopian Payment Verification API"', 'description = "Official Python SDK for Ethiopian payment verification (CBE, Telebirr, BOA, Dashen, M-Pesa)"'],
  ['Homepage = "https://github.com/dagimdesalegn/cbe-verify"', 'Homepage = "https://github.com/dagimdesalegn/ethio-pay-verify"'],
]);

replace('sdks/python/README.md', [
  ['cbe-verify (Python SDK)', 'ethio-pay-verify (Python SDK)'],
  ['pip install cbe-verify', 'pip install ethio-pay-verify'],
  ['from cbe_verify import', 'from ethio_pay_verify import'],
  ['https://github.com/dagimdesalegn/cbe-verify', 'https://github.com/dagimdesalegn/ethio-pay-verify'],
]);

// Rename Python package folder
const oldPkg = path.join(__dirname, 'sdks', 'python', 'cbe_verify');
const newPkg = path.join(__dirname, 'sdks', 'python', 'ethio_pay_verify');
if (fs.existsSync(oldPkg)) {
  fs.renameSync(oldPkg, newPkg);
  console.log('  renamed: sdks/python/cbe_verify -> ethio_pay_verify');
}

replace('docker-compose.yml', [
  ['container_name: cbe-verify-api', 'container_name: ethio-pay-verify-api'],
  ['container_name: cbe-verify-nginx', 'container_name: ethio-pay-verify-nginx'],
  ['container_name: cbe-verify-relay', 'container_name: ethio-pay-verify-relay'],
]);

replace('Dockerfile', [
  ['# cbe-verify-api', '# ethio-pay-verify'],
]);

// Update main README if it exists
replace('README.md', [
  ['# CBE Verify — Ethiopian Payment Verification API', '# Ethio Pay Verify\n\nEthiopian payment verification API — supports **CBE, Telebirr, Bank of Abyssinia, Dashen Bank, and M-Pesa**.'],
  ['# CBE Verify', '# Ethio Pay Verify'],
  ['cbe-verify', 'ethio-pay-verify'],
]);

console.log('\nDone. Files rebranded.');
console.log('\nManual steps remaining:');
console.log('  1. Rename the GitHub repo: cbe-verify -> ethio-pay-verify');
console.log('  2. Update GitHub repo description');
console.log('  3. Push these changes');