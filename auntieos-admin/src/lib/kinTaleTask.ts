/**
 * #2123 (operator ruling 2026-11-12): "if kintales are required, then kinfolk
 * still see Completed and the kintale becomes a required task for the auntie to
 * complete and will see that task until the kintale is sent."
 *
 * THE TASK NEVER BLOCKS ANYTHING. The visit is Completed at departure on the
 * server (`functions/src/triggers/onKinCareSessionDeparted.ts`). When "KinTale
 * required" is on and nothing has been sent, that completion writes
 * `kinTaleDue: true`, and every send writes it back to false beside
 * `sentReportCount` (`api/kinTalesWrite.ts#sendKinTale`).
 *
 * THE STAMP IS THE AUTHORITY, AND THIS FILE READS NO SETTINGS. The task is the
 * Auntie's, and an Auntie cannot read `business_settings` (owner-only in the
 * rules). So the board lists "KinTales to send" from the stamp alone, for any
 * sign-in, and the server keeps the stamps honest: turning the switch off
 * clears every one still standing (`functions/src/triggers/onBusinessSettingsWrite.ts`).
 *
 * The same rule as `functions/src/lib/kinTaleRequirement.ts`, Android's
 * `domain/KinTaleTask.kt` and the desktop console's `data/KinTaleOwed.kt`.
 * Change them together.
 */

/** The session fields the task reads. */
export interface KinTaleTaskFields {
  status?: unknown;
  kinTaleDue?: unknown;
  sentReportCount?: unknown;
}

/**
 * Has a KinTale gone out for this visit? `sentReportCount` alone, never
 * `reportIds`: Android lists a DRAFT's id there when the draft is created
 * (`KinCareRepository.createKinCareReport`).
 */
export function kinTaleSent(session: KinTaleTaskFields): boolean {
  return typeof session.sentReportCount === 'number' && session.sentReportCount > 0;
}

/**
 * Does the Auntie still owe this visit's KinTale? Completed, stamped by the
 * server, and nothing sent. A sent one wins over a stamp that has not been
 * cleared yet, so the card leaves the list the moment the send lands.
 */
export function kinTaleOwed(session: KinTaleTaskFields): boolean {
  const status = typeof session.status === 'string' ? session.status.trim().toUpperCase() : '';
  return status === 'COMPLETED' && session.kinTaleDue === true && !kinTaleSent(session);
}

/**
 * The board's rows split into "KinTales to send" and everything else. `due` is
 * the `kinTaleDue == true` read, which reaches visits older than the board's
 * window; a visit in both appears once, in `owed`.
 */
export function splitOwedKinTales<T extends KinTaleTaskFields & { _id: string }>(
  board: readonly T[],
  due: readonly T[],
): { owed: T[]; rest: readonly T[] } {
  const owedIds = new Set<string>();
  const owed: T[] = [];
  for (const row of [...board, ...due]) {
    if (owedIds.has(row._id) || !kinTaleOwed(row)) continue;
    owedIds.add(row._id);
    owed.push(row);
  }
  return { owed, rest: owedIds.size === 0 ? board : board.filter((r) => !owedIds.has(r._id)) };
}
