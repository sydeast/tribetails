/**
 * #1574: whether a visit's window is ahead, over, or under way, judged on the
 * clock before anything is sent. The server's `mytribe/functions/src/lib/pastVisit.ts`
 * is the enforcement; this is the same split, so the form says which case it
 * is instead of the operator finding out from a refusal. `pastVisit.test.ts`
 * reads the server file to keep these sentences identical to the ones it sends.
 *
 * Operator ruling, 2026-11-05 docket: a visit created with a past date is
 * allowed only as already Completed, never Scheduled. Moving an existing visit
 * into the past stays blocked.
 */

export type VisitWindowTiming = 'ahead' | 'ended' | 'underway';

export const VISIT_UNDERWAY_MESSAGE =
  'That visit would already be under way. Pick a start still ahead to schedule it, or record it as completed once it has ended.';
export const RESCHEDULE_IN_PAST_MESSAGE =
  'That time has already passed. A visit can only be moved to a time still ahead.';

/** Shown on New visit when the window has ended: the visit is written as Completed. */
export const RECORD_COMPLETED_HINT =
  'This time has already passed, so the visit is recorded as completed. The household is not notified.';

/**
 * Which window `[startMs, endMs)` is at `nowMs`. A start exactly at now is
 * ahead, an end exactly at now has ended; an unreadable or backwards end reads
 * as the start, so a zero-length window is never under way. Same rule as the
 * server's `classifyVisitWindow`.
 */
export function classifyVisitWindow(startMs: number, endMs: number, nowMs: number): VisitWindowTiming {
  if (startMs >= nowMs) return 'ahead';
  const end = Number.isFinite(endMs) && endMs > startMs ? endMs : startMs;
  return end <= nowMs ? 'ended' : 'underway';
}

/** The `{startTime, endTime}` ISO pair a create or reschedule sends, classified. */
export function timingOf(times: { startTime: string; endTime: string }, nowMs: number): VisitWindowTiming {
  return classifyVisitWindow(Date.parse(times.startTime), Date.parse(times.endTime), nowMs);
}

/**
 * The reschedule pre-check: the server refuses a new start that has passed
 * (`reschedule_in_past`). Returns the sentence to show, or null when the move
 * may be sent. An unreadable start is left to the caller's own validation.
 */
export function rescheduleIntoPastRefusal(startIso: string, nowMs: number): string | null {
  const startMs = Date.parse(startIso);
  return Number.isFinite(startMs) && startMs < nowMs ? RESCHEDULE_IN_PAST_MESSAGE : null;
}
