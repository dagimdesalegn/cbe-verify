// make-fixtures.js — writes test-fixtures.json with the data used during dev
const fs = require('fs');
const path = require('path');

const fixtures = {
  cbe: {
    smsText:
      'Dear Dagim Desalegn You have successfully transferred ETB1.00 from account 1********7333 to account 1********3794 (Abdulmejid Sehab Mohammed). Service charge of ETB 0.50 and VAT(15%) of ETB0.08 and Disaster Recovery(5%) of 0.03 with total of ETB1.61 .Your current balance is ETB3,338.74. Thanks for Banking with CBE. https://mbreciept.cbe.com.et/v2-hfHCxHaJXg7XVz9GQAvs',
    referenceNumber: 'FT26262VQ6GV',
    accountSuffix: '35207333',
    receiptUrl: 'https://mbreciept.cbe.com.et/v2-hfHCxHaJXg7XVz9GQAvs'
  },
  telebirr: {
    smsText:
      'Dear Dagim You have transferred ETB 1.00 to bertukan desalegn (2519****6052) on 23/09/2026 20:07:03. Your transaction number is DIN92X87AT. The service fee is ETB 0.87 and 15% VAT on the service fee is ETB 0.13. Your current E-Money Account balance is ETB 14.63. To download your payment information please click this link: https://transactioninfo.ethiotelecom.et/receipt/DIN92X87AT. Thank you for using telebirr',
    referenceNumber: 'DIN92X87AT',
    receiptUrl: 'https://transactioninfo.ethiotelecom.et/receipt/DIN92X87AT'
  }
};

const target = path.join(__dirname, 'test-fixtures.json');
fs.writeFileSync(target, JSON.stringify(fixtures, null, 2), 'utf8');
console.log('Wrote:', target);
console.log('');
console.log('--- CBE ---');
console.log('  referenceNumber:', fixtures.cbe.referenceNumber);
console.log('  accountSuffix:  ', fixtures.cbe.accountSuffix);
console.log('--- Telebirr ---');
console.log('  referenceNumber:', fixtures.telebirr.referenceNumber);
console.log('');
console.log('Note: these are dev fixtures. CBE/Telebirr may have expired them.');
console.log('If tests fail with "not_found", replace with fresh SMS from your phone.');