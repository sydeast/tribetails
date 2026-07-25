import { describe, it, expect } from 'vitest';
import {
  INVOICE_STATES,
  invoiceEditScope,
  invoiceEditRefusal,
  paymentStatusFromDoc,
  type InvoiceEditScope,
  type InvoicePaymentStatus,
  type InvoiceState,
} from './invoiceEditPolicy';

/**
 * The web mirror of the SERVER policy at
 * `mytribe/functions/src/lib/invoiceEditPolicy.ts`.
 *
 * The table below is the same state matrix that file's own test asserts. It is
 * duplicated rather than imported because there is no shared build between
 * `auntieos-admin/` and `mytribe/functions/`; the guard is that both trees
 * assert the same table, so a change made to one and not the other turns a suite
 * red instead of quietly shipping two different ideas of who may edit an
 * invoice. Same arrangement, and same reason, as `invoiceMath.test.ts`.
 */
const EXPECTED: ReadonlyArray<{
  state: InvoiceState;
  payments: InvoicePaymentStatus;
  scope: InvoiceEditScope;
}> = [
  { state: 'draft', payments: 'none', scope: 'all' },
  { state: 'draft', payments: 'partial', scope: 'all' },
  { state: 'draft', payments: 'settled', scope: 'all' },
  { state: 'quote', payments: 'none', scope: 'all' },
  { state: 'quote', payments: 'partial', scope: 'all' },
  { state: 'quote', payments: 'settled', scope: 'all' },

  { state: 'open', payments: 'none', scope: 'all' },
  // PARTIAL-PAYMENT FOLLOW-UP: this row becomes 'all' when the server gains its
  // third payment state. It asserts today's server behaviour on purpose.
  { state: 'open', payments: 'partial', scope: 'metadataOnly' },
  { state: 'open', payments: 'settled', scope: 'metadataOnly' },

  { state: 'zero', payments: 'none', scope: 'all' },
  { state: 'zero', payments: 'partial', scope: 'metadataOnly' },
  { state: 'zero', payments: 'settled', scope: 'metadataOnly' },

  { state: 'paid', payments: 'none', scope: 'none' },
  { state: 'paid', payments: 'settled', scope: 'none' },
  { state: 'cancelled', payments: 'none', scope: 'none' },
  { state: 'cancelled', payments: 'settled', scope: 'none' },
  { state: 'credit', payments: 'none', scope: 'none' },
  { state: 'credit', payments: 'settled', scope: 'none' },
  { state: 'redeemed', payments: 'none', scope: 'none' },
  { state: 'redeemed', payments: 'settled', scope: 'none' },
];

describe('invoiceEditScope (web mirror of the server policy)', () => {
  for (const { state, payments, scope } of EXPECTED) {
    it(`${state} + ${payments} payments -> ${scope}`, () => {
      expect(invoiceEditScope(state, payments)).toBe(scope);
    });
  }

  it('covers every declared state, so a new one cannot be added untested', () => {
    const covered = new Set(EXPECTED.map((row) => row.state));
    expect([...covered].sort()).toEqual([...INVOICE_STATES].sort());
  });

  it('returns one of the three declared scopes for every state and payment combination', () => {
    const valid: InvoiceEditScope[] = ['all', 'metadataOnly', 'none'];
    const payments: InvoicePaymentStatus[] = ['none', 'partial', 'settled'];
    for (const state of INVOICE_STATES) {
      for (const p of payments) {
        expect(valid).toContain(invoiceEditScope(state, p));
      }
    }
  });

  it('a blank invoice (zero, unpaid) stays fully editable so it can receive its first line', () => {
    // Not an incidental pass: freezing `zero` would mean an invoice with no
    // lines could never be given one, because a line-less invoice classifies as
    // `zero`. It is an EMPTY state, not a settled one.
    expect(invoiceEditScope('zero', 'none')).toBe('all');
  });
});

describe('paymentStatusFromDoc', () => {
  it('reads a paid invoice as settled', () => {
    expect(paymentStatusFromDoc('paid')).toBe('settled');
  });

  it('reads every other state as none, because the client genuinely cannot tell', () => {
    // The truth is in the `payments` subcollection, which this client does not
    // load, and the `amountDue` scalar cannot substitute because markInvoicePaid
    // zeroes it even for a PARTIAL payment. Answering "none" offers the control
    // and lets the server refuse, which is the direction this mirror must fail.
    for (const state of INVOICE_STATES) {
      if (state === 'paid') continue;
      expect(paymentStatusFromDoc(state)).toBe('none');
    }
  });
});

describe('invoiceEditRefusal', () => {
  it('allows a money edit on an unpaid open invoice', () => {
    expect(invoiceEditRefusal('open', 'none', true)).toBeNull();
  });

  it('allows a metadata-only edit even when the money is frozen', () => {
    expect(invoiceEditRefusal('open', 'settled', false)).toBeNull();
  });

  it('refuses a money edit once a payment exists, with the money-locked code', () => {
    const refusal = invoiceEditRefusal('open', 'settled', true);
    expect(refusal?.code).toBe('invoice_money_locked');
    expect(refusal?.message).toContain('line items');
  });

  it('refuses everything on a paid invoice, with the not-editable code', () => {
    expect(invoiceEditRefusal('paid', 'settled', false)?.code).toBe('invoice_not_editable');
    expect(invoiceEditRefusal('paid', 'settled', true)?.code).toBe('invoice_not_editable');
  });

  it('names a reason for every frozen state rather than refusing silently', () => {
    for (const state of ['paid', 'cancelled', 'credit', 'redeemed'] as const) {
      const refusal = invoiceEditRefusal(state, 'none', false);
      expect(refusal).not.toBeNull();
      expect(refusal!.message.length).toBeGreaterThan(0);
    }
  });

  it('points a credit at the redemption flow rather than at editing', () => {
    expect(invoiceEditRefusal('credit', 'none', true)?.message).toContain('Redeeming');
  });
});
