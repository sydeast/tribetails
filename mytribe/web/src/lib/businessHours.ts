/**
 * How one day of the public business card's hours reads (#1411).
 *
 * The card carries each day as "HH:MM-HH:MM" (24-hour, the settings editor's
 * shape) or '' for a closed day. A household reads "9:00 AM to 5:00 PM" or
 * "Closed", the same 12-hour convention `portalFormat.ts` uses for visit times.
 *
 * A value this cannot parse is shown as the operator typed it, never dropped:
 * the operator's settings are the record, and a row that silently went blank
 * would read as a closed day. The Kotlin twin is
 * `config/BusinessHoursLabel.kt`; keep the two in step.
 */
export const HOURS_CLOSED = 'Closed';

const RANGE = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/;

function clock(hours: number, minutes: number): string | null {
  if (hours > 23 || minutes > 59) return null;
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const h12 = hours % 12 || 12;
  return `${h12}:${String(minutes).padStart(2, '0')} ${ampm}`;
}

export function hoursLabel(range: string): string {
  const trimmed = range.trim();
  if (trimmed === '') return HOURS_CLOSED;
  const m = RANGE.exec(trimmed);
  if (!m) return trimmed;
  const open = clock(Number(m[1]), Number(m[2]));
  const close = clock(Number(m[3]), Number(m[4]));
  if (open === null || close === null) return trimmed;
  return `${open} to ${close}`;
}
