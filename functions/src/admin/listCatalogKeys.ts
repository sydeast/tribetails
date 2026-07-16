import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';

/**
 * Stage 2 tail: return the distinct set of template catalog keys currently in
 * use, so the AuntieOS template UI can show which catalog keys exist and flag
 * the unbound ones.
 *
 * Catalog keys are the binding identity in `notificationTemplateBindings`: each
 * binding doc is keyed by its catalogKey (assignTemplate writes
 * `notificationTemplateBindings/{catalogKey}` and stamps a `catalogKey` field;
 * listTemplateBindings reads `catalogKey: d.id`). The distinct set of those ids
 * (union the `catalogKey` field for safety against any legacy docs) is the
 * authoritative catalog-key list.
 *
 * Read-only. Admin auth via wrapAdminCallable. No audit entry: this is a read,
 * which the 2026-05-19 audit-scope decision explicitly excludes.
 */
const Args = z.object({
  // Optional case-insensitive substring filter on the catalog key.
  filter: z.string().max(200).optional(),
});

export async function listCatalogKeysHandler(
  req: CallableRequest<unknown>,
): Promise<{ keys: string[] }> {
  initSentry();
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = Args.parse(req.data ?? {});

  const snap = await db().collection('notificationTemplateBindings').get();
  const set = new Set<string>();
  for (const d of snap.docs) {
    const data = d.data() as { catalogKey?: string };
    const key = (typeof data.catalogKey === 'string' && data.catalogKey) || d.id;
    if (key) set.add(key);
  }

  let keys = Array.from(set).sort();
  if (args.filter) {
    const needle = args.filter.toLowerCase();
    keys = keys.filter((k) => k.toLowerCase().includes(needle));
  }

  return { keys };
}

export const listCatalogKeys = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('listCatalogKeys', listCatalogKeysHandler),
);
