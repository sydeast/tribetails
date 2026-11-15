/**
 * #2331: THE COUNT A TIMED JOB KEEPS OF THE NOTICES THE SEND SWITCH HELD BACK.
 *
 * PR #2330 gave every held household copy its own Activity Log line. That is
 * right for something a person did. The jobs on a timer wrote them too, with
 * nobody pressing anything: the visit reminder job every hour, the invoice
 * reminder and overdue jobs every day, one line per copy. The Activity Log
 * lists the newest 200 rows, so while the switch was off those lines could
 * push the day's real activity out of view.
 *
 * A timed job now hands the dispatcher one of these. A copy the switch holds
 * is counted here and writes no line of its own; when the run ends the job
 * writes ONE line with the count (`recordHeldNoticeSummary` in
 * `noticeAudit.ts`). A copy held without a batch (a tap, a save, a trigger)
 * keeps its own line, exactly as #2330 wrote it.
 *
 * ONLY "held by the send switch" is counted. A notification turned off in
 * Settings, a channel the household switched off, a channel with no address
 * and a send that failed keep their own lines inside a timed job too: those
 * happen with the switch ON, and a failed send has to stay one `FAILURE` line
 * per notice because the daily error digest reads them.
 *
 * NOT A FIELD OF `EnqueueArgs`. Callers spread those args and parts of them
 * are stored; the batch is a second argument to `enqueueNotificationDetailed`
 * so it can never land on a notification or a work order.
 *
 * No imports: the dispatcher and the scheduled jobs load this at cold start.
 */

/** Why the switch held the copy: it is off, or it could not be read (fail closed). */
export type HeldNoticeReason = 'off' | 'unreadable';

export interface HeldNoticeBatch {
  /** The scheduled job, by its function name. Part of the summary line's fixed id. */
  readonly job: string;
  /**
   * The run this count belongs to: the job's tick, or its business day. A
   * retry of the same run carries the same window, so it writes no second line.
   */
  readonly window: string;
  /** Copies held, by reason, then by notification key. */
  readonly held: Record<HeldNoticeReason, Map<string, number>>;
}

export function startHeldNoticeBatch(job: string, window: string): HeldNoticeBatch {
  return { job, window, held: { off: new Map(), unreadable: new Map() } };
}

/** One household copy of `key` was held. Called by the dispatcher in place of the per-copy line. */
export function countHeldNotice(
  batch: HeldNoticeBatch,
  key: string,
  reason: HeldNoticeReason,
): void {
  const byKey = batch.held[reason];
  byKey.set(key, (byKey.get(key) ?? 0) + 1);
}

/** How many copies the batch holds for one reason. */
export function heldNoticeTotal(batch: HeldNoticeBatch, reason: HeldNoticeReason): number {
  let total = 0;
  for (const n of batch.held[reason].values()) total += n;
  return total;
}

/**
 * The hour a tick belongs to, as `2026-11-14T15`. Cloud Scheduler repeats the
 * event's `scheduleTime` on a retry of the same tick, so the retry lands in
 * the same hour even when it runs past the top of the next one. With no
 * `scheduleTime` (a direct call, a test) the hour of `nowMs` stands in.
 */
export function hourWindow(nowMs: number, scheduleTime?: string): string {
  const scheduled = scheduleTime === undefined ? Number.NaN : Date.parse(scheduleTime);
  return new Date(Number.isFinite(scheduled) ? scheduled : nowMs).toISOString().slice(0, 13);
}

/**
 * Runs one job run with a batch and writes its summary line when the run ends,
 * however it ends: a run that throws half way still writes what it counted,
 * and the error goes on to `wrapScheduled` untouched. The writer is loaded
 * only when something was held, and never throws.
 */
export async function withHeldNoticeBatch<T>(
  job: string,
  window: string,
  run: (batch: HeldNoticeBatch) => Promise<T>,
): Promise<T> {
  const batch = startHeldNoticeBatch(job, window);
  try {
    return await run(batch);
  } finally {
    if (heldNoticeTotal(batch, 'off') + heldNoticeTotal(batch, 'unreadable') > 0) {
      try {
        const { recordHeldNoticeSummary } = await import('./noticeAudit.js');
        await recordHeldNoticeSummary(batch);
      } catch {
        // Never fatal: a line that cannot be written must not fail or retry the run.
      }
    }
  }
}
