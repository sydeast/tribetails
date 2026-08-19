import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { catalogKeyLabel, isLiveCatalogKey } from '../notifications/catalogKeys';

const Args = z.object({
  templateId: z.string().min(1).max(120).regex(/^[a-zA-Z0-9_.-]+$/, {
    message: 'templateId must be [a-zA-Z0-9_.-]+',
  }),
  /**
   * The caller has read the live-key warning below and wants the delete anyway.
   *
   * Absent or false, a template a live notification key resolves to is refused
   * with the full explanation. Present and true, the delete goes through and the
   * consequence is recorded in the log line. The flag is deliberately not
   * something a client sets by default: the admin UI only sends it on a SECOND
   * press, after the server has said what will break, so a stray API call still
   * cannot take out a live template without having been told first.
   */
  acknowledgeLiveKey: z.boolean().optional(),
});

/**
 * The machine-readable half of the live-key refusal, on `HttpsError.details`.
 *
 * The callable throws `failed-precondition` for two unrelated reasons and the
 * remedies are different: a binding refusal is fixed by unassigning, and CANNOT
 * be acknowledged past; a live-key refusal is a warning the operator is allowed
 * to proceed through. A client that had only the sentence to go on would have to
 * pattern-match English to tell them apart, so it gets this instead.
 */
export const LIVE_CATALOG_KEY_REFUSAL = 'live-catalog-key';

export interface LiveCatalogKeyDetails {
  reason: typeof LIVE_CATALOG_KEY_REFUSAL;
  templateId: string;
  /** The notification's human label, or null when the key has none. */
  label: string | null;
  /** True when re-sending with `acknowledgeLiveKey: true` would succeed. */
  acknowledgeable: true;
}

export async function deleteTemplateHandler(
  req: CallableRequest<unknown>,
): Promise<{ templateId: string }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = Args.parse(req.data);

  const ref = db().doc(`emailTemplates/${args.templateId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError('not-found', `Template not found: ${args.templateId}`);
  }

  // #381: WARN before deleting the template a catalog key resolves to BY NAME.
  //
  // The knowledge here was hard-won and stays. At 78 minutes into the 2026-08-17
  // admin walk the recorder captured
  // `deleteTemplate {"templateId":"account.welcome.business"}` returning 200 with
  // nothing said. Routing is by name: resolveTemplateId looks for
  // `notificationTemplateBindings/{key}`, finds nothing, and reads
  // `emailTemplates/{key}`. So deleting a template whose id IS a live key leaves
  // that notification throwing `email template missing` at
  // lib/sendFromTemplate.ts:33 on its next send.
  //
  // The binding check below could never catch this. It only fires when a doc in
  // `notificationTemplateBindings` points at the template, and that collection
  // holds overrides, which for most installs is empty.
  //
  // WHAT CHANGED, and why it is not a weakening. #440 shipped this as a flat
  // refusal, on the assumption that deleting a live template is always a
  // mistake. The operator has ruled that it is not: "that was my doing I did not
  // need that type of notification. I should be able to delete templates without
  // being yelled at." So the sentence is now a confirmation rather than a wall.
  // First call, no acknowledgement: refused, with the full consequence spelled
  // out and `details.reason = 'live-catalog-key'` so a client can tell this apart
  // from the binding refusal below, which is NOT acknowledgeable. Second call
  // carrying `acknowledgeLiveKey: true`: it goes through, and the log line says
  // which notification was knowingly broken.
  //
  // The warning still fires even when an active override currently points the key
  // at some other template. Removing or pausing that override (unassignTemplate
  // is one tap away) brings this document straight back into use, so "not used at
  // this instant" is not the same as "nothing to tell you".
  const liveKey = isLiveCatalogKey(args.templateId);
  if (liveKey && args.acknowledgeLiveKey !== true) {
    const label = catalogKeyLabel(args.templateId);
    const details: LiveCatalogKeyDetails = {
      reason: LIVE_CATALOG_KEY_REFUSAL,
      templateId: args.templateId,
      label,
      acknowledgeable: true,
    };
    throw new HttpsError(
      'failed-precondition',
      `emailTemplates/${args.templateId} is what the notification ` +
        `"${args.templateId}"${label ? ` (${label})` : ''} sends, matched by name. ` +
        `Deleting it leaves that notification throwing "email template missing" on its ` +
        `next send. If that is what you want, confirm the delete and it will go through. ` +
        `If it is not, retire the catalog row instead, or point the key at another ` +
        `template. This holds even while an override points the key elsewhere, because ` +
        `removing the override brings this template back.`,
      details,
    );
  }

  // Refuse to delete a template that a notification catalog key still points
  // at. `notificationTemplateBindings/{catalogKey}.templateId` is a plain
  // string reference with no Firestore-side integrity check, so deleting the
  // template out from under a binding (active or not) would silently orphan
  // it: dispatch would fail to resolve the template at send time with no
  // signal to the admin who broke it. Fail loud instead and name every
  // catalog key still bound, so the admin can unassign them first.
  //
  // `acknowledgeLiveKey` does NOT get past this one, on purpose. The two
  // refusals are not the same shape: a live-key warning has no remedy short of
  // retiring the notification, which is why an operator has to be able to
  // proceed through it, while a binding has a one-tap remedy sitting right next
  // to the delete button (unassignTemplate). "Unassign first" is a real
  // instruction, not a wall, so nothing here needs softening.
  const bindingsSnap = await db()
    .collection('notificationTemplateBindings')
    .where('templateId', '==', args.templateId)
    .get();
  if (bindingsSnap.docs.length > 0) {
    const catalogKeys = bindingsSnap.docs.map((d) => d.id);
    throw new HttpsError(
      'failed-precondition',
      `Template "${args.templateId}" is still assigned to notification catalog key(s): ` +
        `${catalogKeys.join(', ')}. Unassign before deleting.`,
    );
  }

  await ref.delete();

  // An acknowledged live-key delete is a deliberate act with a consequence, so
  // it is logged at `warn` and says which notification it broke. That is the
  // trail somebody follows when a send starts failing next week: the answer is
  // in the log rather than in someone's memory of a dialog they clicked through.
  logEvent({
    severity: liveKey ? 'warn' : 'info',
    function: 'deleteTemplate',
    event: liveKey ? 'admin.template.deleted.live_key' : 'admin.template.deleted',
    uid,
    extra: liveKey
      ? {
          templateId: args.templateId,
          acknowledgedLiveKey: true,
          notificationLabel: catalogKeyLabel(args.templateId),
        }
      : { templateId: args.templateId },
  });
  return { templateId: args.templateId };
}

export const deleteTemplate = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('deleteTemplate', deleteTemplateHandler),
);
