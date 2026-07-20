import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';

/**
 * unassignTemplate: remove the binding that points a notification catalog key
 * at an email template. The inverse of assignTemplate, and the missing half of
 * the assign/unassign pair (AO-56): without it a template could never be
 * deleted once bound, because deleteTemplate.ts refuses with `failed-precondition`
 * ("Unassign before deleting.") for exactly the binding this removes.
 *
 * Removes `notificationTemplateBindings/{catalogKey}` outright rather than just
 * flipping `active:false`: listCatalogKeys / listTemplateBindings both read the
 * presence of the binding doc, so a soft-deactivate would leave a ghost catalog
 * key mapped to a (possibly-since-deleted) template. A true unassign drops the
 * mapping.
 *
 * Idempotent: unassigning an already-unbound key is a no-op SUCCESS, never an
 * error. The caller's goal ("this catalog key must not point at a template") is
 * satisfied whether or not a doc was there; a `not-found` throw would only make
 * the delete-then-unassign flow brittle against a double-click or a stale list.
 * The `removed` flag in the result reports whether a doc actually existed.
 */
const Args = z.object({
  catalogKey: z.string().min(1).max(120),
});

export async function unassignTemplateHandler(
  req: CallableRequest<unknown>,
): Promise<{ catalogKey: string; removed: boolean }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = Args.parse(req.data);

  const ref = db().doc(`notificationTemplateBindings/${args.catalogKey}`);
  const snap = await ref.get();
  const removed = snap.exists;
  if (removed) await ref.delete();

  logEvent({
    severity: 'info',
    function: 'unassignTemplate',
    event: 'admin.template.unassigned',
    uid,
    extra: { catalogKey: args.catalogKey, removed },
  });
  return { catalogKey: args.catalogKey, removed };
}

export const unassignTemplate = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('unassignTemplate', unassignTemplateHandler),
);
