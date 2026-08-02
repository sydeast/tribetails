import { describe, it, expect } from 'vitest';
import {
  formatUsd,
  humanizeDate,
  invoiceStateInfo,
  isInvoiceOverdue,
  invoiceActionsFor,
  invoiceDaysOverdue,
  invoicePartialPayment,
  isoDatePrefixOrNull,
  localDateIso,
  unstampedStateInfo,
} from './invoiceFormat';
import { INVOICE_STATES, type InvoiceState } from '../api/invoices';

/**
 * NOTE ON WHAT THIS FILE NO LONGER TESTS. The `invoiceState` classifier (and
 * its AO-12 regression table) lived here until ADR-0002 moved classification
 * to the server, which persists its verdict onto every doc as `status` +
 * `editScope`. The classifier and its tests moved WITH the authority: the
 * precedence table is asserted in `mytribe/functions`' own suite, and this app
 * only renders the stored state (see api/invoices.test.ts#invoiceStamp for the
 * read side, and the Invoices/InvoiceDetail component tests for stored field
 * in -> rendered affordance out).
 */

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

  it('covers every stamped state the wire type declares', () => {
    // The switch is total by construction; this pins that the it.each table
    // above stays in step with the union rather than silently shrinking.
    for (const state of INVOICE_STATES) {
      expect(invoiceStateInfo(state).chipLabel.length).toBeGreaterThan(0);
    }
  });
});

describe('unstampedStateInfo (the fail-soft chip for a doc with no recognizable stamp)', () => {
  it('renders the raw status text lowercased, claiming nothing', () => {
    expect(unstampedStateInfo('PAID')).toEqual({ label: 'paid', chipLabel: 'PAID', cssClass: 'unknown' });
    expect(unstampedStateInfo('  Sent  ')).toEqual({ label: 'sent', chipLabel: 'SENT', cssClass: 'unknown' });
  });

  it('says Unknown when even the raw text is blank or absent', () => {
    expect(unstampedStateInfo('')).toEqual({ label: 'Unknown', chipLabel: 'UNKNOWN', cssClass: 'unknown' });
    expect(unstampedStateInfo(undefined)).toEqual({ label: 'Unknown', chipLabel: 'UNKNOWN', cssClass: 'unknown' });
  });

  it('always uses the neutral css class, never a real state chip', () => {
    // 'paid' as raw text must NOT pick up the success-green paid chip: the
    // whole point of the fallback is that it makes no claim about the money.
    expect(unstampedStateInfo('paid').cssClass).toBe('unknown');
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
  it('true only for a stored-open invoice whose dueDate is strictly before today', () => {
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

  it('false for an unstamped doc (null state): no stamp, no overdue verdict', () => {
    expect(isInvoiceOverdue(null, '2020-01-01', '2026-07-16')).toBe(false);
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
describe('invoiceActionsFor', () => {
  it('a paid invoice offers a receipt and NOTHING else (the AO-19 report)', () => {
    expect(invoiceActionsFor('paid')).toEqual(['receipt']);
  });
  it('an open invoice offers the two collection actions, never a receipt', () => {
    expect([...invoiceActionsFor('open')].sort()).toEqual(['markPaid', 'reminder']);
  });
  it('a draft offers review-and-send only', () => {
    expect(invoiceActionsFor('draft')).toEqual(['reviewSend']);
  });
  it('a quote has no payment actions', () => {
    expect(invoiceActionsFor('quote')).toEqual([]);
  });
  it('cancelled, credit, redeemed and zero-balance rows have no actions', () => {
    expect(invoiceActionsFor('cancelled')).toEqual([]);
    expect(invoiceActionsFor('credit')).toEqual([]);
    expect(invoiceActionsFor('redeemed')).toEqual([]);
    expect(invoiceActionsFor('zero')).toEqual([]);
  });
  it('is TOTAL: every stamped state resolves to a set, none throws or returns undefined', () => {
    for (const state of INVOICE_STATES) {
      expect(Array.isArray(invoiceActionsFor(state)), `no action set for '${state}'`).toBe(true);
    }
  });
  it('never overlaps: no state offers both a collection action and a receipt', () => {
    for (const state of INVOICE_STATES) {
      const actions = invoiceActionsFor(state);
      const collecting = actions.includes('markPaid') || actions.includes('reminder');
      expect(collecting && actions.includes('receipt'), `'${state}' offers both`).toBe(false);
    }
  });
  it('overdue is a display refinement of open, so it cannot pick up a different set', () => {
    // isInvoiceOverdue only ever returns true for 'open' (asserted above), so
    // gating on the state alone already covers OVERDUE.
    expect(isInvoiceOverdue('open', '2020-01-01', '2026-07-16')).toBe(true);
    expect(invoiceActionsFor('open')).toContain('markPaid');
  });
});
describe('invoicePartialPayment', () => {
  const open = { amountDue: 20, paidCents: 2000 };
  it('reports what was collected and what is left on a part-paid open invoice', () => {
    expect(invoicePartialPayment('open', open)).toEqual({ paidCents: 2000, remainingCents: 2000 });
  });
  it('is null for an open invoice nobody has paid', () => {
    expect(invoicePartialPayment('open', { amountDue: 40 })).toBeNull();
    expect(invoicePartialPayment('open', { amountDue: 40, paidCents: 0 })).toBeNull();
  });
  it('NEVER INFERS a payment from total minus amountDue', () => {
    // On every invoice the pre-2026-07-25 write touched, amountDue reads 0 while
    // a real balance is owed, so that subtraction reports the whole total as
    // collected on exactly the rows that are wrong. Absent paidCents means we
    // have no record of a payment, and we do not claim one.
    expect(invoicePartialPayment('open', { amountDue: 20 })).toBeNull();
  });
  it('is null for every state other than open, so it can never change an action set', () => {
    const others = INVOICE_STATES.filter((s): s is InvoiceState => s !== 'open');
    for (const state of others) {
      expect(invoicePartialPayment(state, open)).toBeNull();
    }
  });
  it('is null for an unstamped doc (null state): no stamp, no part-paid claim', () => {
    expect(invoicePartialPayment(null, open)).toBeNull();
  });
  it('is null once nothing is left owing, however much was collected', () => {
    expect(invoicePartialPayment('open', { amountDue: 0, paidCents: 4000 })).toBeNull();
  });
  it('ignores a non-integer paidCents rather than rendering a laundered figure', () => {
    expect(invoicePartialPayment('open', { amountDue: 20, paidCents: 20.5 })).toBeNull();
    expect(invoicePartialPayment('open', { amountDue: 20, paidCents: Number.NaN })).toBeNull();
  });
  it('does not change which actions a part-paid invoice may be offered', () => {
    // The guard that keeps collecting the balance possible: part-paid is a
    // display refinement of open, so the outstanding action set is untouched.
    expect(invoiceActionsFor('open')).toContain('markPaid');
  });
});
/**
 * HOW LATE, in days, for the row's meta line and the Overdue card's subline.
 *
 * Gated on `isInvoiceOverdue` rather than re-deriving the verdict, so the number
 * and the chip can never disagree, and null for every case that is not a real
 * dated overdue balance. "0 days overdue" and "NaN days overdue" are both worse
 * than the plain due date the caller falls back to.
 */
describe('invoiceDaysOverdue', () => {
  it('counts whole days past the due date on an open invoice', () => {
    expect(invoiceDaysOverdue('open', '2026-07-04', '2026-07-16')).toBe(12);
  });
  it('answers 1 for an invoice one day late, so the copy can say "1 day"', () => {
    expect(invoiceDaysOverdue('open', '2026-07-15', '2026-07-16')).toBe(1);
  });
  it('answers null on the due date itself: due today is not overdue', () => {
    expect(invoiceDaysOverdue('open', '2026-07-16', '2026-07-16')).toBeNull();
  });
  it('answers null for a future due date', () => {
    expect(invoiceDaysOverdue('open', '2026-08-01', '2026-07-16')).toBeNull();
  });
  it('answers null for every state that is not open, however stale the date', () => {
    for (const state of INVOICE_STATES.filter((s) => s !== 'open')) {
      expect(invoiceDaysOverdue(state, '2020-01-01', '2026-07-16')).toBeNull();
    }
  });
  it('answers null for an unstamped doc rather than guessing from the date', () => {
    expect(invoiceDaysOverdue(null, '2020-01-01', '2026-07-16')).toBeNull();
  });
  it('answers null for a due date that is not a date at all', () => {
    expect(invoiceDaysOverdue('open', 'Net 14', '2026-07-16')).toBeNull();
    expect(invoiceDaysOverdue('open', '', '2026-07-16')).toBeNull();
  });
  it('crosses a month and a year boundary without drifting', () => {
    expect(invoiceDaysOverdue('open', '2025-12-31', '2026-01-01')).toBe(1);
    expect(invoiceDaysOverdue('open', '2026-01-31', '2026-03-01')).toBe(29);
  });
  it('is not shifted by a DST boundary between the two dates', () => {
    // US spring forward 2026-03-08 sits inside this span. Both ends are calendar
    // labels parsed at UTC midnight, so the answer is a whole number of days.
    expect(invoiceDaysOverdue('open', '2026-03-01', '2026-03-15')).toBe(14);
  });
  it('agrees with isInvoiceOverdue on every case it answers a number for', () => {
    const cases = ['2026-07-04', '2026-07-15', '2026-07-16', '2026-08-01', 'Net 14', ''];
    for (const due of cases) {
      const days = invoiceDaysOverdue('open', due, '2026-07-16');
      if (days !== null) expect(isInvoiceOverdue('open', due, '2026-07-16')).toBe(true);
    }
  });
});
