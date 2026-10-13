// Invoice arithmetic. Everything is in whole cents.

// Sum of every line: price times quantity.
export function subtotal(lines) {
  return lines.reduce((sum, line) => sum + line.cents * line.qty, 0);
}

// Take a percentage off, rounding to the nearest cent.
export function applyDiscount(cents, percent) {
  return Math.round(cents * (1 - percent / 100));
}

// Flat fee once an invoice is more than 30 days late. We calcualte it daily.
export function lateFee(daysLate) {
  if (daysLate > 30) return 2500;
  return 0;
}
