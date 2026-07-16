import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';

const Args = z.object({
  catalogKey: z.string().min(1).max(120),
  templateId: z.string().min(1).max(120),
  audience: z.enum(['kinfolk', 'auntie', 'admin', 'guest']).optional(),
  triggerKey: z.string().min(1).max(120).optional(),
  active: z.boolean().default(true),
});

export async function assignTemplateHandler(
  req: CallableRequest<unknown>,
): Promise<{ catalogKey: string; templateId: string; active: boolean }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = Args.parse(req.data);

  // Verify target template exists, fail loud if admin assigns a non-existent id.
  const tpl = await db().doc(`emailTemplates/${args.templateId}`).get();
  if (!tpl.exists) {
    throw new HttpsError('not-found', `Template not found: ${args.templateId}`);
  }

  await db().doc(`notificationTemplateBindings/${args.catalogKey}`).set(
    {
      catalogKey: args.catalogKey,
      templateId: args.templateId,
      audience: args.audience ?? null,
      triggerKey: args.triggerKey ?? args.catalogKey,
      active: args.active,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: uid,
    },
    { merge: true },
  );

  logEvent({
    severity: 'info',
    function: 'assignTemplate',
    event: 'admin.template.assigned',
    uid,
    extra: { catalogKey: args.catalogKey, templateId: args.templateId, active: args.active },
  });
  return { catalogKey: args.catalogKey, templateId: args.templateId, active: args.active };
}

export const assignTemplate = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('assignTemplate', assignTemplateHandler),
);
