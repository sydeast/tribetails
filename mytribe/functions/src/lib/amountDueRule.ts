/**
 * WHAT AN INVOICE OWES WHEN IT DOES NOT SAY. The single rule (#902).
 *
 * THE DEFECT THIS EXISTS TO CLOSE. `invoices/{id}` predates `amountDue`. Every
 * migrated document, and every invoice written by the system this one replaced,
 * carries a `total` and no balance at all. Two readers then disagreed about the
 * same document:
 *
 *   `invoiceStateOf` (lib/invoiceEditPolicy.ts) read the missing field as 0, so
 *   `{ status: 'sent', total: 40 }` classified `paid`. The portal showed it
 *   settled, the edit policy froze it, and the chase senders stood down.
 *
 *   `collectableForAutoApply` (triggers/onInvoiceAutoApply.ts) read the missing
 *   field as "no stated balance, so go and look", and account credit was drawn
 *   against the same document.
 *
 * So a household could have credit spent on a bill their portal called paid, or
 * pay a bill and be told nothing. Money moved on the difference between two
 * readings of one document, which is why the answer is a rule and not a patch
 * in each reader.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────
 *
 * A STATED BALANCE IS ALWAYS THE ANSWER, whatever it says. `amountDue: 0` on a
 * bill whose payments fall short is the pre-2026-07-25 partial-payment
 * corruption, and it is `lib/invoicePaymentRepair.ts`'s to fix from the payment
 * rows, deliberately and under an operator's eye. Re-deriving it here would
 * re-open invoices that pass has already repaired, and would do it silently. A
 * stated NEGATIVE balance is this codebase's credit signal (invoiceMath.ts says
 * so at length) and passes through untouched.
 *
 * ONLY A MISSING BALANCE IS DERIVED, and from two things in this order:
 *
 *   1. THE PAYMENT ROWS, when the caller has them: total minus what came in.
 *      The rows are the only field that can answer "how much has been
 *      collected" (same reasoning as `paidCentsFromPayments`).
 *   2. THE STATUS LABEL, when the caller has no rows — which is the same branch
 *      as "the rows exist and sum to nothing", on purpose. A label that asserts
 *      the bill is closed (`paid`, `cancelled`, `credit`, `redeemed`) means
 *      nothing is collectable from the household, so 0. Every other label,
 *      including no label at all, means the whole total is still owed.
 *
 * WHY "NO ROWS" AND "ROWS SUMMING TO ZERO" MUST BE ONE BRANCH. Two of the
 * readers are PURE functions over a document — `invoiceStateOf` and
 * `collectableForAutoApply` cannot fetch a subcollection and must not start.
 * The other three (the chase senders, the portal response builder, the backfill)
 * do hold the rows. If the no-rows branch answered differently from the
 * zero-rows branch, those two populations of readers would disagree about the
 * same document again, which is the entire defect. They do not: a caller that
 * passes `null` gets exactly what a caller holding zero rows gets.
 *
 * THE DERIVED FIGURE IS NEVER NEGATIVE. An overpaid legacy bill clamps to 0 and
 * the excess is reported, never minted into a credit: a negative `amountDue` is
 * read as a credit owed TO the household by three classifiers, and a derivation
 * must not create a financial instrument nobody issued. `settleInvoice` makes
 * the same call for the same reason. Money collected beyond a legacy total is an
 * account-balance matter for the operator (there are no refunds), and
 * `reportLegacyAmountDue.ts` counts those documents so they can be looked at.
 *
 * ZERO IMPORTS BUT ONE. `invoiceMath.ts` imports nothing at all, and this module
 * takes only its `invoiceTotalCentsOf`, because "what is this invoice worth" is
 * already answered once there and asking it twice is how the two readings above
 * happened. Everything else here is arithmetic on its result, so this module
 * stays safe to import from the pure classifier, the triggers, the callables,
 * the scripts and the tests alike.
 */
import { invoiceTotalCentsOf } from './invoiceMath';

/** The fields the rule reads. All unknown: real documents are missing keys. */
export interface AmountDueDoc {
  amountDue?: unknown;
  amountDueCents?: unknown;
  total?: unknown;
  totalCents?: unknown;
  status?: unknown;
}

/**
 * Labels that assert the household owes nothing, so a missing balance is 0
 * rather than the total.
 *
 *   paid       its writer asserted the settlement; the stamp only canonicalizes it.
 *   cancelled  withdrawn. A cancelled bill is not collectable by any path.
 *   credit     the money points the other way: the OFFICE owes the household.
 *   redeemed   that credit has already been turned into account balance.
 *
 * Deliberately NOT here: `draft`, `quote`, `sent`, `open`, `overdue`,
 * `past_due`, an unknown label and no label at all. None of them says the bill
 * was collected, and a bill nobody has paid owes its total. A draft or a quote
 * is not yet a demand for money, but what it WOULD demand is still its total,
 * and that is what its own classifier state (`draft`/`quote`) keeps the office
 * from chasing.
 */
export const SETTLED_LABELS: readonly string[] = ['paid', 'cancelled', 'credit', 'redeemed'];

function label(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

/**
 * The balance the document STATES, in cents, or null when it states none.
 *
 * `amountDueCents` is the integer truth where it exists and `amountDue` is its
 * float dollar projection, the same precedence and the same reason as
 * `invoiceTotalCentsOf`. A non-finite value (NaN, Infinity) states nothing: it
 * is a broken write, not a balance, and reading it as one would put NaN into
 * every comparison downstream.
 *
 * Returning null rather than 0 for "absent" is the whole point of this function:
 * `0` and `absent` are the two readings the defect confused, and no caller of
 * the rule can conflate them again without deleting this type.
 */
export function statedAmountDueCents(doc: AmountDueDoc): number | null {
  const cents = doc.amountDueCents;
  if (typeof cents === 'number' && Number.isInteger(cents)) return cents;
  const dollars = doc.amountDue;
  if (typeof dollars === 'number' && Number.isFinite(dollars)) return Math.round(dollars * 100);
  return null;
}

/** True when the document states no balance at all, which is the only case the rule derives. */
export function statesNoBalance(doc: AmountDueDoc): boolean {
  return statedAmountDueCents(doc) === null;
}

/**
 * WHAT THIS INVOICE OWES, in cents. THE SINGLE ANSWER.
 *
 * `paidCents` is the sum of the invoice's `payments` SUBCOLLECTION
 * (`invoiceMath.ts#paidCentsFromPayments`) when the caller holds it, and `null`
 * when the caller is a pure reader that cannot fetch it. Those two are the same
 * branch whenever nothing has been collected; see the header.
 *
 * A stated balance is returned verbatim, negative included. Only a derived
 * figure is clamped at zero.
 */
export function amountDueCentsOf(doc: AmountDueDoc, paidCents: number | null): number {
  const stated = statedAmountDueCents(doc);
  if (stated !== null) return stated;

  const totalCents = invoiceTotalCentsOf(doc);
  const paid = typeof paidCents === 'number' && Number.isFinite(paidCents) ? Math.round(paidCents) : 0;
  if (paid > 0) return Math.max(0, totalCents - paid);

  return SETTLED_LABELS.includes(label(doc.status)) ? 0 : Math.max(0, totalCents);
}

/**
 * The dollar projection of the rule, for the readers whose field is the legacy
 * float (`invoiceStateOf`'s `amountDue`, the portal DTO, the backfill's write).
 *
 * `Number((cents / 100).toFixed(2))` rather than a bare division, for the reason
 * `invoiceMath.ts#centsToDollars` gives: the division alone can land on a value
 * whose shortest representation carries more than two decimals, and that number
 * is what gets rendered as money. Restated here rather than imported so this
 * module's only import stays the one the header justifies.
 */
export function amountDueDollarsOf(doc: AmountDueDoc, paidCents: number | null): number {
  return Number((amountDueCentsOf(doc, paidCents) / 100).toFixed(2));
}

/**
 * Collected BEYOND a derived total, in cents. Zero unless the rows overshoot a
 * legacy bill that states no balance.
 *
 * Reported, never written: per the standing operator ruling there are no
 * refunds, so an overdraw is money that belongs on the household's account
 * balance, put there deliberately by an operator. The report script counts these
 * documents so the operator can see them; nothing here acts on one.
 */
export function legacyOverpaidCentsOf(doc: AmountDueDoc, paidCents: number | null): number {
  if (statedAmountDueCents(doc) !== null) return 0;
  const paid = typeof paidCents === 'number' && Number.isFinite(paidCents) ? Math.round(paidCents) : 0;
  if (paid <= 0) return 0;
  return Math.max(0, paid - invoiceTotalCentsOf(doc));
}
