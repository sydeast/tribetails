/**
 * What a household's answer to a quote is made of: the decision vocabulary, the
 * expiry arithmetic, and the business's own calendar day to measure it against.
 *
 * Pure apart from `businessTodayIso`, which reads one settings doc. The two
 * pure halves live here rather than inside the callable because an off-by-one
 * day in the expiry check is invisible in an integration test and obvious in a
 * unit test.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { loadBusinessHoursSettings, zonedNow } from './businessHours';

/** What a household said about a quote. Stored on the invoice as `quoteDecision`. */
export type QuoteDecision = 'accepted' | 'denied';

export const QUOTE_DECISIONS = ['accepted', 'denied'] as const;

/**
 * OPERATOR RULING 2026-08-11 (see `businessHours.ts`): the business runs on
 * `America/Chicago`. Used only when the settings doc carries no usable zone —
 * the stored value still wins, so a relocation is a settings change and not a
 * deploy.
 */
export const FALLBACK_BUSINESS_TIME_ZONE = 'America/Chicago';

/** The stored decision, or null when the field is absent or is not one of the two. */
export function quoteDecisionOf(raw: unknown): QuoteDecision | null {
  return raw === 'accepted' || raw === 'denied' ? raw : null;
}

/** The `YYYY-MM-DD` shape `lib/invoiceDay.ts` pins `date`/`dueDate` to. */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whether a quote's `dueDate` has passed, given the business's local day.
 *
 * A QUOTE IS GOOD THROUGH ITS DUE DATE, not up to it: a quote due 2026-08-18
 * can still be accepted all day on the 18th and is expired on the 19th. Both
 * strings are zero-padded `YYYY-MM-DD`, which sorts lexically exactly as it
 * sorts chronologically (the whole reason `invoiceDay.ts` enforces that shape),
 * so this is a string comparison and needs no date parsing.
 *
 * NEVER GUESSES. A blank due date means the quote does not expire — most quotes
 * in this collection carry none, and inventing a deadline for them would refuse
 * an acceptance on a rule nobody wrote down. A due date in any other format,
 * and a blank `todayIso` (an unreadable business time zone), both read as "no
 * evidence of expiry" for the same reason.
 */
export function quoteHasExpired(dueDate: unknown, todayIso: string): boolean {
  if (typeof dueDate !== 'string') return false;
  const due = dueDate.trim();
  if (!DAY_RE.test(due)) return false;
  if (!DAY_RE.test(todayIso)) return false;
  return todayIso > due;
}

/**
 * Today, on the business's own wall clock, as `YYYY-MM-DD` — or '' when the
 * zone could not be resolved.
 *
 * This function runs in `us-central1` on a UTC machine, so "today" here is
 * five or six hours ahead of the operator's for part of every evening. Reading
 * the UTC day would expire a quote at 6pm Central on its last valid day, which
 * is exactly the sort of quiet wrongness `businessHours.ts` was written about.
 */
export async function businessTodayIso(firestore: Firestore, nowMs: number): Promise<string> {
  const settings = await loadBusinessHoursSettings(firestore);
  const stored = typeof settings?.timeZone === 'string' ? settings.timeZone.trim() : '';
  const zone = stored !== '' ? stored : FALLBACK_BUSINESS_TIME_ZONE;
  // A stored zone `Intl` cannot parse falls back to the ruled zone rather than
  // to UTC, and only a failure of BOTH yields '' (which switches the expiry
  // check off; see `quoteHasExpired`).
  const now = zonedNow(nowMs, zone) ?? zonedNow(nowMs, FALLBACK_BUSINESS_TIME_ZONE);
  return now?.dateIso ?? '';
}
