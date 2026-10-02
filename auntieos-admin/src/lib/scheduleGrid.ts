import { buildRescheduleTimes, visitDurationMinutes, type DurationSource, type RescheduleTimes } from './bookingDetailFormat';
import { businessInstantMs, businessWallClock } from './businessZoneTime';

/**
 * The week time-grid arithmetic behind the Schedule screen's calendar, and the
 * drop-to-reschedule math behind dragging a visit on it (#397 M13).
 *
 * PURE ON PURPOSE. A drag is a pointer gesture, and jsdom has no `PointerEvent`
 * to fire; a component test can assert that the callable was reached but it is a
 * poor place to prove that 9:07 snaps to 9:00 and that a 90-minute visit dropped
 * there ends at 10:30. Every number the grid depends on is decided here, where a
 * unit test states it outright, and the component is left holding only the
 * pointer bookkeeping.
 *
 * THE NUMBERS ARE PORTED, NOT INVENTED. They come from the operator's own mock
 * (`auntieos-admin/ui-ideas/auntieos-schedule-2026-05-27.html`, "drag a visit to
 * reschedule · snaps to 15 min") and from the desktop admin's shipped Compose
 * grid (`web/composeApp/.../schedule/ScheduleScreen.kt`), which the mock's
 * comment already claims parity with. An 8a-to-6p window at 54px an hour is that
 * screen's geometry, not a fresh guess, so the two admin surfaces draw the same
 * calendar.
 */

/** First hour drawn. Visits earlier than this are counted and named, never silently dropped — see `offWindowCount`. */
export const GRID_START_HOUR = 8;
/** Bottom edge, EXCLUSIVE: 18 means the last drawn row is 5p-6p. */
export const GRID_END_HOUR = 18;
export const GRID_HOURS = GRID_END_HOUR - GRID_START_HOUR;

/** Pixels per hour row. 54 comes from the desktop grid's `HOUR_HEIGHT = 54.dp`, so one minute is 0.9px. */
export const HOUR_HEIGHT_PX = 54;

export const GRID_START_MINUTE = GRID_START_HOUR * 60;
export const GRID_END_MINUTE = GRID_END_HOUR * 60;

/**
 * Shortest block the grid will draw, in minutes. A 10-minute visit rendered at
 * its true 9px is an unreadable sliver and, worse, an untappable one. Capped by
 * the room actually left below the block so a visit starting at 5:55p cannot be
 * drawn past the bottom edge.
 */
export const MIN_BLOCK_MINUTES = 20;

/**
 * Snap granularity when the operator's "Snap drag-to-reschedule to 15 min"
 * setting is ON, and when it is off.
 *
 * `business_settings.snapRescheduleTo15Min` already exists, is already editable
 * in Settings (`screens/settings/sections.tsx`), and until this screen gained a
 * drag it had no consumer on web at all — the desktop admin was the only surface
 * that honoured it. Default OFF means minute precision, which is what that
 * screen does (`ScheduleScreen.kt`: `if (snapRescheduleTo15Min) 15 else 1`).
 * NOTE the trap: the Kotlin helper's own default parameter is 15 while the
 * shipped screen passes 1, so "the default" depends on which you read. The
 * SCREEN wins, here as there.
 */
export const SNAP_MINUTES_ON = 15;
export const SNAP_MINUTES_OFF = 1;

/**
 * THE GRID IS DRAWN ON THE BUSINESS'S CLOCK (#1158), `business_settings.timeZone`.
 *
 * Rows, day columns, "today", the now line and the drop all read that one zone,
 * so a visit at 14:00 in the business sits on the 14:00 row whatever zone the
 * operator's device is in, and a drop on the 15:00 row writes 15:00 there. The
 * busy overlay's `HH:mm` is already that wall clock (Block time types it on the
 * business clock, #1155), so it lines up with the visits it sits beside.
 *
 * Minute-of-day for a stored visit time on the BUSINESS's clock, or null when it does not parse. */
export function businessMinutesOfDay(iso: string | undefined, businessZone: string): number | null {
  if (typeof iso !== 'string') return null;
  const ms = businessInstantMs(iso, businessZone);
  if (ms === null) return null;
  const [h, m] = businessWallClock(ms, businessZone).hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

/** The business day (`YYYY-MM-DD`) a stored visit time falls on, or null when it does not parse. */
export function businessDayOf(iso: string | undefined, businessZone: string): string | null {
  if (typeof iso !== 'string') return null;
  const ms = businessInstantMs(iso, businessZone);
  return ms === null ? null : businessWallClock(ms, businessZone).dateIso;
}

/** Minute-of-day right now on the business's clock, for the grid's now line. */
export function businessMinutesNow(businessZone: string, nowMs: number = Date.now()): number {
  const [h, m] = businessWallClock(nowMs, businessZone).hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

/**
 * "09:00 to 17:00" on the business's clock, the agenda row's window, so the row
 * under the grid shows the same hour as the block above it. Same fallbacks as
 * `sessionWindow`: a known start alone, a known end alone, else "Time TBD".
 */
export function businessWindowLabel(startIso: string, endIso: string, businessZone: string): string {
  const clock = (iso: string): string | null => {
    const ms = businessInstantMs(iso, businessZone);
    return ms === null ? null : businessWallClock(ms, businessZone).hhmm;
  };
  const start = clock(startIso);
  const end = clock(endIso);
  if (start === null && end === null) return 'Time TBD';
  if (end === null) return start!;
  if (start === null) return end;
  return `${start} to ${end}`;
}

/** Minute-of-day for a plain `HH:mm` wall clock, or null. Used by the busy overlay, whose rows store no zone. */
export function minutesFromHHmm(hhmm: string | undefined): number | null {
  if (typeof hhmm !== 'string') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** `"HH:mm"` for a minute-of-day, clamped into a real clock rather than rolling over. */
export function hhmmFromMinutes(minuteOfDay: number): string {
  const clamped = Math.min(Math.max(Math.round(minuteOfDay), 0), 23 * 60 + 59);
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Gutter label: `8a`, `12p`, `1p`. Matches the desktop grid's `hourLabel`. */
export function hourLabel(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  const suffix = h < 12 ? 'a' : 'p';
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}${suffix}`;
}

/** Where one block sits in its day column. */
export interface GridPlacement {
  topPx: number;
  heightPx: number;
}

/**
 * Places a block, or returns null when its start falls outside the drawn window.
 *
 * NULL IS NOT "hide it and say nothing". The screen counts what this refuses and
 * says so in a line under the grid, the same honesty the desktop grid keeps:
 * a visit at 7am exists whether or not the calendar has a row for it.
 *
 * The height is clamped UP to {@link MIN_BLOCK_MINUTES} for legibility and DOWN
 * to the room left below the block, in that order, so a short visit near the
 * bottom edge is drawn as small as the space allows rather than overflowing.
 */
export function gridPlacement(startMinute: number, durationMinutes: number): GridPlacement | null {
  if (!Number.isFinite(startMinute)) return null;
  if (startMinute < GRID_START_MINUTE || startMinute >= GRID_END_MINUTE) return null;
  const roomToBottom = GRID_END_MINUTE - startMinute;
  const minVisible = Math.min(MIN_BLOCK_MINUTES, roomToBottom);
  const raw = Number.isFinite(durationMinutes) && durationMinutes > 0 ? durationMinutes : MIN_BLOCK_MINUTES;
  const shown = Math.min(Math.max(raw, minVisible), roomToBottom);
  return {
    topPx: (HOUR_HEIGHT_PX * (startMinute - GRID_START_MINUTE)) / 60,
    heightPx: (HOUR_HEIGHT_PX * shown) / 60,
  };
}

/** Places a busy overlay from the two `HH:mm` strings a `booking_time_slots` row stores. */
export function busyPlacement(
  startHHmm: string | undefined,
  endHHmm: string | undefined,
): GridPlacement | null {
  const start = minutesFromHHmm(startHHmm);
  if (start === null) return null;
  const end = minutesFromHHmm(endHHmm);
  const realEnd = end !== null && end > start ? end : start + MIN_BLOCK_MINUTES;
  // Wholly above or below the window there is no honest place to draw it.
  if (realEnd <= GRID_START_MINUTE || start >= GRID_END_MINUTE) return null;
  // A block that straddles an edge is clamped into view: it still refuses bookings,
  // so it has to be seen. The label and title carry the real times.
  const top = Math.max(start, GRID_START_MINUTE);
  return gridPlacement(top, Math.min(realEnd, GRID_END_MINUTE) - top);
}
/** Minute-of-day for a vertical offset inside a day column, un-snapped and un-clamped. */
export function minuteFromOffsetPx(offsetPx: number): number {
  return GRID_START_MINUTE + Math.round((offsetPx / HOUR_HEIGHT_PX) * 60);
}

/**
 * Snaps a minute-of-day DOWN to the grid granularity.
 *
 * Floor, not nearest, because that is what `rescheduleArgsForDrop`
 * (`domain/Stage2Step2Helpers.kt`, shared by Android and the desktop admin)
 * does: `(dropMinuteOfDay / snap) * snap` on integers. Rounding to nearest here
 * would mean the same gesture lands on a different quarter-hour depending on
 * which admin surface the operator is using.
 */
export function snapMinuteOfDay(minuteOfDay: number, snapMinutes: number): number {
  const snap = Number.isFinite(snapMinutes) && snapMinutes > 0 ? Math.round(snapMinutes) : 1;
  return Math.floor(Math.round(minuteOfDay) / snap) * snap;
}

/** Holds a drop inside the drawn window, so a block can never be released above 8a or past the last drawable minute. */
export function clampDropMinute(minuteOfDay: number): number {
  return Math.min(Math.max(Math.round(minuteOfDay), GRID_START_MINUTE), GRID_END_MINUTE - 1);
}

/**
 * The minute-of-day a drop lands on: where the block's top edge ended up,
 * clamped into the window, then snapped.
 *
 * CLAMP BEFORE SNAP. The other order lets a snap push the value back out of the
 * window it was just clamped into (17:59 clamped, then snapped to 15, is 17:45 —
 * fine — but 18:05 snapped first is 18:00, which is the exclusive bottom edge
 * and not a drawable minute at all).
 */
export function dropMinuteFromOffsetPx(offsetPx: number, snapMinutes: number): number {
  return snapMinuteOfDay(clampDropMinute(minuteFromOffsetPx(offsetPx)), snapMinutes);
}

/** The one row the drop math needs off a session: its id, its window, and its stated duration. */
export interface DraggableVisit extends DurationSource {
  _id: string;
}

/**
 * The `{startTime, endTime}` a drop maps to, or null when the drop cannot be
 * turned into a real window (a blank id, an impossible day).
 *
 * THE END COMES FROM THE VISIT, NOT FROM THE POINTER. A drag moves a visit; it
 * does not resize one. The pointer decides only where the block STARTS, and the
 * length is `visitDurationMinutes` — the stored `serviceDurationMinutes` when
 * the row has one, else its original start-to-end span, else 30 minutes. That is
 * the same three-source rule the detail sheet's Reschedule form already uses and
 * the same one `resolveDurationMinutes` uses on the other two clients, so a
 * visit dragged on the grid and a visit rescheduled through the form come out
 * exactly the same length.
 *
 * Built on `buildRescheduleTimes` rather than formatting the strings here, so
 * the drag and the form emit ONE shape: UTC-suffixed ISO, matching what
 * `approveBookingSeriesCore` writes. (The Kotlin clients emit a zone-LESS local
 * string on this same field; `bookingDetailFormat.ts` documents that as the
 * AO-18 write-side bug this web app deliberately does not repeat.)
 */
export function rescheduleTimesForDrop(
  visit: DraggableVisit,
  targetDayIso: string,
  dropMinuteOfDay: number,
  snapMinutes: number,
  businessZone: string,
): RescheduleTimes | null {
  if (visit._id.trim() === '') return null;
  const snapped = snapMinuteOfDay(clampDropMinute(dropMinuteOfDay), snapMinutes);
  // Built on the clock the grid is drawn on, so the visit lands on the row it was dropped on.
  return buildRescheduleTimes(targetDayIso, hhmmFromMinutes(snapped), visitDurationMinutes(visit), businessZone);
}

/**
 * Whether a drop actually changes anything: same day, same snapped minute, no
 * write. Stops a stray click that jitters two pixels from firing a callable and
 * writing an audit entry for a move nobody made.
 */
export function isNoOpDrop(
  visit: DraggableVisit,
  fromDayIso: string,
  targetDayIso: string,
  dropMinuteOfDay: number,
  snapMinutes: number,
  businessZone: string,
): boolean {
  if (fromDayIso !== targetDayIso) return false;
  const current = businessMinutesOfDay(visit.startTime, businessZone);
  if (current === null) return false;
  return snapMinuteOfDay(clampDropMinute(dropMinuteOfDay), snapMinutes) === current;
}
