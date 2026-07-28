/**
 * Pure invoice DISPLAY helpers, kept out of the screen so the mapping logic has
 * direct vitest coverage (the denFormat.ts / FormSchemas.tsx convention).
 *
 * WHAT IS DELIBERATELY NOT HERE ANYMORE: the classifier. This module used to
 * hold `invoiceState`, an 8-state re-derivation of the invoice's state from its
 * money fields (the AO-12 fix, ported from the wasm). Per ADR-0002 the server
 * now persists the Invoice State Classifier's verdict onto every invoice doc as
 * `status` + `editScope`, in the same write as every money change, and
 * firestore.rules denies all client invoice writes, so the state a client would
 * re-derive is at best redundant and at worst a second opinion. Clients render
 * the persisted state and never classify: read the stamp through
 * `api/invoices.ts#invoiceStamp` and hand the stored state to the helpers here.
 *
 * Everything below either formats a value (currency, dates) or maps an
 * ALREADY-DECIDED state to a rendering (chip metadata, offered actions, the
 * overdue/part-paid display refinements). Nothing below decides what state an
 * invoice is in.
 */
import type { InvoiceState } from '../api/invoices';

/** NaN/Infinity read as "no evidence", never as a false 0 that could tip a comparison the wrong way. */
function financeNumber(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

export interface InvoiceStateInfo {
  /** Friendly label for the row/detail chip. */
  label: string;
  /** Uppercased chip text. */
  chipLabel: string;
  /** CSS class suffix for `.invoices__chip--<cssClass>`. */
  cssClass: string;
}

/** Friendly label + chip class per stamped state. Pure 1:1 map, no fallback branch. */
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
 * The chip for a doc that carries NO recognizable state stamp. ADR-0002 makes
 * that doc impossible — every writer stamps, the backfill stamped the backlog,
 * the rules deny client writes — so this is the DELIBERATE fail-soft kept
 * visible in code, not a normal branch:
 *
 *   - it renders what the doc actually says (`status` lowercased, or "Unknown"
 *     when even that is blank), never a state re-derived from the money fields.
 *     No silent re-classification;
 *   - its consumers pair it with the safe affordance set: no actions, no
 *     editing (`invoiceStamp` already answered editScope 'none').
 */
export function unstampedStateInfo(rawStatus: unknown): InvoiceStateInfo {
  const raw = typeof rawStatus === 'string' ? rawStatus.trim().toLowerCase() : '';
  const label = raw === '' ? 'Unknown' : raw;
  return { label, chipLabel: label.toUpperCase(), cssClass: 'unknown' };
}

/**
 * The consequential actions the invoice detail panel can offer. Keys match
 * InvoiceDetail.tsx's ACTIONS metadata one for one.
 */
export type InvoiceAction = 'reminder' | 'markPaid' | 'receipt' | 'reviewSend';

/**
 * Which actions an invoice in [state] may be offered. [state] is the STORED
 * stamp, so the list chip and the detail panel read the same persisted verdict
 * and can never disagree about what an invoice is.
 *
 * AO-19, the operator report this closes: the detail panel rendered its whole
 * ACTIONS array unconditionally, so a PAID invoice still offered "Mark paid"
 * (the server rejects it with failed-precondition) and "Send reminder" (which
 * would have nagged a household that already paid).
 *
 * TOTAL and NON-OVERLAPPING by construction:
 *   - Total: the switch enumerates all eight stamped states with no `default`,
 *     so a ninth state is a compile error here rather than a silent "no
 *     actions" (or, worse, a silent "all actions") at runtime.
 *   - Non-overlapping: the argument is the single stamped state, not a bag of
 *     independent booleans, so an invoice cannot be in two buckets at once.
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
    // receipt. Deliberately NOT folded into `paid`: "no bill" is a different
    // claim than "someone paid".
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
 * True only when the STORED state is `open` (a real, unpaid, non-draft/quote/
 * credit balance) AND the dueDate parses to an ISO date strictly before
 * [todayIso]. A future-dated or unparseable dueDate is never counted overdue,
 * and neither is any other state — a draft, quote, or credit is never
 * "overdue" by definition, so this reads the stamp, not amountDue, as its
 * first gate. Accepts null (an unstamped doc) and answers false: no stamp, no
 * overdue verdict.
 */
export function isInvoiceOverdue(state: InvoiceState | null, dueDate: string, todayIso: string): boolean {
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
/**
 * What has been collected against an invoice, and what is left, in cents.
 * Returns null when the invoice is not part-paid.
 *
 * PART-PAID IS A DISPLAY REFINEMENT OF `open`, NOT A NINTH STATE, exactly like
 * `isInvoiceOverdue` above and for the same reason: it changes the chip and the
 * copy, it never changes which actions the invoice may be offered. A part-paid
 * invoice is still an open invoice with a real balance, so it keeps the whole
 * outstanding action set, which is precisely what makes collecting the rest
 * possible. Making it a state would have forced `invoiceActionsFor` to enumerate
 * it, and the first person to write `case 'partPaid': return []` would have
 * reintroduced the defect this whole change exists to remove.
 *
 * READS `paidCents`, NEVER `total - amountDue`. Those are float dollars, and on
 * every invoice the pre-2026-07-25 write touched `amountDue` reads 0 while a
 * real balance is owed, so the subtraction would report the whole total as
 * collected on exactly the rows that are wrong. An invoice with no `paidCents`
 * at all is not claimed to be part-paid, because we have no record that it is.
 *
 * Accepts null (an unstamped doc) and answers null: no stamp, no part-paid
 * claim.
 */
export interface InvoicePartialPayment {
  paidCents: number;
  remainingCents: number;
}
export function invoicePartialPayment(
  state: InvoiceState | null,
  row: { paidCents?: number; amountDue: number },
): InvoicePartialPayment | null {
  if (state !== 'open') return null;
  const paidCents = row.paidCents;
  if (typeof paidCents !== 'number' || !Number.isInteger(paidCents) || paidCents <= 0) return null;
  const remainingCents = Math.round(financeNumber(row.amountDue) * 100);
  if (remainingCents <= 0) return null;
  return { paidCents, remainingCents };
}
