import type { Firestore } from 'firebase-admin/firestore';

/**
 * #2123: the operator's "KinTale required" switch
 * (`business_settings.kinTaleRequired`), ruled 2026-11-12:
 *
 *   "KinTale requirement is an optional setting for admin that doesn't block
 *   the visit from being done. if kintales are required, then kinfolk still see
 *   Completed and the kintale becomes a required task for the auntie to
 *   complete and will see that task until the kintale is sent."
 *
 * WHAT IT DOES. Nothing to the visit's status. A visit is Completed at
 * departure whatever this says (`triggers/onKinCareSessionDeparted.ts`). When it
 * is on, the completion writes `kinTaleDue: true` on the session if no KinTale
 * has gone out yet, and every admin client lists that visit under "KinTales to
 * send" until a send writes `kinTaleDue: false` beside `sentReportCount`.
 *
 * ABSENT READS OFF (operator ruling 2026-11-13, "Start it off"). A business
 * that has never saved the switch gives no "Send the KinTale" tasks. Only an
 * explicit `true` turns it on, the same reading as the arrival rule
 * (`requireArrivalDepartureVerification` in `lib/arrivalVerification.ts`), and
 * every client reads it the same way.
 *
 * THE STAMP IS THE AUTHORITY. No client reads this switch to build the task
 * list: an Auntie cannot read `business_settings` at all (owner-only in the
 * rules, it holds rates and payment handles), and the task is hers. Every admin
 * client lists a visit under "KinTales to send" from `kinTaleDue: true` and no
 * sent KinTale, for any sign-in. So the server keeps the stamps honest: while
 * the switch is off, `triggers/onBusinessSettingsWrite.ts` clears every stamp
 * still standing ({@link clearKinTalesDue}). Turning it back on stamps only the
 * visits completed from then on; nothing re-stamps old ones.
 */
export const KIN_TALE_REQUIRED_FIELD = 'kinTaleRequired';

/** What a settings document with no `kinTaleRequired` means. */
export const KIN_TALE_REQUIRED_DEFAULT = false;

const BUSINESS_SETTINGS_DOC = 'business_settings/business_settings';

/** The switch off one settings document. Only an explicit `true` is on. */
export function kinTaleRequiredFrom(settings: Record<string, unknown> | undefined): boolean {
  return settings?.[KIN_TALE_REQUIRED_FIELD] === true ? true : KIN_TALE_REQUIRED_DEFAULT;
}

/**
 * The switch as stored. A failed read is the default (off), as a failed read of
 * the arrival rule is: a read that failed is not an operator asking for a task.
 */
export async function isKinTaleRequired(firestore: Firestore): Promise<boolean> {
  try {
    const snap = await firestore.doc(BUSINESS_SETTINGS_DOC).get();
    return kinTaleRequiredFrom(snap.data() as Record<string, unknown> | undefined);
  } catch {
    return KIN_TALE_REQUIRED_DEFAULT;
  }
}

/** The session field every send bumps (`increment(1)` in the send batch, on every client). */
export interface KinTaleSendFields {
  sentReportCount?: unknown;
}

/**
 * Has a KinTale gone out for this visit? `sentReportCount` alone. NOT
 * `reportIds`: Android's `KinCareRepository.createKinCareReport` appends a
 * DRAFT's id to the session's `reportIds` when the draft is created, so a
 * listed report is not a sent one.
 */
export function kinTaleSent(session: KinTaleSendFields): boolean {
  return typeof session.sentReportCount === 'number' && session.sentReportCount > 0;
}

/** Does completing this visit leave the Auntie a "Send the KinTale" task? */
export function kinTaleDueAtCompletion(session: KinTaleSendFields, required: boolean): boolean {
  return required && !kinTaleSent(session);
}

/** How many stamps one batch clears. Under Firestore's 500-write batch limit. */
export const KIN_TALE_CLEAR_PAGE = 400;

/**
 * Clears `kinTaleDue` on every visit still stamped, so no client lists a task
 * the operator has switched off. Returns how many it cleared.
 *
 * IDEMPOTENT AND SELF-ENDING. Each page is re-queried after the last one is
 * committed, and a cleared visit no longer matches, so a retry or a second run
 * finds only what is left (usually nothing). `kinTaleDue` alone is written:
 * not `updatedAt`, because the visit itself has not changed.
 */
export async function clearKinTalesDue(firestore: Firestore, pageSize: number = KIN_TALE_CLEAR_PAGE): Promise<number> {
  let cleared = 0;
  for (;;) {
    const page = await firestore.collection('kin_care_sessions').where('kinTaleDue', '==', true).limit(pageSize).get();
    if (page.empty) break;
    const batch = firestore.batch();
    page.docs.forEach((d) => batch.update(d.ref, { kinTaleDue: false }));
    await batch.commit();
    cleared += page.size;
    if (page.size < pageSize) break;
  }
  return cleared;
}
