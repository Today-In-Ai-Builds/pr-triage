import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subtotal, applyDiscount, lateFee } from '../src/total.js';
import { formatMoney } from '../src/format.js';

test('subtotal multiplies price by quantity', () => {
  assert.equal(subtotal([{ cents: 1000, qty: 2 }, { cents: 250, qty: 1 }]), 2250);
});

test('a 10% discount takes 10% off', () => {
  assert.equal(applyDiscount(2000, 10), 1800);
});

test('no late fee until the invoice is more than 30 days late', () => {
  assert.equal(lateFee(30), 0);
  assert.equal(lateFee(31), 2500);
});

test('money is formatted with two decimals', () => {
  assert.equal(formatMoney(123450), '$1234.50');
  assert.equal(formatMoney(-5), '-$0.05');
});
