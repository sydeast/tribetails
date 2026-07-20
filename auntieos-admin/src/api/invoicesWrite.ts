import { call } from '../lib/fns';

/**
 * The write side of the Invoices screen. Every callable below was confirmed
 * live against MyTribe/functions/src/admin/*.ts (read, not guessed):
 *
 *   createInvoice.ts              zod Args matched field-for-field
 *   createQuote.ts                same Args + `sendToKinfolk`; server ignores
 *                                 the caller's `status` and always mints QUOTE
 *   sendInvoiceReminder.ts        `{ invoiceId }`, throws failed-precondition
 *                                 if the invoice is already paid
 *   generateReceipt.ts            `{ invoiceId }`
 *   markInvoicePaid.ts            `{ invoiceId, amount?, method?, reference?,
 *                                 paidAt? }`; writes a `payments` subcollection
 *                                 entry (amount/method/reference/paidAt/
 *                                 recordedBy) in the same batch as the status
 *                                 flip, throws failed-precondition if already
 *                                 paid or still a draft/quote
 *   reviewAndSendDraftInvoice.ts  `{ invoiceId }`; throws failed-precondition
 *                                 if the invoice isn't a draft, or if it's
 *                                 missing a total, household, or invoice
 *                                 number
 *
 * `markInvoicePaid` and `reviewAndSendDraftInvoice` used to route through
 * `postInvoiceEvent`, the generic admin invoice-mutation callable, as a
 * workaround: a real backend call, but the generic primitive rather than a
 * purpose-built endpoint, with no payment audit trail and no draft-send
 * validation. Both now call their own dedicated callables above, neither of
 * which needs `familyId` from the caller: each loads the invoice server-side
 * and reads `kinfolkId` off the doc itself.
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

export interface MarkInvoicePaidInput {
  /** Dollar amount actually collected. Omit to pay the invoice's current amountDue in full (server default). */
  amount?: number;
  /** Free-text payment method, e.g. "check", "cash", "venmo". */
  method?: string;
  /** Free-text reference/confirmation number for the payment. */
  reference?: string;
  /** ISO-8601 timestamp for when the payment was actually received. Omit to use now (server default). */
  paidAt?: string;
}

interface MarkInvoicePaidRequest extends MarkInvoicePaidInput {
  invoiceId: string;
}

/**
 * markInvoicePaid (admin): flips the invoice to paid + zeroes amountDue, and
 * writes a `payments` subcollection entry (amount/method/reference/paidAt/
 * recordedBy) in the SAME batch, so a manual payment is never recorded
 * without its audit trail. Throws `failed-precondition` if the invoice is
 * already paid or is still a draft/quote, `not-found` if the id is wrong.
 * The `invoice.payment.applied` notification is dispatched by the backend's
 * `onInvoicesWrite` trigger off the resulting Firestore write, not by this
 * callable directly.
 */
export async function markInvoicePaid(invoiceId: string, input: MarkInvoicePaidInput = {}): Promise<void> {
  await call<MarkInvoicePaidRequest, { ok: true; invoiceId: string; paymentId: string }>('markInvoicePaid', {
    invoiceId,
    ...input,
  });
}

/**
 * reviewAndSendDraftInvoice (admin): flips a DRAFT invoice to open and
 * dispatches the `invoice.new` notification to the household. Throws
 * `failed-precondition` if the invoice isn't currently a draft, or if it's
 * missing a total, household, or invoice number (fail loud on an incomplete
 * draft rather than sending it anyway), `not-found` if the id is wrong.
 */
export async function reviewAndSendDraftInvoice(invoiceId: string): Promise<void> {
  await call<{ invoiceId: string }, { ok: true; invoiceId: string }>('reviewAndSendDraftInvoice', { invoiceId });
}
