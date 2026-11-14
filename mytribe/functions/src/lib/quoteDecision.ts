/**
 * What a household's answer to a quote is made of: the decision vocabulary,
 * the mark on a quote saved unsent, which quotes the household may see, and
 * the business's own calendar day (the reminder cron's, since quotes stopped
 * expiring).
 *
 * Pure apart from `businessTodayIso`, which reads one settings doc.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { FALLBACK_BUSINESS_TIME_ZONE, loadBusinessHoursSettings, zonedNow } from './businessHours';
import { isArchived } from './invoiceArchive';

export { FALLBACK_BUSINESS_TIME_ZONE };

/** What a household said about a quote. Stored on the invoice as `quoteDecision`. */
export type QuoteDecision = 'accepted' | 'denied';

export const QUOTE_DECISIONS = ['accepted', 'denied'] as const;

/** The stored decision, or null when the field is absent or is not one of the two. */
export function quoteDecisionOf(raw: unknown): QuoteDecision | null {
  return raw === 'accepted' || raw === 'denied' ? raw : null;
}

/**
 * #2088, operator ruling 2026-11-12: A QUOTE DOES NOT EXPIRE. It is an invoice
 * status, and it stays a quote until the Kinfolk accepts or declines it or the
 * office changes it (sends it, turns it into an invoice, withdraws it). Its
 * `dueDate` is the date the invoice it becomes is due, never a "good through"
 * date, so nothing here measures a quote against the calendar any more.
 */

/**
 * #2087: THE MARK ON A QUOTE SAVED WITH "SEND TO KINFOLK NOW" OFF. Operator
 * ruling 2026-11-13: such a quote is a Draft only the office sees. It is stored
 * as a draft (`status` and `invoiceStatus` both 'draft', so every rule that
 * keeps a draft away from the household and from collection applies to it) and
 * carries `quoteDraft: true`, so sending it makes it a Quote rather than a bill.
 * Sending, turning it into an invoice or withdrawing it removes the mark. A
 * positive mark, never an absence: a quote made before this rule carries no
 * mark and stays the sent quote it always was.
 */
export const QUOTE_DRAFT_FIELD = 'quoteDraft';

function statusOf(doc: Record<string, unknown>): string {
  const raw = doc['status'] ?? doc['invoiceStatus'];
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/** A quote saved unsent: a draft carrying the quote mark. */
export function isQuoteDraft(doc: Record<string, unknown>): boolean {
  return statusOf(doc) === 'draft' && doc[QUOTE_DRAFT_FIELD] === true;
}

/** A quote the household has been sent (answered or not): `status` 'quote'. */
export function isSentQuote(doc: Record<string, unknown>): boolean {
  return statusOf(doc) === 'quote';
}

/**
 * Whether MyTribe keeps this invoice away from the household altogether: not
 * listed, not counted, not openable, not payable, not answerable, and not
 * linked from a visit.
 *
 *   - #1906 (operator ruling 2026-11-11): EVERY UNSENT DRAFT. An invoice the
 *     office has not sent is the office's alone; the household hears about it
 *     when it is sent. That takes in the two quote cases that came first:
 *       - #2087: a quote saved unsent (`isQuoteDraft`);
 *       - #2088: a quote the office turned into an invoice not sent yet;
 *   - #2195: an archived quote. Archiving a quote works like archiving a draft:
 *     the household stops seeing it and its visits go back on the list.
 *   - a withdrawn quote (`cancelled`, stamped `quoteWithdrawnAt`). No list
 *     bucket ever showed one, but its PDF was still served by id: the office
 *     took the offer back, so nothing of it stays in front of the household.
 *
 * The one rule for every household read: `getMyInvoices` (list, buckets and
 * totals, and so the detail page and any deep link, which both open from that
 * list), `getMyInvoicePdf`, `payInvoice`, `redeemCredit`, the quote answer, and
 * the completed-visit invoice link (`portalVisitLinks.ts`).
 */
export function hiddenFromHousehold(doc: Record<string, unknown>): boolean {
  const status = statusOf(doc);
  if (status === 'draft') return true;
  if (status === 'cancelled' && doc['quoteWithdrawnAt'] !== undefined && doc['quoteWithdrawnAt'] !== null) return true;
  return status === 'quote' && isArchived(doc);
}

/**
 * Today, on the business's own wall clock, as `YYYY-MM-DD` — or '' when the
 * zone could not be resolved.
 *
 * This function runs in `us-central1` on a UTC machine, so "today" here is
 * five or six hours ahead of the operator's for part of every evening. Reading
 * the UTC day would put an evening reminder on the wrong day, which
 * is exactly the sort of quiet wrongness `businessHours.ts` was written about.
 */
export async function businessTodayIso(firestore: Firestore, nowMs: number): Promise<string> {
  const settings = await loadBusinessHoursSettings(firestore);
  const stored = typeof settings?.timeZone === 'string' ? settings.timeZone.trim() : '';
  const zone = stored !== '' ? stored : FALLBACK_BUSINESS_TIME_ZONE;
  // A stored zone `Intl` cannot parse falls back to the ruled zone rather than
  // to UTC, and only a failure of BOTH yields '' (and the caller skips
  // its day check rather than guessing one).
  const now = zonedNow(nowMs, zone) ?? zonedNow(nowMs, FALLBACK_BUSINESS_TIME_ZONE);
  return now?.dateIso ?? '';
}
