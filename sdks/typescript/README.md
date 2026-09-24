# @cbe-verify/sdk

Official TypeScript/JavaScript SDK for the Ethiopian Payment Verification API.

Verifies payments from CBE, Telebirr, Bank of Abyssinia (BOA), Dashen Bank, and M-Pesa.

## Install

npm install @cbe-verify/sdk

## Usage

```typescript
import { CbeVerifyClient } from '@cbe-verify/sdk';

const client = new CbeVerifyClient({
  apiKey: process.env.CBE_VERIFY_API_KEY!,
  baseUrl: 'http://localhost:3000',
});

const result = await client.verify({
  bank: 'cbe',
  referenceNumber: 'FT26262VQ6GV',
  accountSuffix: '35207333',
});

if (result.data[0].verified) {
  console.log('Confirmed:', result.data[0].amount, result.data[0].currency);
}
