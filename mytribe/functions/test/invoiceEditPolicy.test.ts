import { describe, it, expect } from 'vitest';
import {
  invoiceStateOf,
  invoiceEditScope,
  invoiceEditRefusal,
  paymentStandingOf,
  INVOICE_STATES,
  type InvoiceState,
  type InvoicePaymentStanding,
} from '../src/lib/invoiceEditPolicy';

const STANDINGS: InvoicePaymentStanding[] = ['none', 'partial', 'settled'];

describe('invoiceStateOf (server-side twin of the admin lib/invoiceFormat.ts enumerator)', () => {
  it('reads an explicit status first, case-insensitively and trimmed', () => {
    expect(invoiceStateOf({ status: ' QUOTE ' })).toBe('quote');
    expect(invoiceStateOf({ status: 'Draft' })).toBe('draft');
    expect(invoiceStateOf({ status: 'cancelled' })).toBe('cancelled');
    expect(invoiceStateOf({ status: 'paid' })).toBe('paid');
  });

  it('treats a negative balance as a credit even with no label', () => {
    expect(invoiceStateOf({ status: '', amountDue: -25, total: -25 })).toBe('credit');
    expect(invoiceStateOf({ status: '', amountDue: 0, total: -25 })).toBe('credit');
  });

  it('splits credit from redeemed on creditRedeemedAt', () => {
    expect(invoiceStateOf({ status: 'credit', creditRedeemedAt: 'anything' })).toBe('redeemed');
    expect(invoiceStateOf({ status: 'credit' })).toBe('credit');
  });

  it('classifies an unlabeled row from its money, positively', () => {
    expect(invoiceStateOf({ status: '', amountDue: 40, total: 40 })).toBe('open');
    expect(invoiceStateOf({ status: '', amountDue: 0, total: 0 })).toBe('zero');
    expect(invoiceStateOf({ status: '', amountDue: 0, total: 40 })).toBe('paid');
  });

  it('survives a document with no status and no money fields at all', () => {
    // A doc predating these fields must not throw: reading one blind is what
    // blanked the whole admin invoices page over a single bad row (AO-12 notes).
    expect(invoiceStateOf({})).toBe('zero');
  });

  it('reads a non-finite amount as no evidence rather than as a real zero', () => {
    expect(invoiceStateOf({ status: '', amountDue: Number.NaN, total: Number.NaN })).toBe('zero');
  });
});

describe('paymentStandingOf (the third state, added 2026-07-25)', () => {
  it('reads nothing collected as none', () => {
    expect(paymentStandingOf(4000, 0)).toBe('none');
  });

  it('reads money that does not cover the total as partial', () => {
    expect(paymentStandingOf(4000, 2000)).toBe('partial');
    // One cent short is still short. The boundary is not "roughly settled".
    expect(paymentStandingOf(4000, 3999)).toBe('partial');
  });

  it('reads an exact payoff as settled', () => {
    expect(paymentStandingOf(4000, 4000)).toBe('settled');
  });

  it('reads an overpayment as settled, never as partial', () => {
    expect(paymentStandingOf(4000, 4500)).toBe('settled');
  });

  it('reads a negative or nonsense paid figure as none rather than as evidence', () => {
    expect(paymentStandingOf(4000, -100)).toBe('none');
    expect(paymentStandingOf(4000, Number.NaN)).toBe('none');
  });
});

describe('invoiceEditScope', () => {
  it('lets a draft or a quote be edited completely', () => {
    expect(invoiceEditScope('draft', 'none')).toBe('all');
    expect(invoiceEditScope('quote', 'none')).toBe('all');
    // A draft cannot have payments, but the answer must not depend on that.
    expect(invoiceEditScope('draft', 'settled')).toBe('all');
  });

  it('lets a sent-but-unpaid invoice be corrected completely', () => {
    // Correcting an invoice you have already sent, before anyone pays it, is
    // ordinary practice. Freezing it here would push the operator into
    // cancel-and-reissue for a typo.
    expect(invoiceEditScope('open', 'none')).toBe('all');
    expect(invoiceEditScope('zero', 'none')).toBe('all');
  });

  it('KEEPS A PART-PAID INVOICE FULLY EDITABLE', () => {
    // The 2026-07-25 change. Freezing the money on the first payment of any
    // size is the second half of the defect that made a part-collected balance
    // unrecoverable: markInvoicePaid refused the balance, and this refused the
    // correction. A part-collected bill is the one an operator most needs to be
    // able to fix.
    expect(invoiceEditScope('open', 'partial')).toBe('all');
    expect(invoiceEditScope('zero', 'partial')).toBe('all');
  });

  it('freezes the money only once the invoice is settled, and still allows metadata', () => {
    expect(invoiceEditScope('open', 'settled')).toBe('metadataOnly');
    expect(invoiceEditScope('zero', 'settled')).toBe('metadataOnly');
  });

  it('refuses every edit once the money has settled or been withdrawn', () => {
    expect(invoiceEditScope('paid', 'none')).toBe('none');
    expect(invoiceEditScope('paid', 'settled')).toBe('none');
    expect(invoiceEditScope('cancelled', 'none')).toBe('none');
    expect(invoiceEditScope('credit', 'none')).toBe('none');
    expect(invoiceEditScope('redeemed', 'none')).toBe('none');
  });

  it('re-opens a doc LABELLED paid whose payments fall short, so the corruption is repairable', () => {
    // The exact shape the pre-fix write produced: status 'paid' over a
    // subcollection that only half covers the total. Freezing it on the label
    // is what left it beyond repair from every direction at once.
    expect(invoiceEditScope('paid', 'partial')).toBe('all');
  });

  it('is total: every enumerated state has an answer for every standing', () => {
    for (const state of INVOICE_STATES) {
      for (const standing of STANDINGS) {
        expect(['all', 'metadataOnly', 'none']).toContain(invoiceEditScope(state, standing));
      }
    }
  });
});

describe('invoiceEditRefusal', () => {
  it('permits a money edit only where the scope is all', () => {
    expect(invoiceEditRefusal('draft', 'none', true)).toBeNull();
    expect(invoiceEditRefusal('open', 'none', true)).toBeNull();
  });

  it('permits a metadata-only edit where money is frozen but the invoice is not', () => {
    expect(invoiceEditRefusal('open', 'settled', false)).toBeNull();
  });

  it('PERMITS a money edit against a part-paid invoice', () => {
    expect(invoiceEditRefusal('open', 'partial', true)).toBeNull();
    // Including the corrupt shape, which is labelled paid but is not.
    expect(invoiceEditRefusal('paid', 'partial', true)).toBeNull();
  });

  it('refuses a money edit against a settled invoice, and says why', () => {
    const refusal = invoiceEditRefusal('open', 'settled', true);
    expect(refusal).not.toBeNull();
    expect(refusal!.code).toBe('invoice_money_locked');
    expect(refusal!.message).toContain('paid in full');
  });

  it('refuses any edit to a paid invoice, and says why', () => {
    const refusal = invoiceEditRefusal('paid', 'settled', false);
    expect(refusal).not.toBeNull();
    expect(refusal!.code).toBe('invoice_not_editable');
    expect(refusal!.message).toContain('paid');
  });

  it('names the actual state in the refusal, so the operator is not guessing', () => {
    expect(invoiceEditRefusal('cancelled', 'none', false)!.message).toContain('cancelled');
    expect(invoiceEditRefusal('credit', 'none', false)!.message).toContain('credit');
  });

  it('gives every frozen state a refusal rather than falling through to null', () => {
    const frozen: InvoiceState[] = ['paid', 'cancelled', 'credit', 'redeemed'];
    for (const state of frozen) {
      expect(invoiceEditRefusal(state, 'none', false)).not.toBeNull();
    }
  });
});
