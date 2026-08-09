import { describe, expect, it } from 'vitest';
import {
  ledgerCoversBalance,
  ledgerRowAppliedLabel,
  ledgerRowBalanceCents,
  ledgerRowCaveat,
  ledgerRowTotalCents,
  paymentDayLabel,
  paymentMethodLabel,
  paymentsTotalCents,
  sessionDayLabel,
  sessionServiceLabel,
  sessionStatusLabel,
  sessionsWithBrokenBacklink,
} from './invoiceLedger';
import type {
  GetInvoiceLedgerResultLedgerPayment,
  GetInvoiceLedgerResultSession,
} from '../contracts/invoiceContracts.generated';

function session(over: Partial<GetInvoiceLedgerResultSession> = {}): GetInvoiceLedgerResultSession {
  return {
    sessionId: 's1',
    serviceType: 'Dog walking',
    status: 'COMPLETED',
    startTime: '2026-07-10T14:00:00Z',
    completedAt: null,
    durationMinutes: 30,
    linkedBack: true,
    ...over,
  };
}

describe('paymentDayLabel', () => {
  it('slices the ISO day rather than re-formatting it', () => {
    // A parse-and-reformat would shift the day across a timezone. `paidAt` is
    // written as an ISO instant, so the first ten characters ARE the day.
    expect(paymentDayLabel('2026-07-20T23:30:00Z')).toBe('2026-07-20');
  });

  it('says a payment carries no date rather than rendering a blank', () => {
    expect(paymentDayLabel(null)).toBe('no date recorded');
    expect(paymentDayLabel('')).toBe('no date recorded');
  });
});

describe('paymentMethodLabel', () => {
  it('passes a real method through', () => {
    expect(paymentMethodLabel('check')).toBe('check');
  });

  it('reports a blank method as unrecorded, never as an empty cell or "unknown"', () => {
    // markInvoicePaid stores an explicit null when the operator left it blank.
    // A payment recorded in a hurry is still a payment.
    expect(paymentMethodLabel(null)).toBe('no method recorded');
    expect(paymentMethodLabel('   ')).toBe('no method recorded');
  });
});

describe('sessionDayLabel', () => {
  it('prefers completedAt: when the work FINISHED is what the invoice bills for', () => {
    expect(
      sessionDayLabel({ completedAt: '2026-07-11T02:00:00Z', startTime: '2026-07-10T23:00:00Z' }),
    ).toBe('2026-07-11');
  });

  it('falls back to startTime when the visit was never stamped complete', () => {
    expect(sessionDayLabel({ completedAt: null, startTime: '2026-07-10T14:00:00Z' })).toBe(
      '2026-07-10',
    );
  });

  it('names the unplaceable visit rather than showing a blank', () => {
    // An empty startTime sorts before every real date, so no date window can
    // reach it. That is the shape listUninvoicedSessions reports as `unplaceable`.
    expect(sessionDayLabel({ completedAt: null, startTime: '' })).toBe('no date on the visit');
  });
});

describe('sessionStatusLabel', () => {
  it('opens out the stored SCREAMING_SNAKE for reading', () => {
    expect(sessionStatusLabel('ON_MY_WAY')).toBe('on my way');
    expect(sessionStatusLabel('COMPLETED')).toBe('completed');
  });

  it('normalizes for display only and never folds one spelling onto another', () => {
    // CANCELED and CANCELLED are two things this collection genuinely stores.
    // Mapping them together would be classification, and this panel reports
    // what the visit doc says.
    expect(sessionStatusLabel('CANCELED')).toBe('canceled');
    expect(sessionStatusLabel('CANCELLED')).toBe('cancelled');
  });

  it('says a visit carries no status rather than rendering nothing', () => {
    expect(sessionStatusLabel('')).toBe('no status');
  });
});

describe('sessionServiceLabel', () => {
  it('stands in for a blank service type', () => {
    expect(sessionServiceLabel('')).toBe('Visit');
    expect(sessionServiceLabel('Dog walking')).toBe('Dog walking');
  });
});

describe('ledgerRowTotalCents', () => {
  it('adds the gratuity once', () => {
    expect(ledgerRowTotalCents({ amountCents: 3000, tipCents: 500 })).toBe(3500);
  });
});

describe('paymentsTotalCents', () => {
  it('sums the subcollection rows the panel is showing', () => {
    expect(paymentsTotalCents([{ amountCents: 2000 }, { amountCents: 1500 }])).toBe(3500);
  });

  it('is 0 for no payments, which is a real answer and not a missing one', () => {
    expect(paymentsTotalCents([])).toBe(0);
  });
});

describe('sessionsWithBrokenBacklink', () => {
  it('finds the visits whose own invoiceId does not point back', () => {
    const broken = sessionsWithBrokenBacklink([
      session({ sessionId: 'ok' }),
      session({ sessionId: 'half', linkedBack: false }),
    ]);
    expect(broken.map((s) => s.sessionId)).toEqual(['half']);
  });
});

describe('ledgerCoversBalance', () => {
  it('flags the Stripe case: ledger rows covering a balance nothing settled', () => {
    expect(
      ledgerCoversBalance({
        amountDueCents: 4000,
        ledgerPayments: [{ amountCents: 4000, tipCents: 0 }],
      }),
    ).toBe(true);
  });

  it('counts the tip toward the cover, because it is money that came in', () => {
    expect(
      ledgerCoversBalance({
        amountDueCents: 4000,
        ledgerPayments: [{ amountCents: 3600, tipCents: 500 }],
      }),
    ).toBe(true);
  });

  it('stays quiet on a settled invoice, where a ledger row is just the receipt', () => {
    expect(
      ledgerCoversBalance({
        amountDueCents: 0,
        ledgerPayments: [{ amountCents: 4000, tipCents: 0 }],
      }),
    ).toBe(false);
  });

  it('stays quiet when the ledger falls short: a partial is not a contradiction', () => {
    expect(
      ledgerCoversBalance({
        amountDueCents: 4000,
        ledgerPayments: [{ amountCents: 1000, tipCents: 0 }],
      }),
    ).toBe(false);
  });

  it('stays quiet when there is no ledger row at all', () => {
    expect(ledgerCoversBalance({ amountDueCents: 4000, ledgerPayments: [] })).toBe(false);
  });
});
/**
 * ── THE PAYMENT HISTORY COLUMNS, 2026-08-04 ───────────────────────────────
 *
 * Three columns her production screen has always had were missing here
 * (Applied to #n, Tip, Balance), plus Fee, which nothing in this system stored.
 * Invoice #1029 is why it mattered: Amount $137.50, Applied $127.50, Tip $7.29,
 * Balance $0.00, and $2.71 nobody could account for.
 */
function ledgerRow(over: Partial<GetInvoiceLedgerResultLedgerPayment> = {}) {
  return {
    paymentId: 'r1',
    amountCents: 13750,
    amountResolved: true,
    tipCents: 1000,
    feeCents: 271,
    tipBasis: 'gross' as const,
    reconciles: true,
    appliedCents: 12750,
    unappliedCents: 0,
    proceedsCents: 13479,
    autoApply: false,
    appliedInvoiceId: 'inv1029',
    appliedInvoiceNumber: '1029',
    method: 'venmo',
    reference: 'VN-1029',
    date: 'February 17, 2026',
    notes: '',
    recordedBy: 'admin1',
    ...over,
  };
}
describe('ledgerRowBalanceCents', () => {
  it('is the leftover after the bill and the gross tip, which is #1029 closing at zero', () => {
    const row = ledgerRow();
    expect(ledgerRowBalanceCents(row)).toBe(0);
    // amount = applied + tipGross + balance
    expect(row.appliedCents + row.tipCents + ledgerRowBalanceCents(row)).toBe(row.amountCents);
  });
  it('is the money over on a payment bigger than the bill', () => {
    expect(
      ledgerRowBalanceCents(ledgerRow({ amountCents: 30000, appliedCents: 18000, tipCents: 0, unappliedCents: 12000 })),
    ).toBe(12000);
  });
  it('reports a negative leftover rather than flooring it at zero', () => {
    expect(ledgerRowBalanceCents(ledgerRow({ unappliedCents: -500 }))).toBe(-500);
  });
});
describe('ledgerRowAppliedLabel', () => {
  it('prefers the human invoice number, prefixed the way the operator writes it', () => {
    expect(ledgerRowAppliedLabel(ledgerRow())).toBe('#1029');
  });
  it('falls back to the id when the invoice carries no number', () => {
    expect(ledgerRowAppliedLabel(ledgerRow({ appliedInvoiceNumber: '' }))).toBe('inv1029');
  });
  it('is EMPTY when the payment touched no balance, so the cell can say so', () => {
    // Never "$0.00 applied": a payment that applied to nothing is a different
    // fact from one that applied zero dollars.
    expect(ledgerRowAppliedLabel(ledgerRow({ appliedInvoiceId: '', appliedInvoiceNumber: '' }))).toBe('');
  });
  it('ignores whitespace-only values, which are blanks with a space in them', () => {
    expect(
      ledgerRowAppliedLabel(ledgerRow({ appliedInvoiceId: '  ', appliedInvoiceNumber: ' ' })),
    ).toBe('');
  });
});
describe('ledgerRowCaveat: the rows that cannot be made to add up', () => {
  it('is silent on a row this system wrote, which reconciles on its own', () => {
    expect(ledgerRowCaveat(ledgerRow())).toBe('');
  });
  it('names the migrated row whose fee was dropped, and does NOT guess a gross tip', () => {
    // The gross cannot be recovered from a net tip whose deduction is unknown,
    // and a plausible guess would put a number that was never collected onto a
    // tax return.
    const caveat = ledgerRowCaveat(ledgerRow({ reconciles: false, tipCents: 729, feeCents: 0 }));
    expect(caveat).toMatch(/migrated without its processor fee/i);
    expect(caveat).toMatch(/no gross tip has been guessed/i);
  });
  it('names an over-applied row, which does not balance either', () => {
    expect(ledgerRowCaveat(ledgerRow({ unappliedCents: -500 }))).toMatch(/does not balance/i);
  });
  it('stays silent on a reconcilable row with no tip at all, which is every Stripe row', () => {
    expect(ledgerRowCaveat(ledgerRow({ tipCents: 0, reconciles: true }))).toBe('');
  });
  it('names the row whose amount could not be read, which reconciles() knows nothing about', () => {
    // THE ROW THAT FELL THROUGH EVERY EXISTING BRANCH. `amountResolved: false`
    // says the server could not interpret the stored figure at all; the row can
    // still carry `reconciles: true` and a non-negative balance, so before this
    // branch it produced no caveat and the table printed a confident $0.00.
    const caveat = ledgerRowCaveat(
      ledgerRow({ amountCents: 0, amountResolved: false, tipCents: 0, feeCents: 0, reconciles: true, appliedCents: 0, unappliedCents: 0 }),
    );
    expect(caveat).toMatch(/could not be read/i);
    expect(caveat).toMatch(/never a reading/i);
  });
  it('puts the unreadable amount FIRST, so an unreadable row is never described as a fee problem', () => {
    // A row can be both. Which sentence it gets matters: "the fee was dropped"
    // invites the operator to trust the amount beside it, and on this row the
    // amount is the part nobody can vouch for.
    const caveat = ledgerRowCaveat(
      ledgerRow({ amountCents: 0, amountResolved: false, reconciles: false, tipCents: 729, feeCents: 0 }),
    );
    expect(caveat).toMatch(/could not be read/i);
    expect(caveat).not.toMatch(/migrated without its processor fee/i);
  });
});
