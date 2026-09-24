const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

process.chdir(__dirname);

// 1. Delete leftover dev scripts
console.log('\n=== 1. Deleting leftover scripts ===');
const junk = [
  'create-sdks.js', 'create-rest.js', 'sdks-data.txt', 'sdks-data-2.txt',
  'rebrand.js', 'finalize.js', 'clean.js', 'cleanup.js', 'extract-fixtures.js',
  'make-fixtures.js', 'patch.js', 'patch2.js', 'replace.js', 'fix-all.js',
  'test-scraper.js', 'test-telebirr-fetch.js',
  'install-all.ps1', 'install-all-v2.ps1', 'install-frontend.ps1',
  'install-telebirr.ps1', 'install-final.ps1', 'update-code.ps1',
  'update-code2.ps1', 'update-final.ps1', 'update-and-push.ps1',
  'create-files.ps1', 'fix-and-test.ps1', 'fix-parser.ps1',
  'fix-telebirr-geo.ps1', 'fix-telebirr-real.ps1', 'apply-geo-fix.ps1',
  'push-final.ps1', 'patch-amount-date.ps1'
];
for (const f of junk) {
  const p = path.join(__dirname, f);
  if (fs.existsSync(p) && f !== 'finalize.js') {
    try { fs.unlinkSync(p); console.log('  deleted:', f); } catch (e) {}
  }
}

// 2. Write README.md
console.log('\n=== 2. Writing README.md ===');
const readme = `# Ethio Pay Verify

Ethiopian payment verification API — verifies payments from **CBE**, **Telebirr**, **Bank of Abyssinia (BOA)**, **Dashen Bank**, and **M-Pesa**.

Self-hosted REST API. Uses SMS text, reference numbers, or receipt URLs and returns structured JSON with sender, receiver, amount, fees, and reference.

[![npm](https://img.shields.io/npm/v/ethio-pay-verify.svg)](https://www.npmjs.com/package/ethio-pay-verify)

---

## Install the SDK

\`\`\`bash
npm install ethio-pay-verify
\`\`\`

\`\`\`typescript
import { CbeVerifyClient } from 'ethio-pay-verify';

const client = new CbeVerifyClient({
  apiKey: process.env.ETHIO_PAY_VERIFY_KEY!,
  baseUrl: 'https://api.yourdomain.com',
});

// CBE — reference + suffix
const result = await client.verify({
  bank: 'cbe',
  referenceNumber: 'FT26262VQ6GV',
  accountSuffix: '35207333',
});

// BOA — reference + 5-digit suffix
await client.verify({
  bank: 'boa',
  referenceNumber: 'FT26267746ZV',
  accountSuffix: '33067',
});

// Telebirr — SMS text
await client.verify({
  bank: 'telebirr',
  referenceNumber: 'Dear Dagim You have transferred ETB 1.00 ...',
});

// Dashen — reference
await client.verify({
  bank: 'dashen',
  referenceNumber: '169WDTS2626700WH',
});

// M-Pesa — SMS text
await client.verify({
  bank: 'mpesa',
  referenceNumber: 'Dear Dagim, 1.00 ብር ለ... መለያ ቁጥር UIO6P2QVDY ...',
});

if (result.data[0].verified) {
  console.log('Payment confirmed:', result.data[0].amount, result.data[0].currency);
}
\`\`\`

---

## Supported banks

| Bank | Input | Method |
|---|---|---|
| CBE | SMS text | Offline parser |
| CBE | Reference + 8-digit suffix | PDF parser |
| Telebirr | SMS text | Offline parser |
| Telebirr | Transaction number | HTML parser (Ethiopian IP) |
| BOA | Reference + 5-digit suffix | JSON API |
| Dashen | Transaction reference | HTML parser |
| M-Pesa | SMS text | Offline parser |
| M-Pesa | Receipt URL | Requires Ethiopian relay |

---

## Quick start (self-host)

\`\`\`bash
git clone https://github.com/dagimdesalegn/ethio-pay-verify.git
cd ethio-pay-verify
npm install
cp .env.example .env
# Set ADMIN_API_KEY in .env to any strong string
npm run dev
\`\`\`

Server runs on http://localhost:3000.

Open \`http://localhost:3000\` in a browser for the built-in UI.

---

## Create your first API key

\`\`\`bash
curl -X POST http://localhost:3000/api/api-keys \\
  -H "content-type: application/json" \\
  -H "x-api-key: YOUR_ADMIN_KEY" \\
  -d '{"name":"Production"}'
\`\`\`

Save the returned \`key\` — it is shown only once.

---

## API endpoints

| Method | Endpoint | Permission |
|---|---|---|
| GET | /health/live | public |
| POST | /api/api-keys | apikeys:write |
| GET | /api/api-keys | apikeys:read |
| DELETE | /api/api-keys/:id | apikeys:write |
| POST | /api/verify | verification:write |
| GET | /api/verify/:requestId | verification:read |
| GET | /api/verify/:requestId/events | verification:read |
| GET | /api/verify/history | verification:read |

---

## Response shape

\`\`\`json
{
  "success": true,
  "message": "Transaction verified successfully.",
  "data": [{
    "bank": "cbe",
    "status": "success",
    "verified": true,
    "amount": 3000,
    "currency": "ETB",
    "senderName": "Abdulmejid Sehab Mohammed",
    "senderAccount": "1****8064",
    "receiverName": "DAGIM DESALEGN",
    "receiverAccount": "1****7333",
    "referenceNumber": "FT26262VQ6GV",
    "accountSuffix": "35207333",
    "date": "9/19/2026, 6:49:00 PM",
    "reason": "MB Transfer",
    "serviceCharge": 0,
    "vat": 0,
    "totalAmount": 3000,
    "source": "pdf"
  }]
}
\`\`\`

---

## Features

- 5 banks, 9 input methods
- Self-hosted API key system (SHA-256 hashed)
- HMAC-signed webhooks with exponential backoff
- Server-Sent Events for real-time status
- Idempotency, rate limiting, Zod validation
- SQLite with WAL mode — zero external dependencies
- Bundled single-page UI
- **Official npm SDK:** [ethio-pay-verify](https://www.npmjs.com/package/ethio-pay-verify)

---

## Deployment

See [deploy/README.md](deploy/README.md) for a full Docker Compose + Nginx + SSL guide.

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| PORT | 3000 | HTTP listen port |
| ADMIN_API_KEY | — | Bootstrap key |
| CBE_RECEIPT_BASE | https://apps.cbe.com.et:100/ | CBE endpoint |
| CBE_RECEIPT_TIMEOUT_MS | 20000 | Upstream fetch timeout |
| CBE_ALLOW_INSECURE_TLS | true | Accept CBE self-signed certs |
| WEBHOOK_SIGNING_SECRET | — | HMAC secret |
| DB_PATH | ./data/verify.db | SQLite path |
| TELEBIRR_PROXY_URL | — | Ethiopian relay for Telebirr/M-Pesa URLs |
| TELEBIRR_FETCH_TIMEOUT_MS | 15000 | Telebirr fetch timeout |

---

## License

MIT

## Disclaimer

Not affiliated with or endorsed by any of the banks listed. Parses publicly accessible receipt data. Use responsibly.
`;
fs.writeFileSync('README.md', readme, 'utf8');
console.log('  wrote: README.md');

// 3. Update package.json description
console.log('\n=== 3. Updating package.json ===');
const pkgPath = 'package.json';
if (fs.existsSync(pkgPath)) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.name = 'ethio-pay-verify-api';
  pkg.description = 'Ethiopian payment verification API — CBE, Telebirr, BOA, Dashen, M-Pesa';
  pkg.repository = { type: 'git', url: 'https://github.com/dagimdesalegn/ethio-pay-verify.git' };
  pkg.keywords = ['ethiopia', 'cbe', 'telebirr', 'boa', 'dashen', 'mpesa', 'payment-verification', 'fintech', 'api'];
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log('  updated: package.json');
}

// 4. Git commit and push
console.log('\n=== 4. Git add + commit + push ===');
try {
  execSync('git add -A', { stdio: 'inherit' });
  execSync('git commit -m "Update README with SDK, publish npm package ethio-pay-verify, cleanup scripts"', { stdio: 'inherit' });
  execSync('git push', { stdio: 'inherit' });
  console.log('\nDONE');
} catch (e) {
  console.log('\nGit error:', e.message);
}