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
 *   - AN ARCHIVED BILL and an unaccepted quote are the two above; the third
 *     refusal, `legacy_balance_unproven`, is gone. See below.
 *
 * ── THE LEGACY TOTAL-ONLY SHAPE, AFTER #902 ───────────────────────────────
 *
 * When #871 shipped, a document with a positive `total` and no finite
 * `amountDue` classified `paid`, because the classifier read a missing balance
 * as zero. This module refused to chase one unless its own payment rows PROVED a
 * balance — at least one row, summing to less than the total — and called that
 * refusal `legacy_balance_unproven`. It was a local patch around a classifier
 * reading #871 deliberately left to #902.
 *
 * #902 settled it: a missing balance is DERIVED, by one shared rule
 * (`lib/amountDueRule.ts`), and a legacy bill nobody has paid owes its total. So
 * the shape classifies `open` and is chased like any other live bill, and the
 * patch is retired rather than worked around.
 *
 * THE PAYMENT ROWS STILL MATTER, and that is why `evidence` survives. The rule
 * settles a stated-nothing bill from its rows when a caller holds them, and only
 * the rows can say that a legacy bill was paid off before `amountDue` existed.
 * A caller that reads them hands them here and gets `paid` — refused, `not_open`
 * — for a bill whose rows cover its total. A caller that cannot read them gets
 * the conservative `open`. `legacyEvidenceWanted` says which documents are worth
 * the extra read, so no caller pays for it on an ordinary invoice.
 */
import { invoiceStateOf, quoteAcceptanceOf, type InvoiceState } from './invoiceEditPolicy';
import { isArchived } from './invoiceArchive';
import { invoiceTotalCentsOf } from './invoiceMath';
import { statesNoBalance } from './amountDueRule';

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

/**
 * `legacy_balance_unproven` was removed by #902 rather than left unreachable.
 * The shape it described is now classified, not special-cased, so a bill whose
 * rows cover its total refuses as `not_open` like every other settled bill, and
 * one nobody paid is chased. A dead member would have callers still branching on
 * a reason nothing can produce.
 */
export type ChaseRefusalReason = 'archived' | 'unaccepted_quote' | 'not_open';

export interface ChaseRefusal {
  reason: ChaseRefusalReason;
  /** The classifier's reading, so a caller can say which state refused it. */
  state: InvoiceState;
}

function label(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

/**
 * IS THIS DOCUMENT WORTH READING THE PAYMENT ROWS FOR, before deciding whether
 * to chase it?
 *
 * True for the legacy total-only shape: a positive total and no stated balance
 * at all. That is the one document the classifier cannot settle from itself —
 * the rule reads it as owing its whole total, and only the rows can show that it
 * was in fact paid off before `amountDue` existed. Every other invoice is
 * decided from the document alone and costs no extra read, which is what keeps
 * the reminder cron's cost proportional to the collection rather than to it.
 *
 * #902 renamed this from `isLegacyTotalOnly`, whose body asked whether the
 * classifier said `paid` — a question that only had that answer BECAUSE of the
 * defect. Asking it now would return false for every document and quietly stop
 * anyone reading the rows.
 */
export function legacyEvidenceWanted(doc: ChaseDoc): boolean {
  if (!statesNoBalance(doc)) return false;
  if (label(doc.status) === 'paid') return false;
  return invoiceTotalCentsOf(doc) > 0;
}

/**
 * Why this invoice may not be chased, or null when it may.
 *
 * `evidence` is the invoice's own payment rows when the caller read them
 * (`legacyEvidenceWanted` says when that is worth doing) and null otherwise. It
 * reaches the classifier rather than a branch of its own: see the header.
 */
export function chaseRefusalOf(doc: ChaseDoc, evidence: PaymentEvidence | null): ChaseRefusal | null {
  const state = invoiceStateOf(doc, evidence === null ? null : evidence.paidCents);
  if (isArchived(doc)) return { reason: 'archived', state };
  const quoteLabelled = label(doc.status) === 'quote' || label(doc.invoiceStatus) === 'quote';
  if (quoteLabelled && quoteAcceptanceOf(doc) !== 'accepted') return { reason: 'unaccepted_quote', state };
  if (state === 'open') return null;
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
