import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { explainUnbindableKey } from '../notifications/catalogKeys';

// Exported so the callable-contract drift guard can freeze this request shape.
// `catalogKey` stays a plain bounded string here on purpose: the real check is a
// catalog lookup in the handler (below), which zod cannot express without
// changing the frozen shape, and which has to name the offending key.
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

  // #382: the catalog key used to be validated against nothing, so a typo like
  // `kincare.bookng.confirm` returned 200, showed up under Current bindings, and
  // did nothing forever. Nothing reads a binding at a key the dispatcher never
  // asks for. Refuse the write and name the key, the way the sibling
  // notificationOverrides callable refuses an unknown notification key.
  //
  // Deliberately NOT excused for a key that already has a binding doc: the only
  // sensible move on a dead binding is unassignTemplate, which stays unvalidated
  // so anything already written can always be cleaned up.
  const keyProblem = explainUnbindableKey(args.catalogKey);
  if (keyProblem) throw new HttpsError('invalid-argument', keyProblem);

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
