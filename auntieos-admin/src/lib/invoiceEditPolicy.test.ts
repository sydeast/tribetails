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
  // A part-paid invoice is the one an operator most needs to correct, so it
  // stays fully editable. Only a settled one freezes its money.
  { state: 'open', payments: 'partial', scope: 'all' },
  { state: 'open', payments: 'settled', scope: 'metadataOnly' },

  { state: 'zero', payments: 'none', scope: 'all' },
  { state: 'zero', payments: 'partial', scope: 'all' },
  { state: 'zero', payments: 'settled', scope: 'metadataOnly' },

  { state: 'paid', payments: 'none', scope: 'none' },
  // A doc LABELLED paid whose payments fall short is not settled, it is the
  // corruption `invoicePaymentRepair.ts` exists to undo. It stays editable so an
  // operator is not blocked while waiting for the repair pass.
  { state: 'paid', payments: 'partial', scope: 'all' },
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
/**
 * `paymentStatusFromDoc` decides which mirrored branch runs, so it is worth its
 * own table. The trap it exists to avoid: `amountDue` reads 0 on every invoice
 * the pre-2026-07-25 partial-payment write touched, so anything derived from it
 * would call a part-paid invoice settled and hide the Edit control on exactly
 * the invoice that most needs correcting.
 */
describe('paymentStatusFromDoc', () => {
  it('calls a short payment partial, from paidCents against the total', () => {
    expect(paymentStatusFromDoc('open', 4000, 2000)).toBe('partial');
  });
  it('calls a covering payment settled', () => {
    expect(paymentStatusFromDoc('open', 4000, 4000)).toBe('settled');
    expect(paymentStatusFromDoc('open', 4000, 5000)).toBe('settled');
  });
  it('reads a doc LABELLED paid whose payments fall short as partial, not settled', () => {
    // The corrupt shape. Reading the label would freeze it; reading the money
    // keeps it repairable, which is what the server now does too.
    expect(paymentStatusFromDoc('paid', 4000, 2000)).toBe('partial');
    expect(invoiceEditScope('paid', paymentStatusFromDoc('paid', 4000, 2000))).toBe('all');
  });
  it('never infers a payment from amountDue reading zero', () => {
    // A legacy doc with no paidCents. The old write left amountDue at 0 here, so
    // any answer derived from that scalar would be "settled" and wrong.
    expect(paymentStatusFromDoc('open')).toBe('none');
    expect(paymentStatusFromDoc('open', 4000, undefined)).toBe('none');
  });

  it('answers none for every unlabelled state with no figure, which OFFERS the control', () => {
    // A legacy doc carries no paidCents, and the server has the last word. A
    // wrongly-offered Edit ends in a refusal this app prints verbatim; a
    // wrongly-hidden one is a dead end. Fail toward offering.
    for (const state of INVOICE_STATES) {
      if (state === 'paid') continue;
      expect(paymentStatusFromDoc(state)).toBe('none');
    }
  });
  it('falls back to the label when there is no recorded figure', () => {
    expect(paymentStatusFromDoc('paid')).toBe('settled');
    expect(paymentStatusFromDoc('paid', 4000, 0)).toBe('settled');
  });
  it('treats an unusable total as settled rather than inventing a balance', () => {
    expect(paymentStatusFromDoc('open', undefined, 2000)).toBe('settled');
    expect(paymentStatusFromDoc('open', Number.NaN, 2000)).toBe('settled');
  });
});
