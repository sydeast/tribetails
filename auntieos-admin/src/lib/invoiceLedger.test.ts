import { describe, expect, it } from 'vitest';
import {
  ledgerCoversBalance,
  ledgerRowTotalCents,
  paymentDayLabel,
  paymentMethodLabel,
  paymentsTotalCents,
  sessionDayLabel,
  sessionServiceLabel,
  sessionStatusLabel,
  sessionsWithBrokenBacklink,
} from './invoiceLedger';
import type { GetInvoiceLedgerResultSession } from '../contracts/invoiceContracts.generated';

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
