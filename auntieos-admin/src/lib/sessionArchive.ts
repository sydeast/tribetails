import { businessInstantMs, businessWallClock, businessWallClockToMs } from './businessZoneTime';
import { RECENT_WINDOW_DAYS, shiftDayIso, type SessionDayGroup } from './sessionFormat';

/**
 * #2036: the Auntie Time Archive's date range, read on the BUSINESS's calendar.
 *
 * The FROM and TO boxes used to go to Firestore as bare `YYYY-MM-DD` strings
 * compared against stored instants, so both ends were cut at UTC midnight: for
 * a business in America/Chicago that is 18:00 or 19:00 the evening before, and
 * an evening visit landed on the wrong day or on none.
 *
 * A stored `startTime` has two shapes (`businessInstantMs`): an instant with a
 * `Z` or an offset, and a zone-less wall clock that is already the business's.
 * No single string bound sorts both correctly, so the query reaches a day wider
 * on each side (`archiveFetchBounds`) and the exact cut is made here, on
 * instants: FROM is the start of that business day, TO runs to the start of the
 * day after it. Both whole days are in.
 */

/** How many days the Archive's opening range covers. */
export const ARCHIVE_DEFAULT_SPAN_DAYS = 30;

/** An inclusive `YYYY-MM-DD` range, both ends business days. */
export interface ArchiveRange {
  from: string;
  to: string;
}

/**
 * The range the Archive opens on: the 30 days ending the day before Recent
 * begins. Recent holds what wrapped today or yesterday (`RECENT_WINDOW_DAYS`),
 * so this picks up the very next day back and no wrapped visit sits between
 * the two lists. It used to end 31 days back, which left most of a month in
 * neither. [todayIso] is today on the business's calendar.
 */
export function archiveDefaultRange(todayIso: string): ArchiveRange {
  const to = shiftDayIso(todayIso, -(RECENT_WINDOW_DAYS + 1));
  return { from: shiftDayIso(to, -(ARCHIVE_DEFAULT_SPAN_DAYS - 1)), to };
}

/**
 * The bare-day bounds the query asks for: one day before FROM, and up to but
 * not including two days after TO. Wide enough that every row of the picked
 * business days is fetched whichever shape its `startTime` has and whichever
 * side of UTC the business sits on; `isInArchiveRange` makes the real cut.
 */
export function archiveFetchBounds(range: ArchiveRange): { fromDay: string; beforeDay: string } {
  return { fromDay: shiftDayIso(range.from, -1), beforeDay: shiftDayIso(range.to, 2) };
}

/**
 * The picked days as instants: `[startMs, endMs)`, from the first moment of the
 * FROM day to the first moment of the day after TO, on the business's clock.
 * The end is found by date and not by adding hours, so a 23 or 25 hour day at
 * a clock change is still one whole day. Null when a day does not read.
 */
export function archiveInstantRange(
  range: ArchiveRange,
  businessZone: string,
): { startMs: number; endMs: number } | null {
  const startMs = businessWallClockToMs(range.from, '00:00', businessZone);
  const endMs = businessWallClockToMs(shiftDayIso(range.to, 1), '00:00', businessZone);
  if (startMs === null || endMs === null) return null;
  return { startMs, endMs };
}

/** Whether a stored `startTime` falls on one of the picked business days. */
export function isInArchiveRange(
  startTime: string | undefined,
  range: ArchiveRange,
  businessZone: string,
): boolean {
  const raw = (startTime ?? '').trim();
  const ms = businessInstantMs(raw, businessZone);
  const bounds = archiveInstantRange(range, businessZone);
  if (ms === null || bounds === null) {
    // A start that does not parse cannot be placed on a clock. Its own leading
    // day decides, so the row still shows (under "Undated") instead of vanishing.
    const day = raw.slice(0, 10);
    return day >= range.from && day <= range.to;
  }
  return ms >= bounds.startMs && ms < bounds.endMs;
}

/** The fetched rows that belong to the picked business days. */
export function archiveRows<T extends { startTime?: string | undefined }>(
  rows: readonly T[],
  range: ArchiveRange,
  businessZone: string,
): T[] {
  return rows.filter((row) => isInArchiveRange(row.startTime, range, businessZone));
}

/**
 * Archive rows under the BUSINESS day each starts on, days ascending and rows
 * ascending inside a day, with `'Undated'` last. The day a card sits under is
 * then the same day the FROM and TO boxes counted it on.
 */
export function groupArchiveByBusinessDay<T extends { startTime?: string | undefined }>(
  rows: readonly T[],
  businessZone: string,
): SessionDayGroup<T>[] {
  const byDay = new Map<string, { row: T; ms: number }[]>();
  for (const row of rows) {
    const ms = businessInstantMs(row.startTime ?? '', businessZone);
    const key = ms === null ? 'Undated' : businessWallClock(ms, businessZone).dateIso;
    const list = byDay.get(key);
    const item = { row, ms: ms ?? 0 };
    if (list) list.push(item);
    else byDay.set(key, [item]);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => {
      if (a === 'Undated') return b === 'Undated' ? 0 : 1;
      if (b === 'Undated') return -1;
      return a < b ? -1 : a > b ? 1 : 0;
    })
    .map(([dayKeyValue, items]) => ({
      dayKeyValue,
      rows: [...items].sort((a, b) => a.ms - b.ms).map((i) => i.row),
    }));
}
