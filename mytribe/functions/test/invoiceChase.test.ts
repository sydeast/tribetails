import { describe, it, expect } from 'vitest';
import {
  chaseRefusalOf,
  daysPastDue,
  invoiceDueDayOf,
  isDueWithin,
  isLegacyTotalOnly,
} from '../src/lib/invoiceChase';
import { INVOICE_STATES, invoiceStateOf } from '../src/lib/invoiceEditPolicy';

/**
 * #871: the one rule every chaser asks (lib/invoiceChase.ts). The sender
 * pairings are in invoiceOverdueSenders.test.ts; this file pins the pure parts.
 */
const STATE_FIXTURES: Record<string, Record<string, unknown>> = {
  quote: { status: 'quote', amountDue: 40, total: 40 },
  draft: { status: 'draft', amountDue: 40, total: 40 },
  cancelled: { status: 'cancelled', amountDue: 40, total: 40 },
  credit: { status: 'credit', amountDue: 40, total: 40 },
  redeemed: { status: 'redeemed', amountDue: -25, total: -25, creditRedeemedAt: 'ts' },
  paid: { status: 'paid', amountDue: 0, total: 40 },
  zero: { status: 'open', amountDue: 0, total: 0 },
  open: { status: 'open', amountDue: 40, total: 40 },
};

describe('chaseRefusalOf: only an open bill may be chased', () => {
  it('has one fixture per classifier state, each classifying as itself', () => {
    expect(Object.keys(STATE_FIXTURES).sort()).toEqual([...INVOICE_STATES].sort());
    for (const [state, doc] of Object.entries(STATE_FIXTURES)) expect(invoiceStateOf(doc)).toBe(state);
  });

  for (const state of INVOICE_STATES) {
    it(`${state}: ${state === 'open' ? 'may be chased' : 'is refused as not_open or unaccepted_quote'}`, () => {
      const refusal = chaseRefusalOf(STATE_FIXTURES[state]!, null);
      if (state === 'open') expect(refusal).toBeNull();
      else if (state === 'quote') expect(refusal).toEqual({ reason: 'unaccepted_quote', state: 'quote' });
      else expect(refusal).toEqual({ reason: 'not_open', state });
    });
  }

  it('a declined quote is refused', () => {
    expect(chaseRefusalOf({ ...STATE_FIXTURES.quote, quoteDecision: 'denied' }, null)?.reason).toBe('unaccepted_quote');
  });

  it('an accepted quote is an open bill and may be chased', () => {
    expect(chaseRefusalOf({ status: 'open', invoiceStatus: 'open', quoteDecision: 'accepted', amountDue: 40, total: 40 }, null)).toBeNull();
  });

  it('a doc still labelled quote in invoiceStatus is refused even when status says open', () => {
    expect(chaseRefusalOf({ status: 'open', invoiceStatus: 'QUOTE', amountDue: 40, total: 40 }, null)).toEqual({
      reason: 'unaccepted_quote',
      state: 'open',
    });
  });

  it('an archived open bill is refused (the office wrote it off)', () => {
    expect(chaseRefusalOf({ ...STATE_FIXTURES.open, archivedAt: 'ts' }, null)?.reason).toBe('archived');
    // `unarchiveInvoice` writes null, which is not archived.
    expect(chaseRefusalOf({ ...STATE_FIXTURES.open, archivedAt: null }, null)).toBeNull();
  });

  it('cancelled, draft and credit with a positive balance are still refused (the issue #871 shapes)', () => {
    for (const status of ['cancelled', 'draft', 'credit']) {
      expect(chaseRefusalOf({ status, amountDue: 90, total: 90 }, null)?.reason).toBe('not_open');
    }
  });
});

describe('the legacy total-only shape (#902 owns the classifier; #871 is conservative)', () => {
  const legacy = { status: 'sent', total: 40 };

  it('is recognised, and a labelled paid doc or a doc with a finite amountDue is not', () => {
    expect(isLegacyTotalOnly(legacy)).toBe(true);
    expect(isLegacyTotalOnly({ status: 'open', total: 40, amountDue: Number.NaN })).toBe(true);
    expect(isLegacyTotalOnly({ status: 'paid', total: 40 })).toBe(false);
    expect(isLegacyTotalOnly({ status: 'open', total: 40, amountDue: 0 })).toBe(false);
    expect(isLegacyTotalOnly({ status: 'sent', total: 0 })).toBe(false);
    expect(isLegacyTotalOnly({ status: 'cancelled', total: 40 })).toBe(false);
  });

  it('no evidence and no payment rows: no notice', () => {
    expect(chaseRefusalOf(legacy, null)).toEqual({ reason: 'legacy_balance_unproven', state: 'paid' });
    expect(chaseRefusalOf(legacy, { rows: 0, paidCents: 0 })?.reason).toBe('legacy_balance_unproven');
  });

  it('payment rows that cover the total: no notice', () => {
    expect(chaseRefusalOf(legacy, { rows: 1, paidCents: 4000 })?.reason).toBe('legacy_balance_unproven');
    expect(chaseRefusalOf(legacy, { rows: 2, paidCents: 5000 })?.reason).toBe('legacy_balance_unproven');
  });

  it('payment rows that prove a balance: may be chased', () => {
    expect(chaseRefusalOf(legacy, { rows: 1, paidCents: 1500 })).toBeNull();
  });

  it('totalCents wins over the dollar total', () => {
    expect(chaseRefusalOf({ status: 'sent', total: 40, totalCents: 1000 }, { rows: 1, paidCents: 1500 })?.reason).toBe(
      'legacy_balance_unproven',
    );
  });
});

describe('the due day and the business calendar', () => {
  it('reads dueDate first, then invoiceDueDate, and takes an ISO day prefix', () => {
    expect(invoiceDueDayOf({ dueDate: '2026-09-01' })).toBe('2026-09-01');
    expect(invoiceDueDayOf({ dueDate: '2026-09-01T23:59:00.000Z' })).toBe('2026-09-01');
    expect(invoiceDueDayOf({ invoiceDueDate: '2026-09-02' })).toBe('2026-09-02');
    expect(invoiceDueDayOf({ dueDate: 'Net 14', invoiceDueDate: '2026-09-02' })).toBe('2026-09-02');
    expect(invoiceDueDayOf({ dueDate: 'Net 14' })).toBeNull();
    expect(invoiceDueDayOf({})).toBeNull();
  });

  it('due today is due, not overdue; yesterday is one day past', () => {
    expect(daysPastDue('2026-09-14', '2026-09-14')).toBeNull();
    expect(daysPastDue('2026-09-13', '2026-09-14')).toBe(1);
    expect(daysPastDue('2026-08-15', '2026-09-14')).toBe(30);
    expect(daysPastDue('2026-09-15', '2026-09-14')).toBeNull();
  });

  it('never guesses without a due day or a business day', () => {
    expect(daysPastDue(null, '2026-09-14')).toBeNull();
    expect(daysPastDue('2026-09-01', '')).toBeNull();
    expect(isDueWithin(null, '2026-09-14', 3)).toBe(false);
    expect(isDueWithin('2026-09-15', '', 3)).toBe(false);
  });

  it('the reminder window is today through three days out', () => {
    expect(isDueWithin('2026-09-14', '2026-09-14', 3)).toBe(true);
    expect(isDueWithin('2026-09-17', '2026-09-14', 3)).toBe(true);
    expect(isDueWithin('2026-09-18', '2026-09-14', 3)).toBe(false);
    expect(isDueWithin('2026-09-13', '2026-09-14', 3)).toBe(false);
  });

  it('counts whole days across a month and a year boundary', () => {
    expect(daysPastDue('2026-12-31', '2027-01-02')).toBe(2);
    expect(isDueWithin('2027-01-01', '2026-12-30', 3)).toBe(true);
  });
});
