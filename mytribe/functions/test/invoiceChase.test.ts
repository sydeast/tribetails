import { describe, it, expect } from 'vitest';
import {
  chaseRefusalOf,
  daysPastDue,
  invoiceDueDayOf,
  isDueWithin,
  legacyEvidenceWanted,
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

/**
 * READER 5 of #902's shared rule: the chase gate, and the #871 behaviour change
 * this issue makes on purpose.
 *
 * WHAT #871 DID. A migrated `{ status: 'sent', total: 40 }` classified `paid`,
 * because the classifier read a missing balance as zero. #871 would not chase it
 * unless its payment rows PROVED a balance, and called that refusal
 * `legacy_balance_unproven`. That was a local patch around a classifier reading
 * #871 deliberately left to this issue.
 *
 * WHAT #902 DOES. The rule derives the balance, so an unpaid legacy bill reads
 * `open` and IS chased. The office may now remind a household about a migrated
 * bill nobody has paid, which is the reason it was sent. The rows still decide
 * the other direction: a bill they cover reads `paid` and is refused as
 * `not_open`, and `legacy_balance_unproven` is gone rather than unreachable.
 */
describe('the legacy total-only shape, after #902 ruled on a missing amountDue', () => {
  const legacy = { status: 'sent', total: 40 };
  it('is what the senders read the payment rows for, and an ordinary invoice is not', () => {
    expect(legacyEvidenceWanted(legacy)).toBe(true);
    expect(legacyEvidenceWanted({ status: 'open', total: 40, amountDue: Number.NaN })).toBe(true);
    expect(legacyEvidenceWanted({ status: 'paid', total: 40 })).toBe(false);
    expect(legacyEvidenceWanted({ status: 'open', total: 40, amountDue: 0 })).toBe(false);
    expect(legacyEvidenceWanted({ status: 'sent', total: 0 })).toBe(false);
  });
  it('CHANGED BY #902: no rows means the total is owed, so it is chased', () => {
    expect(invoiceStateOf(legacy)).toBe('open');
    expect(chaseRefusalOf(legacy, null)).toBeNull();
    expect(chaseRefusalOf(legacy, { rows: 0, paidCents: 0 })).toBeNull();
  });
  it('payment rows covering the total settle it: refused as not_open, not as a legacy special case', () => {
    expect(chaseRefusalOf(legacy, { rows: 1, paidCents: 4000 })).toEqual({ reason: 'not_open', state: 'paid' });
    expect(chaseRefusalOf(legacy, { rows: 2, paidCents: 5000 })).toEqual({ reason: 'not_open', state: 'paid' });
  });
  it('payment rows that fall short leave a balance: may be chased', () => {
    expect(chaseRefusalOf(legacy, { rows: 1, paidCents: 1500 })).toBeNull();
  });
  it('totalCents wins over the dollar total, so a $10 bill covered by $15 is settled', () => {
    expect(chaseRefusalOf({ status: 'sent', total: 40, totalCents: 1000 }, { rows: 1, paidCents: 1500 })).toEqual({
      reason: 'not_open',
      state: 'paid',
    });
  });
  it('a cancelled or drafted legacy doc is still refused: the label decides before the money', () => {
    expect(chaseRefusalOf({ status: 'cancelled', total: 40 }, null)).toEqual({ reason: 'not_open', state: 'cancelled' });
    expect(chaseRefusalOf({ status: 'draft', total: 40 }, null)).toEqual({ reason: 'not_open', state: 'draft' });
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
