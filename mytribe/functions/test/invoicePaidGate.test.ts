import { describe, it, expect } from 'vitest';
import {
  invoiceIsPaid,
  invoiceMarkedPaid,
  PAID_INVOICE_REFUSAL,
  PAID_INVOICE_REFUSAL_CODE,
} from '../src/lib/invoicePaidGate';

/**
 * Docket Q5 (operator ruling 2026-09-27): "Invoices shouldn't allow payment
 * once marked as paid." One rule for every household-side way to pay.
 */
describe('invoicePaidGate', () => {
  it('the mark alone is enough, even while a stated balance reads positive', () => {
    expect(invoiceIsPaid({ status: 'paid', amountDue: 40, total: 137.5 })).toBe(true);
    expect(invoiceIsPaid({ status: ' PAID ', amountDueCents: 4000, total: 137.5 })).toBe(true);
  });

  it("reads markInvoicePaid's second label, and the legacy status spelling", () => {
    expect(invoiceIsPaid({ status: 'open', paymentStatus: 'PAID', amountDue: 40, total: 40 })).toBe(true);
    expect(invoiceIsPaid({ invoiceStatus: 'paid', amountDue: 40, total: 40 } as never)).toBe(true);
    // `status` wins over the legacy spelling when both are present.
    expect(invoiceMarkedPaid({ status: 'open', invoiceStatus: 'paid' })).toBe(false);
  });

  it('an unlabelled bill whose balance is zero is paid (the classifier)', () => {
    expect(invoiceIsPaid({ amountDue: 0, total: 137.5 })).toBe(true);
    expect(invoiceIsPaid({ status: 'sent', amountDueCents: 0, totalCents: 13750 })).toBe(true);
  });

  it('a legacy bill with no stated balance is paid only when its rows cover it', () => {
    expect(invoiceIsPaid({ status: 'sent', total: 40 }, null)).toBe(false);
    expect(invoiceIsPaid({ status: 'sent', total: 40 }, 4000)).toBe(true);
    expect(invoiceIsPaid({ status: 'sent', total: 40 }, 1000)).toBe(false);
  });

  it('is not paid: open bills, $0 bills, drafts, quotes, cancelled, credits', () => {
    expect(invoiceIsPaid({ status: 'open', amountDue: 40, total: 40 })).toBe(false);
    expect(invoiceIsPaid({ status: 'open', amountDue: 20, total: 40, paymentStatus: 'PARTIAL' })).toBe(false);
    expect(invoiceIsPaid({ amountDue: 0, total: 0 })).toBe(false);
    expect(invoiceIsPaid({ status: 'draft', amountDue: 0, total: 40 })).toBe(false);
    expect(invoiceIsPaid({ status: 'quote', amountDue: 40, total: 40 })).toBe(false);
    expect(invoiceIsPaid({ status: 'cancelled', amountDue: 0, total: 40 })).toBe(false);
    expect(invoiceIsPaid({ status: 'credit', amountDue: -25, total: -25 })).toBe(false);
    expect(invoiceIsPaid({ amountDue: -25, total: 100 })).toBe(false);
  });

  it('a missing document is not paid (the callers refuse it as not found)', () => {
    expect(invoiceIsPaid(undefined)).toBe(false);
    expect(invoiceIsPaid(null)).toBe(false);
  });

  it('ships one sentence and the code markInvoicePaid already uses', () => {
    expect(PAID_INVOICE_REFUSAL).toBe('This invoice is already paid, so it cannot take another payment.');
    expect(PAID_INVOICE_REFUSAL_CODE).toBe('invoice_already_paid');
  });
});
