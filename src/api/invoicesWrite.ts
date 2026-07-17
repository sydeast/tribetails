import { call } from '../lib/fns';

/**
 * The write side of the Invoices screen. Every callable below was confirmed
 * live against MyTribe/functions/src/admin/*.ts (read, not guessed):
 *
 *   createInvoice.ts          zod Args matched field-for-field
 *   createQuote.ts            same Args + `sendToKinfolk`; server ignores the
 *                             caller's `status` and always mints QUOTE
 *   sendInvoiceReminder.ts    `{ invoiceId }`, throws failed-precondition if
 *                             the invoice is already paid
 *   generateReceipt.ts        `{ invoiceId }`
 *
 * Two actions this screen needs, "mark paid" and "send a draft", have NO
 * dedicated callable. Confirmed by reading every file under
 * MyTribe/functions/src/admin/: no markPaid.ts, markInvoicePaid.ts, or
 * reviewAndSendDraftInvoice.ts exists, and neither name (nor a "mark paid"
 * button) appears anywhere in the wasm reference
 * (web/composeApp/.../invoices/InvoiceDetailScreen.kt), which only wires
 * Receipt, Reminder, and Record Payment (recordPayment, a DIRECT Firestore
 * write via FirestoreClient, not a callable, and out of scope here). Both
 * route through `postInvoiceEvent` instead: the one real, exported, generic
 * admin invoice-mutation callable (merges an arbitrary payload onto
 * invoices/{invoiceId}, stamps kinfolkId + updatedAt, writes an audit entry,
 * dispatches a notification). It is a real backend call, not a stub, but it is
 * the generic primitive, not a purpose-built endpoint, see the doc comments on
 * markInvoicePaid / reviewAndSendDraftInvoice below for exactly what that does
 * and does not mean.
 */

/**
 * Shared shape of createInvoice/createQuote, matching both callables' zod
 * schema field-for-field (createQuote accepts the identical shape plus
 * `sendToKinfolk`, and ignores the caller's `status`).
 */
export interface NewInvoiceInput {
  familyId: string;
  kinfolkName: string;
  invoiceNumber: string;
  client: string;
  address: string;
  date: string;
  terms: string;
  dueDate: string;
  discount: string;
  total: number;
  amountDue: number;
  status: string;
  sessionIds: string[];
}

export interface NewInvoiceResult {
  invoiceId: string;
}

/** createInvoice (admin): mints a new `invoices/{id}` doc, kinfolk gets notified `invoice.new`. */
export async function createInvoice(input: NewInvoiceInput): Promise<NewInvoiceResult> {
  const res = await call<NewInvoiceInput, { ok: true; invoiceId: string }>('createInvoice', input);
  return { invoiceId: res.invoiceId };
}

export interface NewQuoteInput extends NewInvoiceInput {
  /** When true, dispatches the issued-quote notification (`invoice.new`, isQuote: true) immediately. */
  sendToKinfolk: boolean;
}

/** createQuote (admin): same shape as createInvoice, always mints QUOTE status server-side. */
export async function createQuote(input: NewQuoteInput): Promise<NewInvoiceResult> {
  const res = await call<NewQuoteInput, { ok: true; invoiceId: string }>('createQuote', input);
  return { invoiceId: res.invoiceId };
}

/**
 * sendInvoiceReminder (admin): on-demand resend of the `invoice.reminder`
 * notification for one invoice, right now. Throws (fail loud, never
 * swallowed) `failed-precondition` if the invoice is already paid, `not-found`
 * if the id is wrong.
 */
export async function sendInvoiceReminder(invoiceId: string): Promise<void> {
  await call<{ invoiceId: string }, { ok: true; invoiceId: string }>('sendInvoiceReminder', { invoiceId });
}

/**
 * generateReceipt (admin): stamps `receiptIssuedAt`/`receiptIssuedBy` and
 * dispatches the `invoice.receipt` notification. Throws `not-found` if the
 * invoice is missing rather than silently creating one.
 */
export async function generateReceipt(invoiceId: string): Promise<void> {
  await call<{ invoiceId: string }, { ok: true }>('generateReceipt', { invoiceId });
}

interface PostInvoiceEventInput {
  familyId: string;
  invoiceId: string;
  payload: Record<string, unknown>;
}

/**
 * Marks an invoice paid by writing `{ status: 'paid', amountDue: 0 }` through
 * `postInvoiceEvent`. NOT a dedicated markPaid endpoint, see this module's
 * header: no such callable exists. This bypasses the `payments` audit trail
 * the wasm's Record-Payment flow builds (no `payments` doc is created), it
 * only updates the invoice doc itself, real and immediate, but a coarser tool
 * than a purpose-built one would be.
 */
export async function markInvoicePaid(invoiceId: string, familyId: string): Promise<void> {
  await call<PostInvoiceEventInput, { ok: true }>('postInvoiceEvent', {
    familyId,
    invoiceId,
    payload: { status: 'paid', amountDue: 0 },
  });
}

/**
 * Clears a DRAFT invoice's status via `postInvoiceEvent`, the same generic
 * primitive as markInvoicePaid above (see this module's header for why: no
 * reviewAndSendDraftInvoice callable exists). "Sending" a draft has no
 * dedicated validation step server-side beyond what postInvoiceEvent already
 * does (an `invoice.updated` dispatch), which this documents rather than invents.
 */
export async function reviewAndSendDraftInvoice(invoiceId: string, familyId: string): Promise<void> {
  await call<PostInvoiceEventInput, { ok: true }>('postInvoiceEvent', {
    familyId,
    invoiceId,
    payload: { status: '' },
  });
}
