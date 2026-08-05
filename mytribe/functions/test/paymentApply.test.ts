import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/lib/firestoreAdmin', () => ({ db: vi.fn(), auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

import { planApply, type InvoiceForApply } from '../src/lib/paymentApply';

/**
 * The "Apply: $" decision, as a pure function.
 *
 * ONE PAYMENT, ONE INVOICE (operator ruling, 2026-08-04: "this is not something
 * i want", on being offered a split). Every refusal below either comes straight
 * from `markInvoicePaid`, imported so the two cannot grow different opinions
 * about what is payable, or exists only because a payment can now be larger
 * than the bill it is going against.
 */

function invoice(over: Record<string, unknown> = {}): InvoiceForApply {
  return {
    invoiceId: 'inv1',
    doc: { kinfolkId: 'fam1', invoiceNumber: '1029', status: 'open', total: 127.5, ...over },
    existingPayments: [],
  };
}

/** A $137.50 payment with a $10 gross tip: $127.50 to give. */
const SPENDABLE = 12750;

function plan(over: Partial<Parameters<typeof planApply>[0]> = {}) {
  return planApply({
    invoice: invoice(),
    appliedCents: 12750,
    kinfolkId: 'fam1',
    spendableCents: SPENDABLE,
    ...over,
  });
}

describe('planApply: the happy path', () => {
  it('settles invoice #1029 with the $127.50 that is not the tip', () => {
    const result = plan();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.step.appliedCents).toBe(12750);
    expect(result.step.invoiceNumber).toBe('1029');
    expect(result.step.after.state).toBe('settled');
    expect(result.step.after.amountDueCents).toBe(0);
  });

  it('leaves a part-paid invoice OPEN with a real balance, never marked paid', () => {
    // The 2026-07-25 defect, which this must not reintroduce by another door.
    const result = plan({ appliedCents: 5000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.step.after.state).toBe('partial');
    expect(result.step.after.amountDueCents).toBe(7750);
  });

  it('adds to what is already recorded rather than replacing it', () => {
    const result = plan({
      invoice: { ...invoice(), existingPayments: [{ amountCents: 2750 }] },
      appliedCents: 10000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.step.before.paidCents).toBe(2750);
    expect(result.step.after.paidCents).toBe(12750);
    expect(result.step.after.state).toBe('settled');
  });

  it('reports an overpayment as overpaid, and never as a negative balance', () => {
    // A negative amountDue is this codebase's CREDIT signal. An overpayment
    // leaking one would reclassify a settled invoice as money owed BACK.
    const result = plan({ appliedCents: 12750, invoice: invoice({ total: 100 }) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.step.after.state).toBe('overpaid');
    expect(result.step.after.amountDueCents).toBe(0);
    expect(result.step.after.overpaidCents).toBe(2750);
  });

  it('allows an apply against a payment that has no household of its own', () => {
    // A standalone row with a blank kinfolkId. The invoice says whose money it
    // is, so this is permitted rather than refused for a field nobody filled.
    expect(plan({ kinfolkId: '' }).ok).toBe(true);
  });
});

describe('planApply: the refusal this module owns', () => {
  it('refuses to apply more than the payment has left once the tip is set aside', () => {
    // The mis-key the Unapplied Balance figure exists to let her catch: $137.50
    // in, $10 tip, and $137.50 typed into Apply.
    const result = plan({ appliedCents: 13750 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('apply_exceeds_payment');
    expect(result.refusal.message).toContain('$137.50');
    expect(result.refusal.message).toContain('$127.50');
  });

  it('accepts an apply that lands exactly on the spendable amount', () => {
    expect(plan({ appliedCents: SPENDABLE }).ok).toBe(true);
  });

  it('refuses a zero apply rather than writing a $0 payment row', () => {
    const result = plan({ appliedCents: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('apply_zero_amount');
  });

  it('refuses a negative apply, which would credit the payment from the invoice', () => {
    const result = plan({ appliedCents: -500 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('apply_zero_amount');
  });

  it("refuses another household's invoice, which is one family paying another's bill", () => {
    const result = plan({ invoice: invoice({ kinfolkId: 'fam2' }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('apply_wrong_household');
    expect(result.refusal.message).toContain('1029');
  });
});

describe('planApply: the refusals imported from markInvoicePaid', () => {
  it('refuses an invoice that does not exist, by id, rather than throwing', () => {
    const result = plan({
      invoice: { invoiceId: 'ghost', doc: null, existingPayments: [] },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('apply_invoice_not_found');
    expect(result.refusal.message).toContain('ghost');
  });

  it('refuses a draft: send it before money can be put against it', () => {
    const result = plan({ invoice: invoice({ status: 'draft' }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('apply_invoice_not_sent');
  });

  it('refuses a quote for the same reason', () => {
    const result = plan({ invoice: invoice({ status: 'quote' }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('apply_invoice_not_sent');
  });

  it('refuses a cancelled invoice', () => {
    const result = plan({ invoice: invoice({ status: 'cancelled' }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('apply_invoice_not_payable');
  });

  it('refuses a CREDIT, which is money owed to the household and not a bill', () => {
    const result = plan({ invoice: invoice({ status: 'credit' }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('apply_invoice_not_payable');
    expect(result.refusal.message).toContain('credit');
  });

  it('refuses an invoice its recorded payments already cover, whatever its label says', () => {
    const result = plan({
      invoice: { ...invoice(), existingPayments: [{ amountCents: 12750 }] },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('invoice_already_settled');
  });

  it('refuses a paid-labelled invoice with NO recorded payments, where the label is the only evidence', () => {
    // The Stripe shape: the card payment landed in the root ledger and the
    // subcollection sums to zero. Trusting the sum alone would invite a second
    // collection on a bill that is already paid.
    const result = plan({ invoice: invoice({ status: 'paid' }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('invoice_already_paid');
  });

  it('ALLOWS the corrupt shape: labelled paid, but its payments fall short', () => {
    // Exactly the invoice whose balance is still owed, and the one the
    // 2026-07-25 fix exists to make collectable again.
    const result = plan({
      invoice: { ...invoice({ status: 'paid' }), existingPayments: [{ amountCents: 2000 }] },
      appliedCents: 5000,
    });
    expect(result.ok).toBe(true);
  });
});
