import type { Timestamp } from 'firebase/firestore';

/**
 * A Firestore date field as the plain JS SDK hands it back: a `Timestamp`, or
 * `null` in the brief local-pending window before a `serverTimestamp()` write
 * has round-tripped. Timestamp-backed collections (notifications, invoices,
 * sessions, kin) use this; the ISO-STRING collections (activity_log.timestamp)
 * are a separate, pre-existing surface and are NOT this type.
 */
export type FsTime = Timestamp | null | undefined;

/**
 * What a timestamp field can actually hold on a raw document, as opposed to
 * what its writer intends (#1065). The server stamps notifications with
 * `serverTimestamp()`, but a hand-seeded, imported or future row can carry an
 * ISO string, epoch millis or a Date, and the JS SDK hands back whatever is
 * stored. Every formatter below takes this wider shape.
 */
export type FsTimeLike = FsTime | Date | string | number;

const validDate = (d: Date): Date | null => (Number.isNaN(d.getTime()) ? null : d);

/**
 * Any timestamp-ish value to a Date, or null when it is absent or unreadable.
 * Never throws: a single malformed row used to throw `toDate is not a function`
 * inside render, and the error boundary blanked the whole Notifications page.
 */
export function tsToDate(ts: FsTimeLike): Date | null {
  if (ts === null || ts === undefined) return null;
  if (ts instanceof Date) return validDate(ts);
  if (typeof ts === 'number') return Number.isFinite(ts) ? validDate(new Date(ts)) : null;
  if (typeof ts === 'string') return ts.trim() ? validDate(new Date(ts)) : null;
  if (typeof (ts as { toDate?: unknown }).toDate === 'function') {
    try {
      const d = (ts as Timestamp).toDate();
      return d instanceof Date ? validDate(d) : null;
    } catch {
      return null;
    }
  }
  return null;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * LOCAL `YYYY-MM-DD` for day grouping. Local, NOT UTC, this is the AO-18 fix
 * for the React rebuild. The operator's "today" is their wall clock; a UTC slice
 * (`toISOString()`) groups an 8pm-CDT event under TOMORROW and shows a time 5h
 * off. The wasm admin has that bug live; the React port must not inherit it. Uses
 * getFullYear/getMonth/getDate, which read the browser's local zone.
 */
export function dayKey(ts: FsTimeLike): string {
  const d = tsToDate(ts);
  if (!d) return 'Undated';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * THE ADMIN DATE AND TIME SHAPE (#1828, owner ruling 2026-11-12): "auntieOS in
 * 24hr & alphanumeric date". Every admin screen writes a day as "Nov 10, 2026"
 * and a moment as "Nov 10, 2026 22:32". The walk found the same visit written
 * five ways ("11-10 22:32", "2026-11-10 22:32", "Nov 10 · 10:32 PM", "10:32p",
 * a raw UTC stamp). These are the one place that shape is spelled; a screen
 * that needs a date reaches for one of them rather than building its own.
 *
 * Admin only. The MyTribe portal and anything sent to a household stays on a
 * 12-hour clock, and Time Block labels ("Midday (11 AM to 3 PM)") are names,
 * not clock readings, so neither comes through here.
 */
export const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** "Nov 10, 2026" from a year, a 1-based month and a day. */
export function formatYmd(year: number, month1: number, day: number): string {
  return `${MONTH_SHORT[month1 - 1] ?? pad(month1)} ${day}, ${year}`;
}

/** "22:32" from an hour (0-23) and a minute. */
export function formatHHmm(hour: number, minute: number): string {
  return `${pad(hour)}:${pad(minute)}`;
}

/** LOCAL "Nov 10, 2026", or null when the value is absent or unreadable. */
export function formatDay(ts: FsTimeLike): string | null {
  const d = tsToDate(ts);
  if (!d) return null;
  return formatYmd(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/**
 * A `YYYY-MM-DD` day key (what `dayKey` groups by) as the day a person reads,
 * "Nov 10, 2026". Anything that is not such a key ("Undated") comes back as it
 * was.
 */
export function dayKeyLabel(key: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return key;
  return formatYmd(Number(m[1]), Number(m[2]), Number(m[3]));
}

/**
 * LOCAL "Nov 10, 2026 22:32" for a row timestamp (companion to dayKey). Always
 * with the year (#1599: lists such as KinTales span more than a year). `now`
 * is kept for callers written when the year was dropped for the current one;
 * it no longer changes the result.
 */
export function formatWhen(ts: FsTimeLike, now: Date = new Date()): string {
  void now;
  const d = tsToDate(ts);
  if (!d) return '(no time)';
  return `${formatYmd(d.getFullYear(), d.getMonth() + 1, d.getDate())} ${formatHHmm(d.getHours(), d.getMinutes())}`;
}

/**
 * `formatWhen`'s "Nov 10, 2026 22:32", read on a named IANA zone (the
 * business's) instead of the viewer's. No `timeZone` reads the viewer's.
 */
export function formatWhenInZone(ts: FsTimeLike, timeZone?: string): string {
  const d = tsToDate(ts);
  if (!d) return '(no time)';
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
    ...(timeZone !== undefined && timeZone !== '' ? { timeZone } : {}),
  }).formatToParts(d);
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');
  return `${formatYmd(part('year'), part('month'), part('day'))} ${formatHHmm(part('hour') % 24, part('minute'))}`;
}
/**
 * LOCAL `HH:mm` alone, for a row whose day group header already carries the
 * day. Its callers used to take `formatWhen(...).slice(6)`, which stopped
 * being the time once `formatWhen` could lead with a year (#1599).
 */
export function formatClock(ts: FsTimeLike): string {
  const d = tsToDate(ts);
  if (!d) return '(no time)';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * `formatWhen`'s shape, but `null` for a missing timestamp, so a caller can
 * render its own blank placeholder rather than inherit `(no time)`.
 */
export function formatWhenFull(ts: FsTimeLike): string | null {
  const d = tsToDate(ts);
  if (!d) return null;
  return formatWhen(d);
}

/** Machine-readable local datetime for a `<time dateTime={…}>` attribute. */
export function machineWhen(ts: FsTimeLike): string | undefined {
  const d = tsToDate(ts);
  if (!d) return undefined;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
