import { businessTimeZone } from './bookingTimeBlocks';
import type { ActorRole } from './schema';

/** Which clock a window is worded on: 24-hour for auntieOS staff, 12-hour for a household (#1828). */
export type WindowClock = '12h' | '24h';

/** A household member (PRIMARY, SECONDARY) reads 12-hour; staff and the system read the admin's 24-hour clock. */
export function windowClockFor(actorRole: ActorRole): WindowClock {
  return actorRole === 'PRIMARY' || actorRole === 'SECONDARY' ? '12h' : '24h';
}

/**
 * Words a window in the BUSINESS zone, the clock the operator reads on the
 * schedule (#1164, shared with the visit-overlap refusal in #1168). It used to
 * read "2026-08-07 19:00 UTC to 2026-08-07 20:00 UTC" for a block drawn at 2:00
 * PM, which nobody could match to the schedule. "Aug 7, 2:00-3:00 PM" when
 * both ends share a day, "Aug 7, 10:00 PM to
 * Aug 8, 2:00 AM" when they do not; no end gives just "Aug 7, 2:00 PM".
 * Plain hyphens and "to", never a dash character.
 *
 * `clock` (#1828, owner ruling 2026-11-12): the auntieOS admin reads a 24-hour
 * clock ("Aug 7, 14:00-15:00"), MyTribe and the household a 12-hour one. A
 * refusal worded for the person who pressed the button picks its clock with
 * `windowClockFor` below.
 */
export function formatBusyWindow(
  startMs: number,
  endMs: number | null,
  timeZone: string,
  clockStyle: WindowClock = '12h',
): string {
  const zone = businessTimeZone({ timeZone });
  const day = new Intl.DateTimeFormat('en-US', { timeZone: zone, month: 'short', day: 'numeric' });
  if (clockStyle === '24h') {
    const clock24 = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const t = (ms: number) => clock24.format(ms);
    const sDay = day.format(startMs);
    if (endMs === null) return `${sDay}, ${t(startMs)}`;
    const eDay = day.format(endMs);
    if (sDay !== eDay) return `${sDay}, ${t(startMs)} to ${eDay}, ${t(endMs)}`;
    return `${sDay}, ${t(startMs)}-${t(endMs)}`;
  }
  const clock = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit', hour12: true });
  const meridiem = (ms: number) => clock.formatToParts(ms).find((p) => p.type === 'dayPeriod')?.value ?? '';
  // Intl may emit a narrow no-break space before AM/PM; keep the text plain.
  const time = (ms: number) => clock.format(ms).replace(/\s/g, ' ');
  const timeNoMeridiem = (ms: number) => time(ms).replace(/ ?[AP]M$/i, '');
  const startDay = day.format(startMs);
  if (endMs === null) return `${startDay}, ${time(startMs)}`;
  const endDay = day.format(endMs);
  if (startDay !== endDay) return `${startDay}, ${time(startMs)} to ${endDay}, ${time(endMs)}`;
  if (meridiem(startMs) === meridiem(endMs)) return `${startDay}, ${timeNoMeridiem(startMs)}-${time(endMs)}`;
  return `${startDay}, ${time(startMs)}-${time(endMs)}`;
}
