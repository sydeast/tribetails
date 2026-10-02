import { zonedNow, FALLBACK_BUSINESS_TIME_ZONE } from './businessHours';

/**
 * The stored shape of one Google Calendar busy import, and the one pure place
 * that turns a busy interval into it (#1160).
 *
 * `booking_time_slots` rows carry `date`/`startTime`/`endTime` as plain wall
 * clock with no zone. Every client draws them on the BUSINESS's clock (admin
 * web, admin Android, and the desktop console since #1158), and operator-made
 * blocks are typed on that clock (#1155). Google imports used to be written
 * from `toISOString()`, so they were UTC and drew five or six hours away from
 * the real busy time for a Chicago business.
 *
 * A Google row now carries:
 *   - `date`/`startTime`/`endTime` on the business wall clock, the same clock
 *     an operator-made block uses, so every client draws it on the right row;
 *   - `startMs`/`endMs`, the real instants, which the server guard and
 *     Android's own busy check prefer over the wall clock;
 *   - `timeZone`, the zone the wall clock was written in.
 *
 * A legacy row (written before #1160) has no `startMs`, and its wall clock is
 * UTC. Readers recognise it by the missing instants and keep reading it as
 * UTC; see `decodeGoogleBusySlot` in `bookingBusyConflict.ts`.
 *
 * ONE ROW PER BUSINESS DAY. Every client places a block by its single `date`
 * and treats `endTime <= startTime` as a zero-length block, and an operator
 * block never crosses midnight. So an interval that crosses business midnight
 * is split at each midnight into one row per business day. A row that ends at
 * midnight stores `endTime: '23:59'`, because no client parses hour 24; its
 * `endMs` is the real midnight, so the minute is lost only on screen.
 */

export interface BusyInterval {
  start: string; // RFC3339
  end: string; // RFC3339
}

export interface BookingTimeSlotDoc {
  date: string; // YYYY-MM-DD, business calendar day
  startTime: string; // HH:mm, business wall clock
  endTime: string; // HH:mm, business wall clock
  /** Epoch ms of this row's start. Readers prefer it over the wall clock. */
  startMs: number;
  /** Epoch ms of this row's end. */
  endMs: number;
  /** The zone `date`/`startTime`/`endTime` were written in. */
  timeZone: string;
  isAvailable: false;
  slotType: 'BLOCKED';
  notes: string;
  source: 'GOOGLE_BUSY_IMPORT';
  externalEventId: string;
  externalCalendarId: string;
  hideDetailsFromKinfolk: true;
  isEditableByAdmin: true;
  isRemovableByAdmin: true;
  syncState: 'SYNCED';
  createdAt: string; // ISO-8601
}

/**
 * Upper bound on rows from one interval. freebusy clips intervals to the query
 * window, which is at most 90 days, so a real interval never reaches this. It
 * stops a malformed interval from turning one sync into thousands of writes.
 */
export const MAX_BUSY_DAY_PIECES = 92;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The real window of a row imported BEFORE #1160: its `date`/`startTime`/
 * `endTime` were written from `toISOString()`, so they are UTC. Rolls the end
 * to the next UTC day when `endTime <= startTime`, so a block spanning UTC
 * midnight decodes to its real window. Null for anything that does not parse.
 */
export function legacyUtcWindow(date: unknown, startTime: unknown, endTime: unknown): { startMs: number; endMs: number } | null {
  if (
    typeof date !== 'string' ||
    typeof startTime !== 'string' ||
    typeof endTime !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !/^\d{2}:\d{2}$/.test(startTime) ||
    !/^\d{2}:\d{2}$/.test(endTime)
  ) {
    return null;
  }
  const startMs = wallAsUtcMs(date, startTime);
  const sameDayEndMs = wallAsUtcMs(date, endTime);
  if (!Number.isFinite(startMs) || !Number.isFinite(sameDayEndMs)) return null;
  const endMs = endTime <= startTime ? sameDayEndMs + DAY_MS : sameDayEndMs;
  return endMs > startMs ? { startMs, endMs } : null;
}
/** The row's own instants when it carries usable ones (every row written since #1160), else null. */
export function storedInstants(data: Record<string, unknown>): { startMs: number; endMs: number } | null {
  const startMs = data['startMs'];
  const endMs = data['endMs'];
  if (typeof startMs !== 'number' || typeof endMs !== 'number') return null;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return { startMs, endMs };
}
/** Dedupe key for one interval. Unchanged from before #1160, so the next sync rewrites a legacy row in place. */
export function busyEventKey(calendarId: string, startMs: number, endMs: number): string {
  return `busy_${calendarId}_${startMs}_${endMs}`;
}

/** Key for piece `index` of an interval: the interval's own key for the first day, suffixed for each later day. */
export function busyPieceKey(eventKey: string, index: number): string {
  return index === 0 ? eventKey : `${eventKey}_d${index}`;
}

/** The zone to write in: the given one when `Intl` can read it, else the ruled default. */
function usableZone(timeZone: string): string {
  return zonedNow(0, timeZone) !== null ? timeZone : FALLBACK_BUSINESS_TIME_ZONE;
}

/** Wall clock read as if it were UTC, in ms. Used only to measure a zone's offset. */
function wallAsUtcMs(dateIso: string, hhmm: string): number {
  return Date.parse(`${dateIso}T${hhmm}:00.000Z`);
}

/**
 * The instant at which `dateIso` 00:00 begins in `timeZone`.
 *
 * Measures the zone's offset at a first guess and corrects once; a second pass
 * settles the guess when the first one landed across a DST change. Midnight
 * always exists in the zones this business uses (US changes happen at 02:00).
 */
export function zonedMidnightMs(dateIso: string, timeZone: string): number {
  const target = wallAsUtcMs(dateIso, '00:00');
  let guess = target;
  for (let i = 0; i < 2; i += 1) {
    const local = zonedNow(guess, timeZone);
    if (local === null) return target;
    guess -= wallAsUtcMs(local.dateIso, local.timeHHmm) - target;
  }
  return guess;
}

function nextDateIso(dateIso: string): string {
  return new Date(wallAsUtcMs(dateIso, '00:00') + DAY_MS).toISOString().slice(0, 10);
}

/** One business-day piece of an interval, in real instants. */
export interface BusyDayPiece {
  dateIso: string;
  startHHmm: string;
  endHHmm: string;
  startMs: number;
  endMs: number;
}

/**
 * Splits `[startMs, endMs)` at each business midnight. Empty for an empty or
 * unreadable interval.
 */
export function splitAtBusinessMidnight(startMs: number, endMs: number, timeZone: string): BusyDayPiece[] {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
  const zone = usableZone(timeZone);
  const pieces: BusyDayPiece[] = [];
  let cursor = startMs;
  while (cursor < endMs && pieces.length < MAX_BUSY_DAY_PIECES) {
    const local = zonedNow(cursor, zone);
    if (local === null) break;
    const nextMidnight = zonedMidnightMs(nextDateIso(local.dateIso), zone);
    const pieceEnd = Math.min(endMs, nextMidnight);
    const endsAtMidnight = pieceEnd >= nextMidnight;
    pieces.push({
      dateIso: local.dateIso,
      startHHmm: local.timeHHmm,
      endHHmm: endsAtMidnight ? '23:59' : zonedNow(pieceEnd, zone)?.timeHHmm ?? '23:59',
      startMs: cursor,
      endMs: pieceEnd,
    });
    cursor = pieceEnd;
  }
  return pieces;
}

/**
 * Pure mapping from a Google freebusy Busy interval to the
 * `booking_time_slots` rows that store it, one per business day.
 */
export function busyIntervalToSlots(
  interval: BusyInterval,
  calendarId: string,
  nowIso: string,
  timeZone: string,
): BookingTimeSlotDoc[] {
  const startMs = new Date(interval.start).getTime();
  const endMs = new Date(interval.end).getTime();
  return slotsForInstants(startMs, endMs, calendarId, nowIso, timeZone);
}

/** The same mapping from instants, so the backfill re-derives a legacy row exactly as a fresh sync would. */
export function slotsForInstants(
  startMs: number,
  endMs: number,
  calendarId: string,
  createdAt: string,
  timeZone: string,
): BookingTimeSlotDoc[] {
  const zone = usableZone(timeZone);
  const eventKey = busyEventKey(calendarId, startMs, endMs);
  return splitAtBusinessMidnight(startMs, endMs, zone).map((piece, index) => ({
    date: piece.dateIso,
    startTime: piece.startHHmm,
    endTime: piece.endHHmm,
    startMs: piece.startMs,
    endMs: piece.endMs,
    timeZone: zone,
    isAvailable: false,
    slotType: 'BLOCKED',
    notes: 'Imported busy event',
    source: 'GOOGLE_BUSY_IMPORT',
    externalEventId: busyPieceKey(eventKey, index),
    externalCalendarId: calendarId,
    hideDetailsFromKinfolk: true,
    isEditableByAdmin: true,
    isRemovableByAdmin: true,
    syncState: 'SYNCED',
    createdAt,
  }));
}
