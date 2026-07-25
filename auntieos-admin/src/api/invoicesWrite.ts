import { call } from '../lib/fns';
import type { InvoiceLineItem } from './invoices';

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
  /**
   * Optional itemization, added by Task 5.1. ADDITIVE: omit it and the callable
   * behaves exactly as it always did, storing `total` / `amountDue` verbatim and
   * writing no cents field at all.
   *
   * SUPPLY IT AND `total` / `amountDue` MUST EQUAL THE SUM OF THE LINES. The
   * server REFUSES a disagreement (`invoice_total_mismatch`) rather than
   * silently overwriting the caller's figure, so both must come from the same
   * `lib/invoiceMath.ts` computation the composer already runs to show a live
   * total while the operator types. Never hand-enter a total beside line items.
   */
  lineItems?: InvoiceLineItem[];
  /** Whole-invoice reduction in integer cents. Only meaningful with `lineItems`. */
  invoiceDiscountCents?: number;
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
/* -------------------------------------------------------------------------
 * Task 5.1: editing, archiving and the un-invoiced-visits read.
 *
 * Every shape below was confirmed against the deployed handler, not guessed:
 * `updateInvoice.ts`, `archiveInvoice.ts`, `unarchiveInvoice.ts` and
 * `listUninvoicedSessions.ts`, plus their entries in
 * `mytribe/functions/CALLABLE_CONTRACT.md`.
 * ------------------------------------------------------------------------- */
/**
 * The editable slice of an invoice.
 *
 * THERE IS NO `total` FIELD HERE, AND THAT IS THE POINT. The server's `patch` is
 * `.strict()` and carries no total either, so a client that tries to assert what
 * an invoice is worth gets `invalid-argument` instead of having its number
 * quietly dropped. Every money figure is recomputed server-side from the line
 * items and the recorded payments, which is what makes the total a household
 * sees necessarily the sum of the lines it is shown.
 *
 * At least one field must be present. An empty patch is refused rather than
 * absorbed as a no-op, because it would stamp `updatedAt` and write an audit
 * entry describing a change that never happened.
 */
export interface InvoicePatch {
  invoiceNumber?: string;
  /** `YYYY-MM-DD`. The server rejects anything else. */
  date?: string;
  /** `YYYY-MM-DD`. */
  dueDate?: string;
  terms?: string;
  /**
   * The FULL replacement list, not a delta. Sending it recomputes the money, so
   * omit the key entirely on a metadata-only edit rather than echoing back what
   * is already stored: `updateInvoice` treats the key's PRESENCE as "this patch
   * touches money", which is what the edit gating turns on.
   */
  lineItems?: InvoiceLineItem[];
  /** Whole-invoice reduction, integer cents. Also counts as touching money. */
  invoiceDiscountCents?: number;
}
export interface InvoiceTotalsResult {
  subtotalCents: number;
  totalCents: number;
  paidCents: number;
  amountDueCents: number;
}
/**
 * updateInvoice (admin): edits an invoice's descriptive fields, its line items,
 * or both, and returns the money the server actually computed.
 *
 * IT WILL NOT RECOMPUTE AN UN-ITEMIZED INVOICE, which is the guard that matters
 * most on today's data: every invoice in the collection has zero line items, so
 * without it, correcting a due date would silently rewrite a real $40 invoice to
 * $0. A metadata patch against such an invoice leaves the money untouched.
 *
 * Throws `failed-precondition` with `details.code` of `invoice_not_editable`
 * (paid, cancelled, credit, redeemed), `invoice_money_locked` (a payment exists,
 * so the money is frozen while the metadata stays open), or
 * `invoice_money_invalid` (a discount larger than what it is taken off).
 * `not-found` if the id is wrong. Branch on the CODE, never the message.
 */
export async function updateInvoice(
  invoiceId: string,
  patch: InvoicePatch,
): Promise<InvoiceTotalsResult> {
  const res = await call<
    { invoiceId: string; patch: InvoicePatch },
    { ok: true; invoiceId: string; totals: InvoiceTotalsResult }
  >('updateInvoice', { invoiceId, patch });
  return res.totals;
}
/**
 * archiveInvoice (admin): stamps `archivedAt` / `archivedBy` so the invoice
 * drops out of the operator's working list and out of the outstanding and billed
 * totals.
 *
 * ARCHIVING IS NOT DELETION AND NOT CANCELLATION. The invoice keeps every field
 * it had, and the kinfolk portal is unaffected: the household still sees it and
 * can still pay it.
 *
 * `force` exists because archiving an invoice that money is still owed on
 * removes it from the very total that would remind anyone to collect it, which
 * is a decision to write off real money. Without `force` that is refused
 * (`failed-precondition`, `details.code: 'invoice_still_owing'`); with it the
 * audit entry records the write-off distinctly. A draft or a quote is exempt,
 * because neither was ever claimed from anyone.
 *
 * Re-archiving throws `invoice_already_archived` rather than succeeding
 * silently.
 */
export async function archiveInvoice(invoiceId: string, force = false): Promise<void> {
  await call<{ invoiceId: string; force?: boolean }, { ok: true; invoiceId: string }>('archiveInvoice', {
    invoiceId,
    ...(force ? { force: true } : {}),
  });
}
/**
 * unarchiveInvoice (admin): restores an archived invoice to the working list.
 *
 * Writes `archivedAt: null` rather than deleting the field, so a restored
 * invoice carries the same shape a future backfill would give every legacy
 * invoice, and because `isArchivedInvoice` already reads null as "not archived".
 * Throws `failed-precondition` when the invoice was not archived to begin with.
 */
export async function unarchiveInvoice(invoiceId: string): Promise<void> {
  await call<{ invoiceId: string }, { ok: true; invoiceId: string }>('unarchiveInvoice', { invoiceId });
}
/** One completed, un-invoiced visit, as the picker needs it. */
export interface UninvoicedSession {
  sessionId: string;
  kinfolkId: string;
  serviceType: string;
  durationMinutes: number;
  /** ISO-8601 instant. The server range-queries this LEXICALLY; it is a string, not a Timestamp. */
  startTime: string;
  /**
   * The rate-card price in integer cents, or NULL when it could not be priced.
   *
   * NULL IS NOT ZERO AND MUST NEVER BE RENDERED AS ZERO. A service the rate card
   * does not hold, a rate that will not parse, and a rate of zero all arrive
   * here as null, and the caller's job is to make the operator TYPE a price. A
   * silent 0 would bill a household nothing for real work and look deliberate on
   * the invoice.
   */
  unitCents: number | null;
}
export interface UninvoicedSessionsResult {
  sessions: UninvoicedSession[];
  /** The subset of `sessions` above with no usable rate. Prompt for each one. */
  unpriceable: Array<{ sessionId: string; serviceType: string }>;
  /**
   * False when `business_settings.serviceRates` is missing entirely, which
   * separates "this service is not on the card" from "there is no card". Those
   * need different sentences: the second is a settings problem, not a per-visit one.
   */
  rateCardLoaded: boolean;
  /** Rows read BEFORE filtering. An empty result over 400 scanned rows means something. */
  scanned: number;
  /** True when the server's page cap was reached, so the window may hold more. */
  truncated: boolean;
}
/**
 * listUninvoicedSessions (admin): completed visits in a date window that no
 * invoice has claimed yet, priced from the rate card where that is possible.
 * Reads only; writes nothing.
 *
 * `from` and `to` are INCLUSIVE `YYYY-MM-DD` days. The server compares them
 * lexically against `kin_care_sessions.startTime`, which is an ISO STRING rather
 * than a Timestamp, and filters both the completed status and the
 * already-invoiced check IN MEMORY. That is not laziness on the server's part:
 * `status` casing is unenforced, and `invoiceId` is ABSENT rather than empty on
 * most sessions, so either predicate applied server-side would silently drop
 * real work instead of billing for it.
 */
export async function listUninvoicedSessions(
  from: string,
  to: string,
): Promise<UninvoicedSessionsResult> {
  return call<{ from: string; to: string }, UninvoicedSessionsResult>('listUninvoicedSessions', {
    from,
    to,
  });
}
