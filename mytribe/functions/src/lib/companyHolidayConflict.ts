import type { Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { parseClosureEntry, closureOccurrencesInRange, type ClosureEntry } from './closureRecurrence';

/**
 * The one check every visit-creating (or visit-moving) write path shares: does
 * this candidate window land on a `business_settings.companyHolidays` closure?
 *
 * THE DEFECT THIS CLOSES (C1): `closureRecurrence.ts`'s own header used to say,
 * verbatim, that nothing read `companyHolidays` to decide bookability -- not
 * `bookingAvailability.ts`, not `api/availability.ts`, not any MyTribe
 * callable. PR #150 made a closure entry correct and durable, including yearly
 * recurrence, but never connected it to availability: marking a US national
 * holiday closed left every write path willing to book it. This module is
 * that connection, on the server, which is the only place a crafted request
 * cannot route around it (a client-side filter is a suggestion; Firestore
 * rules cannot evaluate `yearly-nth:11-4-4`-style recurrence math against
 * `get()`'d sibling data, so the callable boundary is where this has to live).
 *
 * UNLIKE `bookingBusyConflict.ts`, THIS GUARD HAS NO OVERRIDE. The busy-import
 * guard is advisory-grade information about the operator's OWN calendar (it
 * might be stale, it might be a personal event that isn't really blocking),
 * so an admin is allowed to knowingly write over it. A company holiday is the
 * opposite: it is the operator's OWN DELIBERATE, AUTHORED STATEMENT that the
 * business is closed that day (typed into `TimeOffEditor.tsx`, not imported
 * from a third party). There is no "the operator knows better than their own
 * setting" case to build an escape hatch for. If a closure was a mistake, the
 * fix is to edit or remove it in Settings, which immediately reopens every
 * future write on that date -- not to bypass the guard while the mistaken
 * entry is still on file. This also keeps the rule identical for a kinfolk
 * request and an admin-created one: "closed" means closed, for everybody,
 * full stop.
 *
 * TIMEZONE: a closure entry is a calendar date with no zone
 * (`business_settings.timeZone` exists on the doc but nothing in this
 * codebase reads it as a real conversion input -- see
 * `bookingAvailability.ts`'s header for the fuller rationale against
 * inventing that conversion here). A visit's `startTimeMs`/`endTimeMs` is a
 * real epoch instant. This module resolves the UTC calendar date(s) a visit's
 * window touches and checks THOSE against the closure list, the same
 * UTC-by-construction convention `bookingBusyConflict.ts` already uses for
 * its own hard write gate (as opposed to the advisory picker's un-converted
 * wall-clock comparison). Precisely like that module, this can misjudge which
 * calendar day a visit falls on for a business far from UTC and a visit very
 * close to UTC midnight; closing that fully would mean adopting a real,
 * validated business timezone, which nothing in this codebase does today.
 * Documented rather than silently wrong.
 */

/** Machine-readable `details.code` on the rejection, so a client can branch on it rather than the message. */
export const COMPANY_HOLIDAY_CONFLICT_CODE = 'company_holiday_conflict';

const BUSINESS_SETTINGS_DOC = 'business_settings/business_settings';

/** One visit's candidate window, in the same epoch-ms shape every write path already carries. */
export interface CandidateHolidayVisit {
  startTimeMs: number;
  /** Null/undefined/unparseable is treated as a one-millisecond point in time, same convention as `bookingBusyConflict.ts`. */
  endTimeMs?: number | null;
}

/** One candidate visit landing on one closure occurrence. */
export interface CompanyHolidayConflict {
  /** 0-based position in the caller's `visits` array, so a message can name "visit 2" rather than only the first. */
  visitIndex: number;
  /** The UTC calendar date (`YYYY-MM-DD`) the visit lands on. */
  dateIso: string;
  /** The closure's name, or a fallback when the operator left it blank. */
  holidayName: string;
}

/** UTC `YYYY-MM-DD` for a millisecond instant. */
function utcDateIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The UTC calendar date(s) a visit's window touches: just the start day for
 * anything under 24h (the overwhelming majority of visits), plus the end day
 * too when the window actually crosses a UTC midnight (an overnight service).
 * Empty when `startTimeMs` is not a finite number -- "cannot tell", treated as
 * "cannot conflict", same as `bookingBusyConflict.ts#resolveWindow`.
 */
export function utcDatesForVisit(v: CandidateHolidayVisit): string[] {
  if (!Number.isFinite(v.startTimeMs)) return [];
  const startMs = v.startTimeMs;
  const endMs =
    v.endTimeMs != null && Number.isFinite(v.endTimeMs) && v.endTimeMs > startMs ? v.endTimeMs : startMs + 1;
  const startIso = utcDateIso(startMs);
  const endIso = utcDateIso(endMs - 1); // -1ms: a window ending exactly at UTC midnight does not touch the next day.
  return startIso === endIso ? [startIso] : [startIso, endIso];
}

/** Pure: every visit whose window touches a closure occurrence. */
export function findCompanyHolidayConflicts(
  visits: readonly CandidateHolidayVisit[],
  entries: readonly ClosureEntry[],
): CompanyHolidayConflict[] {
  const conflicts: CompanyHolidayConflict[] = [];
  visits.forEach((visit, visitIndex) => {
    const dates = utcDatesForVisit(visit);
    for (const dateIso of dates) {
      for (const entry of entries) {
        if (closureOccurrencesInRange(entry, dateIso, dateIso).length > 0) {
          conflicts.push({ visitIndex, dateIso, holidayName: entry.name.trim() || 'a company holiday' });
          // One conflict per (visit, date) is enough to refuse the write; a
          // second matching entry on the same date would only repeat the
          // same refusal for the reader.
          break;
        }
      }
    }
  });
  return conflicts;
}

/** One human-readable, fail-loud message naming every conflicting visit and date, never just the first. */
export function formatCompanyHolidayConflictMessage(conflicts: readonly CompanyHolidayConflict[]): string {
  const parts = conflicts.map((c) => `visit ${c.visitIndex + 1} (${c.dateIso}) falls on ${c.holidayName}`);
  return `This date is not available: ${parts.join('; ')}. The business is closed.`;
}

/**
 * Reads and decodes `business_settings.companyHolidays`. Reuses
 * `parseClosureEntry`'s NEVER-THROWS contract: a corrupt or hand-edited
 * legacy row decodes to `recurrence: 'once', date: ''`, which
 * `closureOccurrencesInRange` always resolves to zero occurrences, so a bad
 * row can never falsely close (or, worse, throw and block) an otherwise
 * bookable day.
 */
export async function loadCompanyHolidayEntries(firestore: Firestore): Promise<ClosureEntry[]> {
  const snap = await firestore.doc(BUSINESS_SETTINGS_DOC).get();
  const raw = snap.data()?.companyHolidays;
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === 'string').map(parseClosureEntry);
}

export interface GuardCompanyHolidayOptions {
  firestore: Firestore;
  visits: readonly CandidateHolidayVisit[];
}

/**
 * The one call every write path makes. Loads the operator's closures, and
 * throws `failed-precondition` naming every conflicting visit and date when
 * any of them lands on one -- unconditionally; see the file header for why
 * there is no override parameter here, unlike `guardBookingBusyConflict`.
 * Resolves silently otherwise.
 */
export async function guardCompanyHolidayConflict(opts: GuardCompanyHolidayOptions): Promise<void> {
  const entries = await loadCompanyHolidayEntries(opts.firestore);
  if (entries.length === 0) return;

  const conflicts = findCompanyHolidayConflicts(opts.visits, entries);
  if (conflicts.length === 0) return;

  throw new HttpsError('failed-precondition', formatCompanyHolidayConflictMessage(conflicts), {
    code: COMPANY_HOLIDAY_CONFLICT_CODE,
    conflicts,
  });
}
