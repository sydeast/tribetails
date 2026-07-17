import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';

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
