import { describe, it, expect } from 'vitest';
import { checkInvoiceTotal, formatCentsUsd, storedTotalSourceLabel } from './invoiceReconcile';

/**
 * The lines-versus-total disagreement check.
 *
 * The states exercised below are REACHABLE, not hypothetical:
 * `mytribe/firestore.rules:219-226` grants `allow update: if isAuntie()` over
 * the whole invoices collection, and `postInvoiceEvent` merges an arbitrary
 * payload. Both bypass every callable, so a stored total genuinely can drift
 * away from the sum of the lines beside it.
 */
describe('checkInvoiceTotal', () => {
  const twoLines = [
    { description: 'Dog walk', qty: 3, unitCents: 2500 },
    { description: 'Stay', qty: 1, unitCents: 8000, discountCents: 500 },
  ];
  // 7500 + 7500 = 15000

  it('reports an un-itemized invoice as NOT a disagreement', () => {
    // Every invoice created before Task 5.1 is in this state. Flagging it would
    // put an error banner on the entire collection.
    const check = checkInvoiceTotal({ total: 40 });
    expect(check.itemized).toBe(false);
    expect(check.disagrees).toBe(false);
  });

  it('treats a non-array lineItems as un-itemized rather than as empty', () => {
    expect(checkInvoiceTotal({ lineItems: 'two walks', total: 40 }).itemized).toBe(false);
    expect(checkInvoiceTotal({ lineItems: null, total: 40 }).itemized).toBe(false);
  });

  it('agrees when totalCents matches the sum of the lines', () => {
    const check = checkInvoiceTotal({ lineItems: twoLines, totalCents: 15000, total: 150 });
    expect(check.disagrees).toBe(false);
    expect(check.derivedTotalCents).toBe(15000);
    expect(check.storedTotalCents).toBe(15000);
    expect(check.storedFrom).toBe('totalCents');
  });

  it('DISAGREES when the stored totalCents was changed out from under the lines', () => {
    const check = checkInvoiceTotal({ lineItems: twoLines, totalCents: 4000, total: 40 });
    expect(check.disagrees).toBe(true);
    expect(check.derivedTotalCents).toBe(15000);
    expect(check.storedTotalCents).toBe(4000);
  });

  it('reports BOTH figures so a banner can name both and reconcile neither', () => {
    const check = checkInvoiceTotal({ lineItems: twoLines, totalCents: 4000 });
    expect(formatCentsUsd(check.derivedTotalCents)).toBe('$150.00');
    expect(formatCentsUsd(check.storedTotalCents!)).toBe('$40.00');
  });

  it('subtracts an invoice-level discount before comparing', () => {
    const check = checkInvoiceTotal({
      lineItems: twoLines,
      invoiceDiscountCents: 2000,
      totalCents: 13000,
    });
    expect(check.derivedTotalCents).toBe(13000);
    expect(check.disagrees).toBe(false);
  });

  it('falls back to the legacy dollar total when totalCents is absent', () => {
    // The case most worth catching: an invoice edited outside the callables can
    // carry a changed `total` and no `totalCents` at all.
    const check = checkInvoiceTotal({ lineItems: twoLines, total: 40 });
    expect(check.storedFrom).toBe('total');
    expect(check.storedTotalCents).toBe(4000);
    expect(check.disagrees).toBe(true);
  });

  it('prefers the exact totalCents over the rounded dollar projection', () => {
    const check = checkInvoiceTotal({ lineItems: twoLines, totalCents: 15000, total: 999 });
    expect(check.storedFrom).toBe('totalCents');
    expect(check.disagrees).toBe(false);
  });

  it('compares in integers, so a float artifact never reads as real drift', () => {
    // 0.1 + 0.2 arithmetic in the dollar domain is exactly what this avoids.
    const check = checkInvoiceTotal({
      lineItems: [{ description: 'x', qty: 3, unitCents: 1010 }],
      total: 30.3,
    });
    expect(check.derivedTotalCents).toBe(3030);
    expect(check.storedTotalCents).toBe(3030);
    expect(check.disagrees).toBe(false);
  });

  it('is not a disagreement when the doc asserts no readable total at all', () => {
    const check = checkInvoiceTotal({ lineItems: twoLines });
    expect(check.itemized).toBe(true);
    expect(check.storedTotalCents).toBeNull();
    expect(check.disagrees).toBe(false);
  });

  it('reads a non-finite stored total as no reading, never as zero', () => {
    const check = checkInvoiceTotal({ lineItems: twoLines, totalCents: Number.NaN, total: Number.NaN });
    expect(check.storedTotalCents).toBeNull();
    expect(check.disagrees).toBe(false);
  });

  it('an empty lineItems array IS itemized, and disagrees with a non-zero total', () => {
    // "Itemized as billing nothing" is a real claim, distinct from never having
    // been itemized, and a $40 total beside zero lines is exactly the drift this
    // check is for.
    const check = checkInvoiceTotal({ lineItems: [], total: 40 });
    expect(check.itemized).toBe(true);
    expect(check.derivedTotalCents).toBe(0);
    expect(check.disagrees).toBe(true);
  });

  it('skips a malformed line rather than throwing on it', () => {
    const check = checkInvoiceTotal({
      lineItems: [{ description: 'Good', qty: 1, unitCents: 100 }, null, { description: 'No qty' }],
      totalCents: 100,
    });
    expect(check.derivedTotalCents).toBe(100);
    expect(check.disagrees).toBe(false);
  });

  it('treats a missing per-line discountCents as zero', () => {
    const check = checkInvoiceTotal({
      lineItems: [{ description: 'x', qty: 2, unitCents: 500 }],
      totalCents: 1000,
    });
    expect(check.disagrees).toBe(false);
  });
});

describe('formatCentsUsd', () => {
  it('formats integer cents as dollars', () => {
    expect(formatCentsUsd(0)).toBe('$0.00');
    expect(formatCentsUsd(15000)).toBe('$150.00');
    expect(formatCentsUsd(-1250)).toBe('-$12.50');
  });

  it('reads a non-finite figure as zero rather than rendering $NaN to an operator', () => {
    expect(formatCentsUsd(Number.NaN)).toBe('$0.00');
  });
});

describe('storedTotalSourceLabel', () => {
  it('names where the stored figure came from, in both cases', () => {
    expect(storedTotalSourceLabel('totalCents')).toContain('stored on the invoice');
    expect(storedTotalSourceLabel('total')).toContain('legacy dollar field');
  });
});
