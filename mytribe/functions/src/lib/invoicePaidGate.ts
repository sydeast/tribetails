/**
 * A PAID INVOICE TAKES NO PAYMENT. The single rule (operator ruling
 * 2026-09-27, docket Q5: "Invoices shouldn't allow payment once marked as
 * paid").
 *
 * Every household-side way to hand money to an invoice asks this function:
 * `payInvoice` (Stripe Checkout), `redeemCredit`, the per-invoice pay methods
 * `getMyInvoices` ships, the "How to pay" block on the invoice PDF, and the
 * webhook's late-checkout branch (`lib/invoiceCheckoutDedupe.ts`). The trigger
 * that expires open Checkout Sessions (`triggers/onInvoicePaidExpireCheckouts`)
 * asks it too, so "paid" means the same thing to the button, the server refusal
 * and the session sweep.
 *
 * ── WHAT COUNTS AS PAID ───────────────────────────────────────────────────
 *
 *   1. THE LABEL. `status: 'paid'` or `paymentStatus: 'PAID'`. "Marked as paid"
 *      is the ruling's own wording, so the mark is enough on its own, even on a
 *      document whose stated balance still reads positive. That shape is the
 *      pre-2026-07-25 partial-payment corruption (`amountDueRule.ts`), and a
 *      household must not be able to pay into it: the admin repairs it.
 *      `paymentStatus` counts because `markInvoicePaid.claimsPaid` reads it too,
 *      and every writer of `'PAID'` there writes `status: 'paid'` beside it.
 *   2. THE CLASSIFIER. `invoiceStateOf` (ADR-0002's classifier of record)
 *      reading `paid`: an unlabelled bill whose balance is zero, or a legacy
 *      bill whose payment rows cover it when the caller holds the rows.
 *
 * NOT PAID, deliberately: `zero` (a $0 bill; nothing to pay anyway, and
 * `payInvoice` already refuses a zero balance), `cancelled`, the credit family,
 * `draft` and `quote`. Each of those has its own refusal with its own sentence;
 * this rule is about the one the ruling names.
 *
 * ── ADMIN RECORDING IS NOT ROUTED HERE ────────────────────────────────────
 *
 * `markInvoicePaid`, `recordPayment` (through `lib/paymentApply.ts`) and the
 * account-credit draw already refuse a settled invoice through
 * `markInvoicePaid.alreadySettledRefusal`, with one explicit correction path:
 * an invoice labelled paid whose recorded payments fall short of its total is
 * the corrupt shape the admin is meant to be able to finish collecting. That
 * path stays. This module is the household side.
 *
 * Pure: no Firestore, no Stripe. Imports only the classifier.
 */
import { invoiceStateOf, type InvoiceStateDoc } from './invoiceEditPolicy';

/** The sentence every refusal carries, so the web and Android portals print one message. */
export const PAID_INVOICE_REFUSAL = 'This invoice is already paid, so it cannot take another payment.';

/** `HttpsError` `details.code` for the refusal. Matches `markInvoicePaid`'s existing code. */
export const PAID_INVOICE_REFUSAL_CODE = 'invoice_already_paid';

/** The fields the rule reads. All unknown: real documents are missing keys. */
export interface InvoicePaidDoc extends InvoiceStateDoc {
  paymentStatus?: unknown;
  /** The legacy spelling of `status` the sandbox seed still writes; read only when `status` is absent. */
  invoiceStatus?: unknown;
}

function label(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

/** Whether the invoice is MARKED paid: the label alone, no money read. */
export function invoiceMarkedPaid(doc: InvoicePaidDoc | undefined | null): boolean {
  if (!doc) return false;
  const status = doc.status ?? doc.invoiceStatus;
  return label(status) === 'paid' || label(doc.paymentStatus) === 'paid';
}

/**
 * Whether this invoice is paid, and so takes no payment from the household.
 *
 * `paidCents` is the invoice's `payments` subcollection sum when the caller
 * holds it, `null` otherwise. It only changes the answer for a legacy document
 * that states no balance (see `amountDueRule.ts`).
 */
export function invoiceIsPaid(doc: InvoicePaidDoc | undefined | null, paidCents: number | null = null): boolean {
  if (!doc) return false;
  if (invoiceMarkedPaid(doc)) return true;
  return invoiceStateOf(doc, paidCents) === 'paid';
}
