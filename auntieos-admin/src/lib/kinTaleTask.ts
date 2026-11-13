import { useEffect, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { db } from './firebase';
import { BUSINESS_SETTINGS_DOC_ID } from '../api/settings';
import { sharedLoad } from './useSharedOneShot';

/**
 * #2123 (operator ruling 2026-11-12): "if kintales are required, then kinfolk
 * still see Completed and the kintale becomes a required task for the auntie to
 * complete and will see that task until the kintale is sent."
 *
 * THE TASK NEVER BLOCKS ANYTHING. The visit is Completed at departure on the
 * server (`functions/src/triggers/onKinCareSessionDeparted.ts`). When "KinTale
 * required" is on and nothing has been sent, that completion writes
 * `kinTaleDue: true`, and every send writes it back to false beside
 * `sentReportCount` (`api/kinTalesWrite.ts#sendKinTale`). This file is the
 * board's reading of those fields: the same rule as
 * `functions/src/lib/kinTaleRequirement.ts`, Android's `domain/KinTaleTask.kt`
 * and the desktop console's copy. Change them together.
 */

/** What a settings document with no `kinTaleRequired` means: off (operator ruling 2026-11-13, "Start it off"). */
export const KIN_TALE_REQUIRED_DEFAULT = false;

/** The switch off the raw settings document. Only an explicit `true` is on. */
export function kinTaleRequiredFrom(raw: Record<string, unknown> | undefined): boolean {
  return raw?.['kinTaleRequired'] === true ? true : KIN_TALE_REQUIRED_DEFAULT;
}

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
 * Does the Auntie still owe this visit's KinTale? A sent one wins over a flag
 * that has not been cleared yet, so the card leaves the list the moment the
 * send lands.
 */
export function kinTaleOwed(session: KinTaleTaskFields, required: boolean): boolean {
  if (!required) return false;
  const status = typeof session.status === 'string' ? session.status.trim().toUpperCase() : '';
  return status === 'COMPLETED' && session.kinTaleDue === true && !kinTaleSent(session);
}

/**
 * The board's rows split into "KinTales to send" and everything else. `due` is
 * the `kinTaleDue == true` read, which reaches visits older than the board's
 * window; a visit in both appears once, in `owed`. With the switch off the
 * board is returned untouched.
 */
export function splitOwedKinTales<T extends KinTaleTaskFields & { _id: string }>(
  board: readonly T[],
  due: readonly T[],
  required: boolean,
): { owed: T[]; rest: readonly T[] } {
  if (!required) return { owed: [], rest: board };
  const owedIds = new Set<string>();
  const owed: T[] = [];
  for (const row of [...board, ...due]) {
    if (owedIds.has(row._id) || !kinTaleOwed(row, required)) continue;
    owedIds.add(row._id);
    owed.push(row);
  }
  return { owed, rest: board.filter((r) => !owedIds.has(r._id)) };
}

/** Held for a minute, one read for every card on a board, as `useArrivalRule` does. */
export const KIN_TALE_REQUIRED_TTL_MS = 60 * 1000;

export async function loadKinTaleRequired(): Promise<boolean> {
  const snap = await getDoc(doc(db, 'business_settings', BUSINESS_SETTINGS_DOC_ID));
  return kinTaleRequiredFrom(snap.exists() ? (snap.data() as Record<string, unknown>) : undefined);
}

/**
 * The switch, or null while it loads or when it could not be read. The board
 * shows no "KinTales to send" group until it knows: a guess either way would
 * either hide a task or invent one.
 */
export function useKinTaleRequired(): boolean | null {
  const [required, setRequired] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    sharedLoad('business_settings.kinTaleRequired', loadKinTaleRequired, KIN_TALE_REQUIRED_TTL_MS)
      .then((v) => {
        if (live) setRequired(v);
      })
      .catch(() => {
        if (live) setRequired(null);
      });
    return () => {
      live = false;
    };
  }, []);
  return required;
}
