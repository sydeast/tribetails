import { resolveBusinessTimeZone } from './businessOperations';

/**
 * #1098: turning the operator's chosen start time for an Overnight into an
 * instant, on the night the household asked for, in the BUSINESS zone.
 *
 * Every other booking write in this admin builds its instant from the device
 * zone (see the header of `lib/bookingAvailability.ts`). This one cannot: the
 * server checks the chosen time against the visit's `requestedDate`, which it
 * derived in `business_settings.timeZone` (`businessCalendarDate` in
 * `functions/src/lib/bookingTimeBlocks.ts`). An operator travelling outside the
 * business zone would otherwise send a time the server reads as a different
 * night and refuses. So the wall clock is read in the business zone, and only
 * an unusable zone falls back to the server's own default, America/Chicago
 * (#1109), not to the device.
 *
 * No zone library is in the bundle, so this does the conversion with `Intl`:
 * guess the instant as if the wall clock were UTC, measure the zone's offset at
 * that guess, correct, and measure once more so a guess on the far side of a
 * DST change settles on the right offset.
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

interface WallClock {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
}

function parseWallClock(dateIso: string, hhmm: string): WallClock | null {
  const dm = DATE_RE.exec(dateIso);
  const tm = TIME_RE.exec(hhmm);
  if (!dm || !tm) return null;
  const [y, mo, d, h, mi] = [dm[1], dm[2], dm[3], tm[1], tm[2]].map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  // Reject a date like Feb 31 rather than rolling it into March.
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return { y, mo, d, h, mi };
}

/** The zone's offset from UTC at `ms`, in ms, or null when `Intl` cannot format in it. */
function zoneOffsetMs(ms: number, zone: string): number | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(ms));
  } catch {
    return null;
  }
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  if (!Number.isFinite(asUtc)) return null;
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * `YYYY-MM-DD` + `HH:mm` read as a wall clock in `zone`, as epoch ms. Null when
 * the zone is blank or unknown to `Intl`, or the date or time is unreadable.
 */
export function wallClockInZoneToMs(dateIso: string, hhmm: string, zone: string): number | null {
  const wc = parseWallClock(dateIso, hhmm);
  const z = zone.trim();
  if (wc === null || z === '') return null;
  const guess = Date.UTC(wc.y, wc.mo - 1, wc.d, wc.h, wc.mi);
  const first = zoneOffsetMs(guess, z);
  if (first === null) return null;
  const second = zoneOffsetMs(guess - first, z);
  if (second === null) return null;
  return guess - second;
}

/**
 * The instant to send for an Overnight's start: the business zone when it is
 * usable, else the same America/Chicago the server falls back to.
 * Null only when the date or time itself is unreadable.
 */
export function startTimeOnNight(dateIso: string, hhmm: string, businessZone: string): number | null {
  // #1109: an unusable zone resolves to the server's default, not the device's.
  const inZone = wallClockInZoneToMs(dateIso, hhmm, resolveBusinessTimeZone(businessZone));
  if (inZone !== null) return inZone;
  const wc = parseWallClock(dateIso, hhmm);
  if (wc === null) return null;
  return new Date(wc.y, wc.mo - 1, wc.d, wc.h, wc.mi).getTime();
}

/**
 * `2026-10-09` -> "Fri, Oct 9". A requested night is a calendar date, not an
 * instant, so it is formatted as that date in UTC and never shifts with the
 * device zone. An unreadable value is shown as it came.
 */
export function nightLabel(dateIso: string): string {
  const dm = DATE_RE.exec(dateIso);
  if (!dm) return dateIso;
  const date = new Date(Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3])));
  if (Number.isNaN(date.getTime())) return dateIso;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(date);
}
