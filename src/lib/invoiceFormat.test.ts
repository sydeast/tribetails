import { describe, it, expect } from 'vitest';
import {
  formatUsd,
  humanizeDate,
  invoiceState,
  invoiceStateInfo,
  isInvoiceOverdue,
  isoDatePrefixOrNull,
  localDateIso,
  type InvoiceStateInput,
} from './invoiceFormat';

function row(over: Partial<InvoiceStateInput>): InvoiceStateInput {
  return { status: '', amountDue: 0, total: 0, creditRedeemed: false, ...over };
}

describe('invoiceState with a missing status field', () => {
  // Found by driving the LIVE app 2026-07-20. `row.status.trim()` threw
  // "Cannot read properties of undefined (reading 'trim')" and the error
  // boundary blanked the ENTIRE invoices page, because the seeded sandbox
  // invoices carry the legacy `invoiceStatus` spelling and no `status`.
  //
  // One malformed document must never take the whole screen down. Same
  // blast-radius lesson as Firestore's toObjects: degrade the row, not the page.
  const noStatus = (over: Partial<InvoiceStateInput>): InvoiceStateInput =>
    ({ ...row(over), status: undefined as unknown as string });

  it('does not throw when status is absent', () => {
    expect(() => invoiceState(noStatus({ amountDue: 45, total: 45 }))).not.toThrow();
  });

  it('still classifies from the money fields when status is absent', () => {
    expect(invoiceState(noStatus({ amountDue: 45, total: 45 }))).toBe('open');
    expect(invoiceState(noStatus({ amountDue: 0, total: 60 }))).toBe('paid');
    expect(invoiceState(noStatus({ amountDue: -20, total: -20 }))).toBe('credit');
  });

  it('treats null the same as absent', () => {
    expect(invoiceState({ ...row({ amountDue: 0, total: 60 }), status: null as unknown as string })).toBe('paid');
  });
});

describe('invoiceState (AO-12 regression guard: enumerated, never paid-by-negation)', () => {
  it('an explicit "credit" status with no redemption stamp classifies as credit, never paid', () => {
    expect(invoiceState(row({ status: 'credit', amountDue: -20, total: -20 }))).toBe('credit');
  });

  it('THE AO-12 CASE: an unredeemed credit must never render as paid, even though it has no outstanding positive balance', () => {
    const unredeemedCredit = row({ status: 'credit', amountDue: -20, total: -20, creditRedeemed: false });
    expect(invoiceState(unredeemedCredit)).not.toBe('paid');
    expect(invoiceState(unredeemedCredit)).toBe('credit');
  });

  it('a credit becomes "redeemed" only once creditRedeemed is true', () => {
    expect(invoiceState(row({ status: 'credit', amountDue: -20, total: -20, creditRedeemed: true }))).toBe(
      'redeemed',
    );
  });

  it('a negative amountDue or total is read as credit even without the explicit label', () => {
    expect(invoiceState(row({ status: '', amountDue: -5, total: 0 }))).toBe('credit');
    expect(invoiceState(row({ status: 'open', amountDue: 0, total: -5 }))).toBe('credit');
  });

  it('draft, quote, cancelled, and explicit paid are read directly off status', () => {
    expect(invoiceState(row({ status: 'draft' }))).toBe('draft');
    expect(invoiceState(row({ status: 'Quote' }))).toBe('quote');
    expect(invoiceState(row({ status: ' CANCELLED ' }))).toBe('cancelled');
    expect(invoiceState(row({ status: 'paid', amountDue: 0, total: 40 }))).toBe('paid');
  });

  it('a positive amountDue is open, regardless of total', () => {
    expect(invoiceState(row({ status: '', amountDue: 40, total: 40 }))).toBe('open');
  });

  it('a $0 invoice (nothing billed) is "zero", not a fabricated "paid"', () => {
    expect(invoiceState(row({ status: '', amountDue: 0, total: 0 }))).toBe('zero');
  });

  it('amountDue settled (<=0) with a real positive total is paid, a positive read of the retired balance', () => {
    expect(invoiceState(row({ status: '', amountDue: 0, total: 40 }))).toBe('paid');
  });

  it('a non-finite amountDue/total is treated as no evidence (0), never as NaN-poisoned comparisons', () => {
    expect(invoiceState(row({ status: '', amountDue: NaN, total: NaN }))).toBe('zero');
    // Infinity reads as "no amountDue evidence" (0), not as ">0"; with a real
    // positive total and nothing owed, that is the settled/paid signal.
    expect(invoiceState(row({ status: '', amountDue: Infinity, total: 40 }))).toBe('paid');
  });

  it('status is read case-insensitively and trimmed', () => {
    expect(invoiceState(row({ status: '  DrAfT  ' }))).toBe('draft');
  });
});

describe('invoiceStateInfo', () => {
  it.each([
    ['quote', 'Quote', 'QUOTE', 'quote'],
    ['draft', 'Draft', 'DRAFT', 'draft'],
    ['cancelled', 'Cancelled', 'CANCELLED', 'cancelled'],
    ['credit', 'Credit', 'CREDIT', 'credit'],
    ['redeemed', 'Redeemed', 'REDEEMED', 'redeemed'],
    ['paid', 'Paid', 'PAID', 'paid'],
    ['zero', 'Zero balance', 'ZERO', 'zero'],
    ['open', 'Open', 'OPEN', 'open'],
  ] as const)('%s -> label %s / chip %s / css %s', (state, label, chipLabel, cssClass) => {
    expect(invoiceStateInfo(state)).toEqual({ label, chipLabel, cssClass });
  });
});

describe('formatUsd', () => {
  it('formats positive, negative, and zero amounts', () => {
    expect(formatUsd(36)).toBe('$36.00');
    expect(formatUsd(-12.5)).toBe('-$12.50');
    expect(formatUsd(0)).toBe('$0.00');
  });

  it('never throws on non-finite input', () => {
    expect(formatUsd(NaN)).toBe('$0.00');
  });
});

describe('isoDatePrefixOrNull', () => {
  it('accepts a leading ISO date, with or without a time suffix', () => {
    expect(isoDatePrefixOrNull('2026-06-07')).toBe('2026-06-07');
    expect(isoDatePrefixOrNull('2026-06-07T12:00:00Z')).toBe('2026-06-07');
  });

  it('returns null for free text that is not ISO-shaped', () => {
    expect(isoDatePrefixOrNull('Net 14')).toBeNull();
    expect(isoDatePrefixOrNull('')).toBeNull();
  });
});

describe('humanizeDate', () => {
  it('formats a parseable date without zero-padding the day', () => {
    expect(humanizeDate('2026-06-02T12:00:00Z')).toBe('Jun 2');
  });

  it('echoes the raw text when unparseable, rather than hiding it', () => {
    expect(humanizeDate('Net 14')).toBe('Net 14');
  });

  it('appends the year only when it differs from the reference (no silent wrong-year)', () => {
    // Same year as the reference: bare month/day.
    expect(humanizeDate('2026-05-21', '2026-07-16')).toBe('May 21');
    // Prior year: the year is shown so it never reads as this year.
    expect(humanizeDate('2025-05-21', '2026-07-16')).toBe('May 21, 2025');
    // No reference: back-compat, bare month/day.
    expect(humanizeDate('2025-05-21')).toBe('May 21');
  });
});

describe('isInvoiceOverdue', () => {
  it('true only for an open invoice whose dueDate is strictly before today', () => {
    expect(isInvoiceOverdue('open', '2026-07-01', '2026-07-16')).toBe(true);
  });

  it('false for a future or same-day dueDate', () => {
    expect(isInvoiceOverdue('open', '2026-07-16', '2026-07-16')).toBe(false);
    expect(isInvoiceOverdue('open', '2026-08-01', '2026-07-16')).toBe(false);
  });

  it('false for an unparseable dueDate, never fabricates an overdue verdict', () => {
    expect(isInvoiceOverdue('open', 'Net 14', '2026-07-16')).toBe(false);
  });

  it('false for any non-open state, even a stale-looking dueDate, a draft/quote/credit/paid invoice is never "overdue"', () => {
    expect(isInvoiceOverdue('draft', '2020-01-01', '2026-07-16')).toBe(false);
    expect(isInvoiceOverdue('quote', '2020-01-01', '2026-07-16')).toBe(false);
    expect(isInvoiceOverdue('paid', '2020-01-01', '2026-07-16')).toBe(false);
    expect(isInvoiceOverdue('credit', '2020-01-01', '2026-07-16')).toBe(false);
  });
});

describe('localDateIso', () => {
  it('renders the LOCAL calendar date, not a UTC one (does not reproduce AO-18)', () => {
    // 2026-07-16T23:30 local time must read as the 16th locally regardless of
    // what UTC date that instant falls on.
    const localMidnightish = new Date(2026, 6, 16, 23, 30, 0);
    expect(localDateIso(localMidnightish)).toBe('2026-07-16');
  });

  it('zero-pads month and day', () => {
    expect(localDateIso(new Date(2026, 0, 5, 10, 0, 0))).toBe('2026-01-05');
  });
});
