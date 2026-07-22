import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';

// Exported so the callable-contract drift guard can freeze this request shape.
export const Args = z.object({
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

  const binding: Record<string, unknown> = {
    catalogKey: args.catalogKey,
    templateId: args.templateId,
    audience: args.audience ?? null,
    active: args.active,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: uid,
  };
  // AO-30 / WARNING-48: write triggerKey ONLY when the caller supplied one.
  // The old `triggerKey: args.triggerKey ?? args.catalogKey` on a {merge:true}
  // write meant any re-assign that omitted triggerKey (e.g. just toggling
  // `active`, or swapping the templateId) silently reset a previously-set custom
  // trigger back to the catalogKey. Dispatch (resolveTemplateId) keys off the
  // doc-id catalogKey and ignores triggerKey, so omitting it here changes nothing
  // operationally; it only stops the clobber.
  if (args.triggerKey !== undefined) binding.triggerKey = args.triggerKey;

  await db().doc(`notificationTemplateBindings/${args.catalogKey}`).set(binding, { merge: true });

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
