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

/** LOCAL `MM-DD HH:mm` for a row timestamp (companion to dayKey). */
export function formatWhen(ts: FsTimeLike): string {
  const d = tsToDate(ts);
  if (!d) return '(no time)';
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * LOCAL `YYYY-MM-DD HH:mm`, with the year: the shape a sortable table column
 * uses when it has its own header to name the field, unlike `formatWhen`'s
 * bare `MM-DD HH:mm`, which counts on a joined meta line to supply context.
 * `null` for a missing timestamp, so a caller can render its own blank
 * placeholder rather than inherit `formatWhen`'s `(no time)`.
 */
export function formatWhenFull(ts: FsTimeLike): string | null {
  const d = tsToDate(ts);
  if (!d) return null;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Machine-readable local datetime for a `<time dateTime={…}>` attribute. */
export function machineWhen(ts: FsTimeLike): string | undefined {
  const d = tsToDate(ts);
  if (!d) return undefined;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
