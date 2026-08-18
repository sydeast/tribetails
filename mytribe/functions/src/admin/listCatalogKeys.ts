import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { buildCatalogKeyRows, type CatalogKeyRow } from '../notifications/catalogKeys';

/**
 * The catalog keys an admin can bind a template to, and what each one does today.
 *
 * This used to read `notificationTemplateBindings` and hand back the keys that
 * were ALREADY bound, while calling that "the authoritative catalog-key list"
 * (issue #383). It was circular: with the collection empty it returned nothing,
 * which is why the Assignments screen had a free-text key box, and why Android's
 * "unbound catalog keys" panel, computing catalog minus bound, could only ever
 * be empty.
 *
 * The list now comes from the catalog itself (see notifications/catalogKeys.ts):
 * every notification-catalog row, every key sent directly through
 * `sendFromTemplate`, and any leftover key sitting in the bindings collection,
 * which is flagged `legacy` rather than quietly offered as bindable.
 *
 * `keys` is kept alongside `rows` because the shipped Android build reads it. It
 * is the same union, so that build's unbound panel starts working with no client
 * change.
 *
 * Read-only. Admin auth via wrapAdminCallable. No audit entry: this is a read,
 * which the 2026-05-19 audit-scope decision explicitly excludes.
 */
const Args = z.object({
  // Optional case-insensitive substring filter on the catalog key or its label.
  filter: z.string().max(200).optional(),
});

export async function listCatalogKeysHandler(
  req: CallableRequest<unknown>,
): Promise<{ keys: string[]; rows: CatalogKeyRow[] }> {
  initSentry();
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = Args.parse(req.data ?? {});

  const [bindingSnap, templateSnap] = await Promise.all([
    db().collection('notificationTemplateBindings').get(),
    db().collection('emailTemplates').get(),
  ]);

  const boundKeys = new Set<string>();
  // Mirrors resolveTemplateId: an inactive binding falls back to the default, so
  // it must not be reported as the template the key resolves to.
  const activeBindings = new Map<string, string>();
  for (const d of bindingSnap.docs) {
    const data = d.data() as { catalogKey?: string; templateId?: string; active?: boolean };
    const key = (typeof data.catalogKey === 'string' && data.catalogKey) || d.id;
    if (!key) continue;
    boundKeys.add(key);
    if (data.active !== false && data.templateId) activeBindings.set(key, data.templateId);
  }

  const templateIds = new Set<string>(templateSnap.docs.map((d) => d.id));

  let rows = buildCatalogKeyRows(boundKeys, activeBindings, templateIds);
  if (args.filter) {
    const needle = args.filter.toLowerCase();
    rows = rows.filter(
      (r) => r.key.toLowerCase().includes(needle) || r.label.toLowerCase().includes(needle),
    );
  }

  return { keys: rows.map((r) => r.key), rows };
}

export const listCatalogKeys = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('listCatalogKeys', listCatalogKeysHandler),
);
