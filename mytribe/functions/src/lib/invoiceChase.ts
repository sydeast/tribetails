/**
 * Whether an invoice may be CHASED: sent a payment reminder or an overdue notice
 * (#871). Pure, so every sender asks one question and the tests can walk every
 * state through it.
 *
 * THE RULE. A household is chased only about a live bill: an invoice the one
 * classifier (`invoiceStateOf`, lib/invoiceEditPolicy.ts) reads as `open`. That
 * is the same reading the portal's Pay button, the admin web and Android
 * `invoiceActionsFor`, and the admin overdue chips already use, so a notice goes
 * out exactly where an operator sees "Send reminder" and "Overdue".
 *
 * Before #871 the crons and the reminder button each carried their own `isPaid`
 * (a `paid` label, `paymentStatus: 'PAID'`, or `amountDue <= 0`). A cancelled
 * invoice, an unaccepted quote, a draft or a credit with `amountDue > 0` passed
 * all three.
 *
 * THREE EXTRA REFUSALS on top of the state, each conservative:
 *   - ARCHIVED. `archiveInvoice` writes a bill off when forced. Chasing a bill
 *     the office wrote off would contradict the office.
 *   - A QUOTE LABEL ON EITHER SPELLING without an acceptance. `acceptQuote`
 *     moves `status` and `invoiceStatus` to `open` together, so an accepted
 *     quote is an ordinary open bill here. A doc still labelled `quote` in
 *     either field and never accepted is refused even if its other field says
 *     `open`: nobody agreed to pay it.
 *   - THE LEGACY TOTAL-ONLY SHAPE. A doc with a positive `total` and no finite
 *     `amountDue` classifies `paid`, because a missing balance is no evidence of
 *     one. Whether that reading is right is #902's question, and this module does
 *     not change the classifier. It is chased only when the invoice's own payment
 *     rows PROVE a balance: at least one row, summing to less than the total.
 *     No rows proves nothing (a legacy bill settled before rows were written
 *     looks the same), so no rows means no notice.
 */
import { invoiceStateOf, quoteAcceptanceOf, type InvoiceState } from './invoiceEditPolicy';
import { isArchived } from './invoiceArchive';
import { invoiceTotalCentsOf } from './invoiceMath';

/** The raw fields this module reads. All optional: real docs are missing keys. */
export interface ChaseDoc {
  status?: unknown;
  invoiceStatus?: unknown;
  amountDue?: unknown;
  total?: unknown;
  totalCents?: unknown;
  creditRedeemedAt?: unknown;
  quoteDecision?: unknown;
  archivedAt?: unknown;
  dueDate?: unknown;
  invoiceDueDate?: unknown;
  [k: string]: unknown;
}

/** What the invoice's `payments` subcollection says, for the legacy shape only. */
export interface PaymentEvidence {
  rows: number;
  paidCents: number;
}

export type ChaseRefusalReason = 'archived' | 'unaccepted_quote' | 'not_open' | 'legacy_balance_unproven';

export interface ChaseRefusal {
  reason: ChaseRefusalReason;
  /** The classifier's reading, so a caller can say which state refused it. */
  state: InvoiceState;
}

function label(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

/**
 * True for the legacy shape whose balance only payment rows can settle: a
 * positive total, no finite `amountDue`, not labelled paid, and classified
 * `paid` for want of a balance.
 */
export function isLegacyTotalOnly(doc: ChaseDoc): boolean {
  const amountDue = doc.amountDue;
  if (typeof amountDue === 'number' && Number.isFinite(amountDue)) return false;
  if (label(doc.status) === 'paid') return false;
  if (invoiceStateOf(doc) !== 'paid') return false;
  return invoiceTotalCentsOf(doc) > 0;
}

/** Why this invoice may not be chased, or null when it may. */
export function chaseRefusalOf(doc: ChaseDoc, evidence: PaymentEvidence | null): ChaseRefusal | null {
  const state = invoiceStateOf(doc);
  if (isArchived(doc)) return { reason: 'archived', state };
  const quoteLabelled = label(doc.status) === 'quote' || label(doc.invoiceStatus) === 'quote';
  if (quoteLabelled && quoteAcceptanceOf(doc) !== 'accepted') return { reason: 'unaccepted_quote', state };
  if (state === 'open') return null;
  if (isLegacyTotalOnly(doc)) {
    const proven = evidence !== null && evidence.rows > 0 && evidence.paidCents < invoiceTotalCentsOf(doc);
    return proven ? null : { reason: 'legacy_balance_unproven', state };
  }
  return { reason: 'not_open', state };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The invoice's due day as `YYYY-MM-DD`, or null. Writers stamp `dueDate`
 * (lib/invoiceDay.ts pins it to that shape); `invoiceDueDate` is read as the
 * legacy spelling. A longer ISO string contributes its day prefix, the same
 * reading every admin client applies, so the server and the chips agree.
 */
export function invoiceDueDayOf(doc: ChaseDoc): string | null {
  for (const raw of [doc.dueDate, doc.invoiceDueDate]) {
    if (typeof raw !== 'string') continue;
    const day = raw.trim().slice(0, 10);
    if (DAY_RE.test(day)) return day;
  }
  return null;
}

function epochDay(day: string): number {
  return Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
}

/**
 * Whole days past due on the business's calendar, or null when not overdue.
 * STRICTLY BEFORE: due today is due, not overdue, as every client says.
 */
export function daysPastDue(dueDay: string | null, todayIso: string): number | null {
  if (dueDay === null || !DAY_RE.test(todayIso)) return null;
  if (!(dueDay < todayIso)) return null;
  return epochDay(todayIso) - epochDay(dueDay);
}

/** True when the due day falls on today or within the next [windowDays] days. */
export function isDueWithin(dueDay: string | null, todayIso: string, windowDays: number): boolean {
  if (dueDay === null || !DAY_RE.test(todayIso)) return false;
  const diff = epochDay(dueDay) - epochDay(todayIso);
  return diff >= 0 && diff <= windowDays;
}
