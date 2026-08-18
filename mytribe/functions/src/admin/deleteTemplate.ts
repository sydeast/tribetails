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
});

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

  // #381: refuse to delete the template a catalog key resolves to BY NAME.
  //
  // This is the guard that was missing, and its absence has already cost a live
  // template. At 78 minutes into the 2026-08-17 admin walk the recorder captured
  // `deleteTemplate {"templateId":"account.welcome.business"}` returning 200.
  // That is catalog row 32. Routing is by name: resolveTemplateId looks for
  // `notificationTemplateBindings/{key}`, finds nothing, and reads
  // `emailTemplates/{key}`. So deleting a template whose id IS a catalog key
  // leaves that notification throwing `email template missing` at
  // lib/sendFromTemplate.ts on its next send, with nothing said at delete time.
  //
  // The binding check below could never catch this. It only fires when a doc in
  // `notificationTemplateBindings` points at the template, and that collection
  // holds overrides, which for most installs is empty.
  //
  // The refusal stands even when an active override currently points the key at
  // some other template. Removing or pausing that override (unassignTemplate is
  // one tap away) brings this document straight back into use, so "not used at
  // this instant" is not the same as "safe to delete".
  if (isLiveCatalogKey(args.templateId)) {
    const label = catalogKeyLabel(args.templateId);
    throw new HttpsError(
      'failed-precondition',
      `emailTemplates/${args.templateId} is what the notification ` +
        `"${args.templateId}"${label ? ` (${label})` : ''} sends, matched by name. ` +
        `Deleting it leaves that notification throwing "email template missing" on its ` +
        `next send. Retire the catalog row first if the notification is no longer wanted, ` +
        `or point the key at another template. This holds even while an override points ` +
        `the key elsewhere, because removing the override brings this template back.`,
    );
  }

  // Refuse to delete a template that a notification catalog key still points
  // at. `notificationTemplateBindings/{catalogKey}.templateId` is a plain
  // string reference with no Firestore-side integrity check, so deleting the
  // template out from under a binding (active or not) would silently orphan
  // it: dispatch would fail to resolve the template at send time with no
  // signal to the admin who broke it. Fail loud instead and name every
  // catalog key still bound, so the admin can unassign them first.
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

  logEvent({
    severity: 'info',
    function: 'deleteTemplate',
    event: 'admin.template.deleted',
    uid,
    extra: { templateId: args.templateId },
  });
  return { templateId: args.templateId };
}

export const deleteTemplate = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('deleteTemplate', deleteTemplateHandler),
);
