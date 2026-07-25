import { describe, it, expect } from 'vitest';
import {
  invoiceStateOf,
  invoiceEditScope,
  invoiceEditRefusal,
  INVOICE_STATES,
  type InvoiceState,
} from '../src/lib/invoiceEditPolicy';

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

describe('invoiceEditScope', () => {
  it('lets a draft or a quote be edited completely', () => {
    expect(invoiceEditScope('draft', false)).toBe('all');
    expect(invoiceEditScope('quote', false)).toBe('all');
    // A draft cannot have payments, but the answer must not depend on that.
    expect(invoiceEditScope('draft', true)).toBe('all');
  });

  it('lets a sent-but-unpaid invoice be corrected completely', () => {
    // Correcting an invoice you have already sent, before anyone pays it, is
    // ordinary practice. Freezing it here would push the operator into
    // cancel-and-reissue for a typo.
    expect(invoiceEditScope('open', false)).toBe('all');
    expect(invoiceEditScope('zero', false)).toBe('all');
  });

  it('freezes the money once a payment exists, but still allows metadata', () => {
    expect(invoiceEditScope('open', true)).toBe('metadataOnly');
    expect(invoiceEditScope('zero', true)).toBe('metadataOnly');
  });

  it('refuses every edit once the money has settled or been withdrawn', () => {
    expect(invoiceEditScope('paid', false)).toBe('none');
    expect(invoiceEditScope('cancelled', false)).toBe('none');
    expect(invoiceEditScope('credit', false)).toBe('none');
    expect(invoiceEditScope('redeemed', false)).toBe('none');
  });

  it('is total: every enumerated state has an answer', () => {
    for (const state of INVOICE_STATES) {
      for (const hasPayments of [false, true]) {
        expect(['all', 'metadataOnly', 'none']).toContain(invoiceEditScope(state, hasPayments));
      }
    }
  });
});

describe('invoiceEditRefusal', () => {
  it('permits a money edit only where the scope is all', () => {
    expect(invoiceEditRefusal('draft', false, true)).toBeNull();
    expect(invoiceEditRefusal('open', false, true)).toBeNull();
  });

  it('permits a metadata-only edit where money is frozen but the invoice is not', () => {
    expect(invoiceEditRefusal('open', true, false)).toBeNull();
  });

  it('refuses a money edit against a part-paid invoice, and says why', () => {
    const refusal = invoiceEditRefusal('open', true, true);
    expect(refusal).not.toBeNull();
    expect(refusal!.code).toBe('invoice_money_locked');
    expect(refusal!.message).toContain('payment');
  });

  it('refuses any edit to a paid invoice, and says why', () => {
    const refusal = invoiceEditRefusal('paid', true, false);
    expect(refusal).not.toBeNull();
    expect(refusal!.code).toBe('invoice_not_editable');
    expect(refusal!.message).toContain('paid');
  });

  it('names the actual state in the refusal, so the operator is not guessing', () => {
    expect(invoiceEditRefusal('cancelled', false, false)!.message).toContain('cancelled');
    expect(invoiceEditRefusal('credit', false, false)!.message).toContain('credit');
  });

  it('gives every frozen state a refusal rather than falling through to null', () => {
    const frozen: InvoiceState[] = ['paid', 'cancelled', 'credit', 'redeemed'];
    for (const state of frozen) {
      expect(invoiceEditRefusal(state, false, false)).not.toBeNull();
    }
  });
});
