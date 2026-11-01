/**
 * Day separators for the Message Auntie thread (#1318). Days are cut in the
 * business timezone (operator ruling 2026-08-11: America/Chicago), not the
 * device's, so a household travelling sees the same day boundaries the Auntie
 * does. Mirrored by MessageDays.kt on Android.
 */
export const BUSINESS_TIME_ZONE = 'America/Chicago';
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
interface Ymd {
  y: number;
  m: number;
  d: number;
}
function ymdInBusinessZone(ms: number): Ymd {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get('year'), m: get('month'), d: get('day') };
}
/** Stable per-day key ("2026-11-01") in the business timezone. */
export function dayKey(ms: number): string {
  const { y, m, d } = ymdInBusinessZone(ms);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
/**
 * Today / Yesterday / weekday (last 6 days) / "October 5" / "October 5, 2025"
 * when the year differs from now's.
 */
export function dayLabel(ms: number, nowMs: number = Date.now()): string {
  const a = ymdInBusinessZone(ms);
  const b = ymdInBusinessZone(nowMs);
  const diff = Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  const dow = new Date(Date.UTC(a.y, a.m - 1, a.d)).getUTCDay();
  if (diff > 1 && diff < 7) return WEEKDAYS[dow]!;
  const base = `${MONTHS[a.m - 1]} ${a.d}`;
  return a.y === b.y ? base : `${base}, ${a.y}`;
}
/** Clock time in the business timezone, e.g. "7:23 PM". */
export function businessTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', {
    timeZone: BUSINESS_TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit',
  });
}
