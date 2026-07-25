/**
 * Pure invoice classification + display helpers, kept out of the screen so the
 * mapping logic has direct vitest coverage (the denFormat.ts / FormSchemas.tsx
 * convention).
 *
 * THE AO-12 FIX, non-negotiable per the port brief: the wasm admin's
 * InvoiceFilters.kt decides "paid" by NEGATION, 
 *   invoiceIsPaid = !invoiceIsDraft(invoice) && !invoiceIsOutstanding(invoice)
 *, which is "not proven anything else, so call it paid". That is how an
 * unredeemed CREDIT (a refund owed TO the kinfolk, not a bill they paid)
 * rendered as a confident PAID chip in production. It is not ported here.
 *
 * Instead this module ENUMERATES every state as its own positive branch,
 * mirroring MyTribe/web/src/lib/invoiceFormat.ts's `invoiceStatusInfo` (the
 * already-corrected reference: draft / open / paid / cancelled / credit, with
 * credit split into credit-vs-redeemed by `creditRedeemedAtMs`) and
 * getMyInvoices.ts's `resolveStatus` (the backend's own authoritative
 * precedence: explicit free-text status first, then real money fields as
 * positive signals, never "whatever is left over"). Two states neither of
 * those two references models are added because the ADMIN's raw `invoices`
 * doc needs them: `quote` (the admin-only free-text status createQuote writes,
 * per InvoiceFilters.kt's `invoiceIsQuote`) and `zero` (a genuinely $0
 * invoice, nothing was billed, so it is NOT a claim that someone paid).
 */

/** Every state this module will ever return. One branch below produces each. */
export type InvoiceState = 'quote' | 'draft' | 'cancelled' | 'credit' | 'redeemed' | 'paid' | 'zero' | 'open';

/**
 * What `invoiceState` needs to decide. `status` is free-text on the source doc
 * (createInvoice.ts / postInvoiceEvent.ts write whatever the caller passed,
 * default `''`), never a validated enum, so it is read case-insensitively
 * and trimmed, same as the wasm's `invoiceIsQuote` / `invoiceIsDraft`.
 */
export interface InvoiceStateInput {
  status: string;
  /** Dollars still owed. Negative means a refund is owed instead (a credit). */
  amountDue: number;
  /** Dollars billed. Negative is the same credit signal as a negative amountDue. */
  total: number;
  /** True once `creditRedeemedAt` is present on the doc (redeemCredit.ts stamps it via FieldValue.serverTimestamp()). */
  creditRedeemed: boolean;
}

/** NaN/Infinity read as "no evidence", never as a false 0 that could tip a comparison the wrong way. */
function financeNumber(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

/**
 * Classifies one invoice. Every return is a POSITIVE read of either the
 * explicit `status` text or a real money field, nothing here is "not X, so
 * must be Y". Order is precedence, matching getMyInvoices.ts's resolveStatus:
 * an explicit status string wins; a negative balance is credit even without
 * the label; only then do we read amountDue/total to place an unlabeled row.
 */
export function invoiceState(row: InvoiceStateInput): InvoiceState {
  // Defensive on purpose: a doc predating the `status` field, or carrying only
  // the legacy `invoiceStatus` spelling, has no status at all. Reading it blind
  // threw "Cannot read properties of undefined" and the error boundary blanked
  // the WHOLE invoices page over ONE bad row. An unlabeled row still classifies
  // correctly from the money fields below, which is what this precedence order
  // was built for.
  const status = (row.status ?? '').trim().toLowerCase();
  const amountDue = financeNumber(row.amountDue);
  const total = financeNumber(row.total);

  if (status === 'quote') return 'quote';
  if (status === 'draft') return 'draft';
  if (status === 'cancelled') return 'cancelled';
  // A negative balance is the credit signal even when the label is missing or
  // stale (mirrors resolveStatus's `amountDue < 0 || total < 0 -> credit`).
  if (status === 'credit' || amountDue < 0 || total < 0) {
    return row.creditRedeemed ? 'redeemed' : 'credit';
  }
  if (status === 'paid') return 'paid';
  // Nothing explicit matched (status is 'open', '', or an unrecognized word).
  // From here every branch reads a real number, positively:
  if (amountDue > 0) return 'open'; // a balance is genuinely owed
  if (total === 0) return 'zero'; // nothing was ever billed, not a paid claim
  return 'paid'; // amountDue <= 0 and total > 0: the billed balance is retired
}

export interface InvoiceStateInfo {
  /** Friendly label for the row/detail chip. */
  label: string;
  /** Uppercased chip text. */
  chipLabel: string;
  /** CSS class suffix for `.invoices__chip--<cssClass>`. */
  cssClass: string;
}

/** Friendly label + chip class per enumerated state. Pure 1:1 map, no fallback branch. */
export function invoiceStateInfo(state: InvoiceState): InvoiceStateInfo {
  switch (state) {
    case 'quote':
      return { label: 'Quote', chipLabel: 'QUOTE', cssClass: 'quote' };
    case 'draft':
      return { label: 'Draft', chipLabel: 'DRAFT', cssClass: 'draft' };
    case 'cancelled':
      return { label: 'Cancelled', chipLabel: 'CANCELLED', cssClass: 'cancelled' };
    case 'credit':
      return { label: 'Credit', chipLabel: 'CREDIT', cssClass: 'credit' };
    case 'redeemed':
      return { label: 'Redeemed', chipLabel: 'REDEEMED', cssClass: 'redeemed' };
    case 'paid':
      return { label: 'Paid', chipLabel: 'PAID', cssClass: 'paid' };
    case 'zero':
      return { label: 'Zero balance', chipLabel: 'ZERO', cssClass: 'zero' };
    case 'open':
      return { label: 'Open', chipLabel: 'OPEN', cssClass: 'open' };
  }
}

/**
 * The consequential actions the invoice detail panel can offer. Keys match
 * InvoiceDetail.tsx's ACTIONS metadata one for one.
 */
export type InvoiceAction = 'reminder' | 'markPaid' | 'receipt' | 'reviewSend';

/**
 * Which actions an invoice in [state] may be offered. Lives HERE, beside the
 * classifier the Invoices list already filters and chips off, so the list and
 * the detail panel can never disagree about what an invoice is (the archive's
 * deliberate design: InvoiceFilters.kt decided both the row chip and the row's
 * available actions from one set of predicates).
 *
 * AO-19, the operator report this closes: the detail panel rendered its whole
 * ACTIONS array unconditionally, so a PAID invoice still offered "Mark paid"
 * (the server rejects it with failed-precondition) and "Send reminder" (which
 * would have nagged a household that already paid).
 *
 * TOTAL and NON-OVERLAPPING by construction:
 *   - Total: the switch enumerates all eight InvoiceState members with no
 *     `default`, so adding a ninth state is a compile error here rather than a
 *     silent "no actions" (or, worse, a silent "all actions") at runtime.
 *   - Non-overlapping: the argument is the single enumerated state, not a bag
 *     of independent booleans, so an invoice cannot be in two buckets at once.
 *
 * The OVERDUE edge case, ruled explicitly: overdue is NOT a state, it is a
 * display refinement of `open` (see `isInvoiceOverdue`, which returns false for
 * every other state by design). So "overdue AND draft" and "overdue AND quote"
 * are unrepresentable, not merely unhandled: a stale `dueDate` on a draft or a
 * quote is ignored, and neither can pick up a payment action. An overdue
 * invoice therefore gets exactly the outstanding set, which is why this takes
 * `state` alone and not an `overdue` flag.
 */
export function invoiceActionsFor(state: InvoiceState): readonly InvoiceAction[] {
  switch (state) {
    // A real, unpaid, non-draft/quote/credit balance: collect it.
    case 'open':
      return ['reminder', 'markPaid'];
    // Settled. A receipt is the only thing left to issue, and re-collecting is
    // exactly the bug this function exists to prevent.
    case 'paid':
      return ['receipt'];
    // Not sent yet, so there is nothing to remind about and nothing to collect.
    case 'draft':
      return ['reviewSend'];
    // A quote is not a bill. It gains payment actions only once it is converted
    // into an invoice, which is a different flow (createInvoice), not an action
    // on this row.
    case 'quote':
      return [];
    // Withdrawn: acting on it would contradict the withdrawal.
    case 'cancelled':
      return [];
    // Money owed TO the household. "Mark paid" and "Send reminder" would point
    // the wrong way; redemption is its own flow (redeemCredit), not this panel.
    case 'credit':
    case 'redeemed':
      return [];
    // Nothing was ever billed, so there is nothing to collect and nothing to
    // receipt. Deliberately NOT folded into `paid` (see invoiceState's note).
    case 'zero':
      return [];
  }
}

/** "$36.00" / "-$12.50" from a dollars-denominated amount. Ported verbatim from MyTribe's invoiceFormat.ts. */
export function formatUsd(dollars: number): string {
  const n = financeNumber(dollars);
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

/**
 * Normalizes a stored date string to a comparable YYYY-MM-DD prefix, or null
 * when unparseable/blank. `date`/`dueDate` are opaque free-text on the source
 * doc (createInvoice.ts's zod schema is `z.string().default('')`, not a
 * parsed Date), ported from the wasm's `isoDatePrefixOrNull` so a value like
 * "Net 14" never fabricates an ordering or an overdue verdict.
 */
export function isoDatePrefixOrNull(raw: string): string | null {
  const s = raw.trim();
  if (s.length < 10) return null;
  const candidate = s.slice(0, 10);
  if (candidate[4] !== '-' || candidate[7] !== '-') return null;
  for (let i = 0; i < candidate.length; i++) {
    if (i === 4 || i === 7) continue;
    const ch = candidate[i];
    if (ch === undefined || !/\d/.test(ch)) return null;
  }
  return candidate;
}

/**
 * "May 21" for a parseable date, or the raw string verbatim when it isn't
 * (fail-loud: show what's stored). Pass `refIso` (a local YYYY-MM-DD, e.g.
 * today) to disambiguate cross-year dates: a date whose year differs from the
 * reference gets the year appended ("May 21, 2025"), so a prior-year invoice
 * never silently reads as this year. Omit `refIso` for the bare month/day.
 */
export function humanizeDate(raw: string, refIso?: string): string {
  const iso = isoDatePrefixOrNull(raw);
  if (!iso) return raw.trim();
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const name = names[month - 1];
  if (!name) return raw.trim();
  const year = iso.slice(0, 4);
  const showYear = refIso !== undefined && year !== refIso.slice(0, 4);
  return showYear ? `${name} ${day}, ${year}` : `${name} ${day}`;
}

/**
 * True only when the invoice is `open` (a real, unpaid, non-draft/quote/credit
 * balance) AND its dueDate parses to an ISO date strictly before [todayIso]. A
 * future-dated or unparseable dueDate is never counted overdue, and neither is
 * any other state, a draft, quote, or credit is never "overdue" by definition,
 * so this reads `state`, not amountDue, as its first gate.
 */
export function isInvoiceOverdue(state: InvoiceState, dueDate: string, todayIso: string): boolean {
  if (state !== 'open') return false;
  const due = isoDatePrefixOrNull(dueDate);
  if (due === null) return false;
  return due < todayIso;
}

/**
 * Today as a local YYYY-MM-DD prefix, injected via `now` so it's testable at a
 * fixed instant.
 *
 * DIVERGENCE FROM THE WASM, deliberate (same call as denFormat.ts's
 * `denCurrentHour`): the wasm's `nowIso()` is `new Date().toISOString()`, i.e.
 * UTC, which is AO-18, an operator west of Greenwich sees invoices flip
 * "overdue" hours before their local midnight. This reads the LOCAL calendar
 * date instead, so it does not reproduce that bug.
 */
export function localDateIso(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
