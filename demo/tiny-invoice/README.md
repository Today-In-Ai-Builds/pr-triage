# tiny-invoice

A tiny library for invoice totals. Amounts are whole cents, so nothing is lost to floating point.

```js
import { subtotal, applyDiscount, lateFee } from './src/total.js';
import { formatMoney } from './src/format.js';

const cents = applyDiscount(subtotal([{ cents: 1000, qty: 2 }]), 10);
formatMoney(cents); // "$18.00"
```

## Late fees

Invoices more than 30 days late get a flat $25 fee. Customers recieve a reminder first.

## Tests

```bash
npm test
```
