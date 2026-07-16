import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';

/**
 * Hybrid category source (Decision 2026-06-03): the canonical list is the union
 * of the managed `template_categories` collection and the DISTINCT `category`
 * values already present on `emailTemplates` docs. This means:
 *  - no existing free-text category is ever lost (the template-distinct half),
 *  - admins can persist a category before any template uses it (the managed half),
 *  - and consumers get one server-deduped, sorted list instead of each screen
 *    re-deriving it client-side.
 *
 * Dedup is case-insensitive; when a name appears in both halves the
 * managed-collection casing wins (it is the curated form). Sort is
 * case-insensitive alphabetical.
 */
export async function listCategoriesHandler(
  req: CallableRequest<unknown>,
): Promise<{ categories: string[]; schemaVersion: number }> {
  initSentry();
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  // Map lowercased-name -> display name. Managed collection first so its casing wins.
  const byKey = new Map<string, string>();
  const add = (raw: unknown) => {
    if (typeof raw !== 'string') return;
    const name = raw.trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, name);
  };

  const [managedSnap, templateSnap] = await Promise.all([
    db().collection('template_categories').get(),
    db().collection('emailTemplates').get(),
  ]);
  managedSnap.docs.forEach((d) => add((d.data() as { name?: unknown }).name));
  templateSnap.docs.forEach((d) => add((d.data() as { category?: unknown }).category));

  const categories = Array.from(byKey.values()).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  );

  logEvent({
    severity: 'info',
    function: 'listCategories',
    event: 'admin.categories.listed',
    uid: req.auth.uid,
    extra: { count: categories.length },
  });
  return { categories, schemaVersion: 1 };
}

export const listCategories = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('listCategories', listCategoriesHandler),
);
