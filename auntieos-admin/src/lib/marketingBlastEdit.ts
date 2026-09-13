import type { BlastAudience } from '../api/marketingBlasts';

/**
 * The Marketing blasts form's rules: when a blast can be scheduled, what the
 * date and time pickers resolve to, and how the merge-field rows become the
 * `data` record the callable takes.
 *
 * Pure, so the decisions are unit-tested rather than driven through a form. Every
 * rule mirrors `scheduleMarketingBlast`'s zod `Args`, and nothing here is
 * STRICTER than the server: a client-only rule blocks a schedule the server
 * would have accepted and gives the operator no way to find out why. That is the
 * same contract `lib/audienceSegmentEdit.ts` keeps for broadcasts.
 */

/** A single `data` entry as the form holds it, before it becomes a record. */
export interface MergeFieldRow {
  key: string;
  value: string;
}

/**
 * Splits a pasted uid list on commas, whitespace and newlines.
 *
 * Newlines because the realistic way an operator gets 200 uids into this box is
 * a paste out of a spreadsheet column, and a comma-only split turns that into
 * one enormous uid the server then rejects as a single unknown account.
 */
export function parseUidList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    const uid = part.trim();
    if (uid === '' || seen.has(uid)) continue;
    seen.add(uid);
    out.push(uid);
  }
  return out;
}

/**
 * Resolves the date + time pickers to epoch millis, or null when either is
 * blank or the pair is not a real instant.
 *
 * Parsed as LOCAL time (`new Date('2026-06-03T09:00')`, no trailing Z) because
 * the operator picked a wall-clock time in their own day, and a UTC read would
 * silently move a 9am send by however many hours their offset is.
 */
export function fireAtMsFrom(date: string, time: string): number | null {
  if (date.trim() === '' || time.trim() === '') return null;
  const ms = new Date(`${date}T${time}`).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Turns the merge-field rows into the `data` record.
 *
 * A row with a blank key is dropped rather than written as `''`: an empty token
 * name matches no `{{token}}` in any template, so keeping it would put a field
 * in the audit payload that can never render. A later row with the same key
 * wins, which is what the last thing the operator typed should do.
 */
export function mergeFieldsToData(rows: readonly MergeFieldRow[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key === '') continue;
    out[key] = row.value;
  }
  return out;
}

/**
 * Why this blast cannot be scheduled yet, or null when it can. First blocking
 * reason wins, so the operator is told one thing to fix rather than four.
 *
 * `reachable` is the PREVIEW's count and is deliberately optional: a blast is
 * schedulable without previewing first (the server does the same resolve and
 * refuses `no_recipients` itself), but once a preview has come back saying it
 * reaches nobody, sending it anyway is a round trip whose only outcome is an
 * error. `undefined` means "not previewed", which is not the same as zero.
 */
export function blastBlocker(
  audience: BlastAudience | null,
  fireAtMs: number | null,
  nowMs: number,
  reachable: number | undefined,
): string | null {
  if (audience === null) return 'Choose an audience first.';
  if (fireAtMs === null) return 'Pick a date and a time to send.';
  // The server's own window: anything more than a minute in the past is refused.
  if (fireAtMs < nowMs - 60_000) return 'That send time has already passed.';
  if (reachable === 0) return 'This audience reaches nobody. Widen it, or check who has opted in.';
  return null;
}
