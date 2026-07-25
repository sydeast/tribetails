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
  /**
   * Dollar amount actually collected. MAY BE PARTIAL. Omit to settle whatever
   * the recorded payments leave outstanding (server default).
   */
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

/** Where an invoice stands after a payment, derived server-side from every recorded payment. */
export type InvoiceSettlementState = 'unpaid' | 'partial' | 'settled' | 'overpaid';

export interface MarkInvoicePaidResult {
  paymentId: string;
  state: InvoiceSettlementState;
  totalCents: number;
  /** Every payment on record, including the one just made. */
  paidCents: number;
  /** Still owed. Never negative. */
  amountDueCents: number;
  /** Collected beyond the total. Zero unless `state` is 'overpaid'. */
  overpaidCents: number;
}

/**
 * markInvoicePaid (admin): records a payment, WHICH MAY BE PARTIAL, and writes a
 * `payments` subcollection entry (amount/method/reference/paidAt/recordedBy) in
 * the SAME batch as the invoice's money fields, so a manual payment is never
 * recorded without its audit trail.
 *
 * THE SERVER DERIVES THE INVOICE'S STATE FROM THE SUM OF ITS RECORDED PAYMENTS,
 * not from the single `amount` sent here. A payment that does not cover the
 * total leaves the invoice OPEN with a real remaining balance and returns
 * `state: 'partial'`; only a settling payment marks it paid. Until 2026-07-25
 * this callable wrote `paid` with `amountDue: 0` for ANY amount, which is how
 * $20 against a $40 invoice made the remaining $20 uncollectable: the invoice
 * dropped out of Outstanding and the next call was refused as already-paid.
 *
 * Omit `amount` to settle whatever is still outstanding.
 *
 * An OVERPAYMENT settles the invoice, leaves `amountDueCents` at 0 (never
 * negative, which is this codebase's credit signal) and reports the excess as
 * `overpaidCents` for the operator to act on deliberately.
 *
 * Throws `failed-precondition` when the invoice is already settled, when it is
 * marked paid with no recorded payments to reconcile against, when it is still a
 * draft or quote, or when it is cancelled or a credit. `not-found` if the id is
 * wrong. The `invoice.payment.applied` notification is dispatched by the
 * backend's `onInvoicesWrite` trigger off the resulting write, not by this
 * callable, and it does not fire for a partial because the invoice is not paid.
 */
export async function markInvoicePaid(
  invoiceId: string,
  input: MarkInvoicePaidInput = {},
): Promise<MarkInvoicePaidResult> {
  const res = await call<MarkInvoicePaidRequest, { ok: true; invoiceId: string } & MarkInvoicePaidResult>(
    'markInvoicePaid',
    { invoiceId, ...input },
  );
  return {
    paymentId: res.paymentId,
    state: res.state,
    totalCents: res.totalCents,
    paidCents: res.paidCents,
    amountDueCents: res.amountDueCents,
    overpaidCents: res.overpaidCents,
  };
}

// ── repairInvoicePayments (functions/src/admin/repairInvoicePayments.ts) ─────

/** Why a scanned invoice was left alone by the repair pass. */
export type RepairSkipReason =
  | 'no_payments'
  | 'payments_cover_total'
  | 'no_total'
  | 'balance_already_correct'
  | 'would_lower_balance';

export interface RepairFinding {
  invoiceId: string;
  invoiceNumber: string | null;
  kinfolkId: string | null;
  totalCents: number;
  paidCents: number;
  /** What the doc currently claims is owed. */
  claimedAmountDueCents: number;
  /** What the recorded payments say is owed. */
  correctAmountDueCents: number;
  understatedCents: number;
  status: string;
}

export interface RepairInvoicePaymentsResult {
  mode: 'detect' | 'repair';
  scanned: number;
  findings: RepairFinding[];
  repaired: number;
  skipped: Record<RepairSkipReason, number>;
  /** Pass back as `startAfterId` for the next page, or null when the sweep is done. */
  nextCursor: string | null;
}

/**
 * repairInvoicePayments (admin): finds, and optionally repairs, invoices wrecked
 * by the pre-2026-07-25 partial-payment write, which marked an invoice paid with
 * a zero balance however little was actually collected.
 *
 * `detect` (the default) READS AND REPORTS ONLY. Run it first: it lists every
 * affected invoice with what it currently claims and what its recorded payments
 * say it should be, and writes nothing. `repair` restores the balance.
 *
 * The repair is IDEMPOTENT and NEVER LOWERS A BALANCE: it only ever raises an
 * understated one, so re-running it is safe and the worst it can do is decline
 * to fix something. Pages explicitly, one page per call, via `nextCursor`.
 */
export async function repairInvoicePayments(
  input: { mode?: 'detect' | 'repair'; limit?: number; startAfterId?: string } = {},
): Promise<RepairInvoicePaymentsResult> {
  const res = await call<typeof input, { ok: true } & RepairInvoicePaymentsResult>(
    'repairInvoicePayments',
    input,
  );
  return {
    mode: res.mode,
    scanned: res.scanned,
    findings: res.findings,
    repaired: res.repaired,
    skipped: res.skipped,
    nextCursor: res.nextCursor,
  };
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
