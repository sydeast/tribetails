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
 * ABSENT READS ON. Before this switch, a departed visit waited on its KinTale on
 * every field path (the web and desktop cards offered only "Complete KinTale",
 * Android's Home completed a visit only after a send), so in practice the
 * Auntie had to send one. Reading a missing key as on keeps that prompt in
 * front of her after the deploy; reading it as off would drop it without the
 * operator having chosen to. Only an explicit `false` turns it off, and every
 * client reads it the same way.
 */
export const KIN_TALE_REQUIRED_FIELD = 'kinTaleRequired';

/** What a settings document with no `kinTaleRequired` means. */
export const KIN_TALE_REQUIRED_DEFAULT = true;

const BUSINESS_SETTINGS_DOC = 'business_settings/business_settings';

/** The switch off one settings document. Only an explicit `false` is off. */
export function kinTaleRequiredFrom(settings: Record<string, unknown> | undefined): boolean {
  return settings?.[KIN_TALE_REQUIRED_FIELD] === false ? false : KIN_TALE_REQUIRED_DEFAULT;
}

/** The switch as stored. A failed read is the default, never an operator switching it off. */
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
