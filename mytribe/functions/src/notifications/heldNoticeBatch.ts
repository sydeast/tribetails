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
 * WHAT IS COUNTED: a copy held by the send switch (off, or unreadable), and
 * since #2341 a copy of a notification the operator turned off in Settings,
 * which crowded the log the same way with the switch on. A channel the
 * household switched off, a channel with no address and a send that failed
 * keep their own lines inside a timed job: the first two are about one
 * household, and a failed send has to stay one `FAILURE` line per notice
 * because the daily error digest reads them.
 *
 * #2340: a marketing blast is counted the same way, one batch per fan-out run.
 *
 * EACH HELD COPY IS COUNTED ONCE A BUSINESS DAY. Nothing is stamped on a
 * visit or an invoice while its notice is held, so the hourly visit job holds
 * the same reminders again every hour, and a daily job that is retried holds
 * its notices again. The batch therefore remembers WHICH copies it held, not
 * only how many, and the writer keeps one small marker per job for the day
 * (`recordHeldNoticeSummary`): a run's line counts only the copies not yet
 * counted that day, and a run with none of those writes nothing.
 *
 * NOT A FIELD OF `EnqueueArgs`. Callers spread those args and parts of them
 * are stored; the batch is a second argument to `enqueueNotificationDetailed`
 * so it can never land on a notification or a work order.
 *
 * No imports: the dispatcher and the scheduled jobs load this at cold start.
 */

/**
 * Why the copy did not go: the send switch is off, the switch could not be
 * read (fail closed), or the notification itself is turned off in Settings.
 */
export type HeldNoticeReason = 'off' | 'unreadable' | 'turnedOff';
/** Every reason, in the order their lines are written. */
export const HELD_NOTICE_REASONS: readonly HeldNoticeReason[] = ['off', 'unreadable', 'turnedOff'];

export interface HeldNoticeBatch {
  /** The scheduled job, by its function name. Names the job's marker for the day. */
  readonly job: string;
  /** The business day of the run, when the job already resolved it. */
  readonly day?: string;
  /** The moment of the run, from which the writer resolves the business day when `day` is absent. */
  readonly atMs: number;
  /** Copies held, by reason: what names the copy, then its notification key. */
  readonly held: Record<HeldNoticeReason, Map<string, string>>;
  /**
   * Copies held that nothing names (no event id on the notice), by reason,
   * then by notification key. They cannot be told from one run to the next,
   * so they are counted every run. None of the three timed jobs sends one.
   */
  readonly unnamed: Record<HeldNoticeReason, Map<string, number>>;
}

export function startHeldNoticeBatch(job: string, run: { day?: string; atMs?: number } = {}): HeldNoticeBatch {
  return {
    job,
    ...(run.day !== undefined && run.day !== '' ? { day: run.day } : {}),
    atMs: run.atMs ?? Date.now(),
    held: { off: new Map(), unreadable: new Map(), turnedOff: new Map() },
    unnamed: { off: new Map(), unreadable: new Map(), turnedOff: new Map() },
  };
}

/**
 * One household copy of `key` was held. Called by the dispatcher in place of
 * the per-copy line. `copy` names it (the event and who it was for) so the
 * same copy held again that day is not counted twice; '' when nothing does.
 */
export function countHeldNotice(
  batch: HeldNoticeBatch,
  key: string,
  reason: HeldNoticeReason,
  copy = '',
): void {
  if (copy !== '') {
    batch.held[reason].set(copy, key);
    return;
  }
  const byKey = batch.unnamed[reason];
  byKey.set(key, (byKey.get(key) ?? 0) + 1);
}

/** How many copies the batch holds for one reason, or for every reason when none is named. */
export function heldNoticeTotal(batch: HeldNoticeBatch, reason?: HeldNoticeReason): number {
  if (reason === undefined) {
    return HELD_NOTICE_REASONS.reduce((sum, r) => sum + heldNoticeTotal(batch, r), 0);
  }
  let total = batch.held[reason].size;
  for (const n of batch.unnamed[reason].values()) total += n;
  return total;
}

/**
 * The moment a tick belongs to. Cloud Scheduler repeats the event's
 * `scheduleTime` on a retry of the same tick, so a retry that runs past
 * midnight still belongs to the day its tick was due. With no `scheduleTime`
 * (a direct call, a test) `nowMs` stands in.
 */
export function tickMs(nowMs: number, scheduleTime?: string): number {
  const scheduled = scheduleTime === undefined ? Number.NaN : Date.parse(scheduleTime);
  return Number.isFinite(scheduled) ? scheduled : nowMs;
}

/**
 * Runs one job run with a batch and writes its summary line when the run ends,
 * however it ends: a run that throws half way still writes what it counted,
 * and the error goes on to `wrapScheduled` untouched. The writer is loaded
 * only when something was held, and never throws.
 */
export async function withHeldNoticeBatch<T>(
  job: string,
  when: { day?: string; atMs?: number },
  run: (batch: HeldNoticeBatch) => Promise<T>,
): Promise<T> {
  const batch = startHeldNoticeBatch(job, when);
  try {
    return await run(batch);
  } finally {
    if (heldNoticeTotal(batch) > 0) {
      try {
        const { recordHeldNoticeSummary } = await import('./noticeAudit.js');
        await recordHeldNoticeSummary(batch);
      } catch {
        // Never fatal: a line that cannot be written must not fail or retry the run.
      }
    }
  }
}
