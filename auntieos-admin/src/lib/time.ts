import type { Timestamp } from 'firebase/firestore';

/**
 * A Firestore date field as the plain JS SDK hands it back: a `Timestamp`, or
 * `null` in the brief local-pending window before a `serverTimestamp()` write
 * has round-tripped. Timestamp-backed collections (notifications, invoices,
 * sessions, kin) use this; the ISO-STRING collections (activity_log.timestamp)
 * are a separate, pre-existing surface and are NOT this type.
 */
export type FsTime = Timestamp | null | undefined;

export function tsToDate(ts: FsTime): Date | null {
  return ts ? ts.toDate() : null;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * LOCAL `YYYY-MM-DD` for day grouping. Local, NOT UTC, this is the AO-18 fix
 * for the React rebuild. The operator's "today" is their wall clock; a UTC slice
 * (`toISOString()`) groups an 8pm-CDT event under TOMORROW and shows a time 5h
 * off. The wasm admin has that bug live; the React port must not inherit it. Uses
 * getFullYear/getMonth/getDate, which read the browser's local zone.
 */
export function dayKey(ts: FsTime): string {
  const d = tsToDate(ts);
  if (!d) return 'Undated';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** LOCAL `MM-DD HH:mm` for a row timestamp (companion to dayKey). */
export function formatWhen(ts: FsTime): string {
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
export function formatWhenFull(ts: FsTime): string | null {
  const d = tsToDate(ts);
  if (!d) return null;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Machine-readable local datetime for a `<time dateTime={…}>` attribute. */
export function machineWhen(ts: FsTime): string | undefined {
  const d = tsToDate(ts);
  if (!d) return undefined;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
