import { businessTimeZone } from './bookingTimeBlocks';

/**
 * Words a window in the BUSINESS zone, the clock the operator reads on the
 * schedule (#1164, shared with the visit-overlap refusal in #1168). It used to
 * read "2026-08-07 19:00 UTC to 2026-08-07 20:00 UTC" for a block drawn at 2:00
 * PM, which nobody could match to the schedule. "Aug 7, 2:00-3:00 PM" when
 * both ends share a day, "Aug 7, 10:00 PM to
 * Aug 8, 2:00 AM" when they do not; no end gives just "Aug 7, 2:00 PM".
 * Plain hyphens and "to", never a dash character.
 */
export function formatBusyWindow(startMs: number, endMs: number | null, timeZone: string): string {
  const zone = businessTimeZone({ timeZone });
  const day = new Intl.DateTimeFormat('en-US', { timeZone: zone, month: 'short', day: 'numeric' });
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
