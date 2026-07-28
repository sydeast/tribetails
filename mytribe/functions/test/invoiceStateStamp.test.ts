import { describe, it, expect } from 'vitest';
import {
  invoiceStateStampOf,
  invoiceStampIsCurrent,
  type InvoiceStampDoc,
} from '../src/lib/invoiceStateStamp';
import { INVOICE_STATES } from '../src/lib/invoiceEditPolicy';

/**
 * The stamp is `invoiceEditPolicy` run over the post-write doc, so these cases
 * assert the COMPOSITION, not the policy itself (that has its own suite):
 * every one of the eight states is reachable through the stamp, the editScope
 * follows the standing, and the whole thing is a fixpoint, because the
 * backfill's "skip if current" check and the writers' idempotency both hang on
 * a stamped doc re-stamping to itself.
 */

/** One representative doc per state, each with the paidCents its writer would pass. */
const STATE_FIXTURES: Record<string, { doc: InvoiceStampDoc; paidCents: number }> = {
  quote: { doc: { status: 'QUOTE', amountDue: 40, total: 40 }, paidCents: 0 },
  draft: { doc: { status: 'draft', amountDue: 40, total: 40 }, paidCents: 0 },
  cancelled: { doc: { status: 'cancelled', amountDue: 40, total: 40 }, paidCents: 0 },
  credit: { doc: { status: '', amountDue: -25, total: -25 }, paidCents: 0 },
  redeemed: {
    doc: { status: 'credit', amountDue: -25, total: -25, creditRedeemedAt: '2026-07-20T00:00:00Z' },
    paidCents: 0,
  },
  paid: { doc: { status: 'paid', amountDue: 0, total: 40, totalCents: 4000 }, paidCents: 4000 },
  zero: { doc: { status: '', amountDue: 0, total: 0 }, paidCents: 0 },
  open: { doc: { status: 'open', amountDue: 40, total: 40, totalCents: 4000 }, paidCents: 0 },
};

describe('invoiceStateStampOf reaches every state', () => {
  for (const state of INVOICE_STATES) {
    it(`stamps a ${state} invoice '${state}'`, () => {
      const { doc, paidCents } = STATE_FIXTURES[state];
      expect(invoiceStateStampOf(doc, paidCents).status).toBe(state);
    });
  }

  it('canonicalizes the stored spelling: the stamp is always lowercase', () => {
    expect(invoiceStateStampOf({ status: 'QUOTE' }, 0).status).toBe('quote');
    expect(invoiceStateStampOf({ status: '  Paid  ', amountDue: 0, total: 40 }, 0).status).toBe('paid');
  });

  it('classifies an unlabeled sent invoice open from its money, so free-text spellings retire', () => {
    expect(invoiceStateStampOf({ status: 'sent', amountDue: 40, total: 40 }, 0).status).toBe('open');
    expect(invoiceStateStampOf({ status: '', amountDue: 40, total: 40 }, 0).status).toBe('open');
  });
});

describe('invoiceStateStampOf editScope follows the standing', () => {
  it('a draft and a quote are fully editable', () => {
    expect(invoiceStateStampOf(STATE_FIXTURES.draft.doc, 0).editScope).toBe('all');
    expect(invoiceStateStampOf(STATE_FIXTURES.quote.doc, 0).editScope).toBe('all');
  });

  it('an open invoice with nothing collected is fully editable', () => {
    expect(invoiceStateStampOf(STATE_FIXTURES.open.doc, 0).editScope).toBe('all');
  });

  it('a PART-PAID open invoice STAYS fully editable (the 2026-07-25 rule)', () => {
    expect(invoiceStateStampOf(STATE_FIXTURES.open.doc, 2000).editScope).toBe('all');
  });

  it('a zero invoice is fully editable, or a blank could never get its first line', () => {
    expect(invoiceStateStampOf(STATE_FIXTURES.zero.doc, 0).editScope).toBe('all');
  });

  it('a settled invoice freezes to none through the paid state', () => {
    expect(invoiceStateStampOf(STATE_FIXTURES.paid.doc, 4000).editScope).toBe('none');
  });

  it('a doc LABELLED paid whose payments fall short stamps editScope all, so it stays repairable', () => {
    const corrupt: InvoiceStampDoc = { status: 'paid', amountDue: 0, total: 40, totalCents: 4000 };
    expect(invoiceStateStampOf(corrupt, 2000)).toEqual({ status: 'paid', editScope: 'all' });
  });

  it('a doc labelled paid with NO recorded payments stamps none (the Stripe shape, believed)', () => {
    expect(invoiceStateStampOf({ status: 'paid', amountDue: 0, total: 40 }, 0).editScope).toBe('none');
  });

  it('cancelled, credit and redeemed are frozen outright, whatever the standing', () => {
    for (const paidCents of [0, 2000]) {
      expect(invoiceStateStampOf(STATE_FIXTURES.cancelled.doc, paidCents).editScope).toBe('none');
      expect(invoiceStateStampOf(STATE_FIXTURES.credit.doc, paidCents).editScope).toBe('none');
      expect(invoiceStateStampOf(STATE_FIXTURES.redeemed.doc, paidCents).editScope).toBe('none');
    }
  });
});

describe('invoiceStateStampOf clamp cases', () => {
  it('an OVERPAID edit reads paid/none off the CLAMPED doc, never credit off a negative balance', () => {
    // updateInvoice persists settleInvoice's clamped reading: an edit that
    // drops a $100 invoice to $25 with $60 already collected writes
    // amountDue 0 + overpaidCents 3500, NOT amountDue -35. The stamp runs on
    // that persisted shape, so it must say paid (settled by the excess), never
    // credit (which a negative amountDue would have signalled).
    const afterClampedEdit: InvoiceStampDoc = {
      status: 'open',
      amountDue: 0,
      total: 25,
      totalCents: 2500,
    };
    expect(invoiceStateStampOf(afterClampedEdit, 6000)).toEqual({ status: 'paid', editScope: 'none' });
  });

  it('an overpaying PAYMENT stamps paid/none off the clamped doc for the same reason', () => {
    // markInvoicePaid writing $40 against a $39.50 invoice persists
    // status 'paid', amountDue 0, overpaidCents 50.
    const afterOverpayment: InvoiceStampDoc = {
      status: 'paid',
      amountDue: 0,
      total: 39.5,
      totalCents: 3950,
    };
    expect(invoiceStateStampOf(afterOverpayment, 4000)).toEqual({ status: 'paid', editScope: 'none' });
  });

  it('a REAL credit (negative balance) still stamps credit: the clamp never runs backwards', () => {
    expect(invoiceStateStampOf({ status: '', amountDue: -25.5, total: 40 }, 0)).toEqual({
      status: 'credit',
      editScope: 'none',
    });
  });
});

describe('the stamp is a fixpoint (what makes the backfill idempotent)', () => {
  for (const state of INVOICE_STATES) {
    it(`re-stamping a stamped ${state} doc changes nothing`, () => {
      const { doc, paidCents } = STATE_FIXTURES[state];
      const first = invoiceStateStampOf(doc, paidCents);
      const restamped = invoiceStateStampOf({ ...doc, ...first }, paidCents);
      expect(restamped).toEqual(first);
      expect(invoiceStampIsCurrent({ ...doc, ...first }, restamped)).toBe(true);
    });
  }

  it("'redeemed' specifically survives the round trip on a POSITIVE-balance credit", () => {
    // The case that forced the classifier's `redeemed` positive read: a doc
    // labelled credit whose money does not independently signal credit. The
    // first stamp writes 'redeemed'; without the positive read, the second
    // derivation would have called it 'open' and the stamp would flap.
    const oddCredit: InvoiceStampDoc = {
      status: 'credit',
      amountDue: 5,
      total: 5,
      creditRedeemedAt: '2026-07-20T00:00:00Z',
    };
    const first = invoiceStateStampOf(oddCredit, 0);
    expect(first.status).toBe('redeemed');
    expect(invoiceStateStampOf({ ...oddCredit, ...first }, 0)).toEqual(first);
  });

  it("a doc hand-labelled 'redeemed' with no redemption stamp honestly reads credit", () => {
    expect(invoiceStateStampOf({ status: 'redeemed', amountDue: 5, total: 5 }, 0).status).toBe('credit');
  });
});

describe('invoiceStampIsCurrent', () => {
  const stamp = invoiceStateStampOf(STATE_FIXTURES.open.doc, 0);

  it('is false for a doc with no stamp at all', () => {
    expect(invoiceStampIsCurrent({}, stamp)).toBe(false);
  });

  it('is false when either field disagrees, including on case', () => {
    expect(invoiceStampIsCurrent({ status: 'OPEN', editScope: 'all' }, stamp)).toBe(false);
    expect(invoiceStampIsCurrent({ status: 'open', editScope: 'none' }, stamp)).toBe(false);
    expect(invoiceStampIsCurrent({ status: 'open' }, stamp)).toBe(false);
  });

  it('is true only on an exact match of both fields', () => {
    expect(invoiceStampIsCurrent({ status: 'open', editScope: 'all' }, stamp)).toBe(true);
  });
});
