import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { buildCatalogKeyRows, type CatalogKeyRow } from '../notifications/catalogKeys';
import { readTemplateBindings } from '../lib/sendFromTemplate';

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

  // The bindings read moved to `readTemplateBindings` (lib/sendFromTemplate.ts),
  // beside `resolveTemplateId`, when #396 needed the same answer for the
  // notification gate's "which template writes it" line. Two admin screens each
  // looping this collection is how they start disagreeing about what a key
  // sends, and the inactive-binding fallback is the rule that would drift first.
  const [bindings, templateSnap] = await Promise.all([
    readTemplateBindings(),
    db().collection('emailTemplates').get(),
  ]);
  const { boundKeys, activeBindings } = bindings;

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
