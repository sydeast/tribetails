import type { Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { parseClosureEntry, closureOccurrencesInRange, type ClosureEntry } from './closureRecurrence';
import { businessCalendarDate, businessTimeZone } from './bookingTimeBlocks';

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
 * TIMEZONE (#1093): a closure entry is a calendar date with no zone, and it
 * means the BUSINESS's day. A visit's `startTimeMs`/`endTimeMs` is a real
 * epoch instant, so this module resolves the business calendar date(s) the
 * visit's window covers in `business_settings.timeZone` (`businessCalendarDate`,
 * the same reader `requestBooking` keys a visit's day with) and checks THOSE.
 * It used to check the UTC date, which put a 21:00 visit in a US zone on the
 * next day's closure and off its own. A blank or unusable zone falls back to
 * the UTC date, `businessCalendarDate`'s own rule.
 */

/** Machine-readable `details.code` on the rejection, so a client can branch on it rather than the message. */
export const COMPANY_HOLIDAY_CONFLICT_CODE = 'company_holiday_conflict';

const BUSINESS_SETTINGS_DOC = 'business_settings/business_settings';

/**
 * One visit's candidate window, in the same epoch-ms shape every write path
 * already carries, OR (#1098) a bare calendar date for a visit that has no start
 * instant yet.
 */
export type CandidateHolidayVisit =
  | {
      startTimeMs: number;
      /** Null/undefined/unparseable is treated as a one-millisecond point in time, same convention as `bookingBusyConflict.ts`. */
      endTimeMs?: number | null;
    }
  | {
      /**
       * #1098: an Overnight requested as a NIGHT has no start until the operator
       * sets one on approval, but a closed day must still refuse the request.
       * The date is the business's own (`requestBooking` keyed it in the
       * business zone) and is checked as given, with no conversion.
       */
      dateIso: string;
    };

/** One candidate visit landing on one closure occurrence. */
export interface CompanyHolidayConflict {
  /** 0-based position in the caller's `visits` array, so a message can name "visit 2" rather than only the first. */
  visitIndex: number;
  /** The business calendar date (`YYYY-MM-DD`) the visit lands on. */
  dateIso: string;
  /** The closure's name, or a fallback when the operator left it blank. */
  holidayName: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Every `YYYY-MM-DD` from `fromIso` to `toIso` inclusive, by calendar arithmetic (no instants, so no DST). */
function calendarDatesBetween(fromIso: string, toIso: string): string[] {
  const from = Date.parse(`${fromIso}T00:00:00.000Z`);
  const to = Date.parse(`${toIso}T00:00:00.000Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return [fromIso];
  const out: string[] = [];
  for (let ms = from; ms <= to; ms += DAY_MS) out.push(new Date(ms).toISOString().slice(0, 10));
  return out;
}

/**
 * The business calendar date(s) a visit's window covers, in `timeZone`: the
 * start's date through the date its last minute is on, so a visit crossing
 * midnight (an overnight) covers both. A window ending exactly at midnight does
 * not touch the next day. A null end is a one-millisecond point, the
 * `bookingBusyConflict.ts` convention. A bare `dateIso` (a night with no start
 * yet) is already the business's date and is returned as given. Empty when
 * `startTimeMs` is not a finite number: "cannot tell", treated as "cannot
 * conflict", same as `bookingBusyConflict.ts#resolveWindow`.
 */
export function businessDatesForVisit(v: CandidateHolidayVisit, timeZone: string): string[] {
  if ('dateIso' in v) return /^\d{4}-\d{2}-\d{2}$/.test(v.dateIso) ? [v.dateIso] : [];
  if (!Number.isFinite(v.startTimeMs)) return [];
  const startMs = v.startTimeMs;
  const endMs =
    v.endTimeMs != null && Number.isFinite(v.endTimeMs) && v.endTimeMs > startMs ? v.endTimeMs : startMs + 1;
  return calendarDatesBetween(businessCalendarDate(startMs, timeZone), businessCalendarDate(endMs - 1, timeZone));
}

/** {@link businessDatesForVisit} for a business on UTC. */
export function utcDatesForVisit(v: CandidateHolidayVisit): string[] {
  return businessDatesForVisit(v, 'UTC');
}

/**
 * Pure: every visit whose window touches a closure occurrence. `timeZone` is
 * `business_settings.timeZone`; blank falls back to UTC dates.
 */
export function findCompanyHolidayConflicts(
  visits: readonly CandidateHolidayVisit[],
  entries: readonly ClosureEntry[],
  timeZone = '',
): CompanyHolidayConflict[] {
  const conflicts: CompanyHolidayConflict[] = [];
  visits.forEach((visit, visitIndex) => {
    const dates = businessDatesForVisit(visit, timeZone);
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
  return (await loadCompanyHolidaySettings(firestore)).entries;
}

/** The closures plus the zone their dates are in (#1093), from the one settings read. */
async function loadCompanyHolidaySettings(
  firestore: Firestore,
): Promise<{ entries: ClosureEntry[]; timeZone: string }> {
  const snap = await firestore.doc(BUSINESS_SETTINGS_DOC).get();
  const data = snap.data();
  const raw = data?.companyHolidays;
  const entries = Array.isArray(raw)
    ? raw.filter((x): x is string => typeof x === 'string').map(parseClosureEntry)
    : [];
  return { entries, timeZone: businessTimeZone(data) };
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
  const { entries, timeZone } = await loadCompanyHolidaySettings(opts.firestore);
  if (entries.length === 0) return;

  const conflicts = findCompanyHolidayConflicts(opts.visits, entries, timeZone);
  if (conflicts.length === 0) return;

  throw new HttpsError('failed-precondition', formatCompanyHolidayConflictMessage(conflicts), {
    code: COMPANY_HOLIDAY_CONFLICT_CODE,
    conflicts,
  });
}
