import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';

/**
 * I9 "New Binding": bind MANY templates to ONE category in a single action,
 * creating the category inline if it does not exist yet.
 *
 * A "binding of a template to a category" is the template's own `category`
 * field (today set one template at a time: the React editor's category input,
 * or the Compose drag-drop, which calls `saveTemplate(tpl.copy(category = ...))`.
 * A category holds MANY templates, so a bulk assign is coherent here, unlike the
 * `notificationTemplateBindings` catalog-key bindings, which are 1:1 by doc id.
 *
 * A dedicated batch callable rather than looping `saveTemplate`: `saveTemplate`'s
 * schema REQUIRES `subject` + `body` (min length 1) + the id regex on every
 * call, so re-tagging a template's category through it would force resending
 * each template's full content and re-running the Handlebars triple-stash guard
 * per template. This does the one thing (merge `category` onto N docs) in a
 * single WriteBatch, verifying every target exists first (fail loud, naming any
 * missing, the same existence check `assignTemplate` does for its single target),
 * and upserts the managed `template_categories` pool doc once (the inline
 * category creation, reusing `saveTemplate`'s slug rule).
 */
const Args = z.object({
  category: z.string().min(1).max(60),
  templateIds: z
    .array(
      z.string().min(1).max(120).regex(/^[a-zA-Z0-9_.-]+$/, {
        message: 'templateId must be [a-zA-Z0-9_.-]+',
      }),
    )
    .min(1)
    .max(200),
});

export async function assignTemplatesToCategoryHandler(
  req: CallableRequest<unknown>,
): Promise<{ category: string; assigned: number; templateIds: string[] }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = Args.parse(req.data);

  const category = args.category.trim();
  if (!category) throw new HttpsError('invalid-argument', 'Category name must not be blank.');

  // Dedupe while preserving the caller's order.
  const ids = Array.from(new Set(args.templateIds));

  // Verify every target template exists; fail loud naming any missing rather
  // than silently categorizing a subset (matches assignTemplate's not-found).
  const refs = ids.map((id) => db().doc(`emailTemplates/${id}`));
  const snaps = await db().getAll(...refs);
  const missing = snaps.filter((s) => !s.exists).map((s) => s.id);
  if (missing.length > 0) {
    throw new HttpsError('not-found', `Template(s) not found: ${missing.join(', ')}`);
  }

  const batch = db().batch();
  for (const id of ids) {
    batch.set(
      db().doc(`emailTemplates/${id}`),
      { category, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid },
      { merge: true },
    );
  }

  // Inline category creation: persist the (possibly brand-new) category into the
  // managed pool so it survives even if every template is later recategorized,
  // and so `listCategories` surfaces it. Idempotent (doc id = slug); same slug
  // rule as saveTemplate.
  const slug = category
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug) {
    batch.set(
      db().doc(`template_categories/${slug}`),
      { name: category, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid },
      { merge: true },
    );
  }

  await batch.commit();

  logEvent({
    severity: 'info',
    function: 'assignTemplatesToCategory',
    event: 'admin.templates.categorized',
    uid,
    extra: { category, count: ids.length },
  });

  return { category, assigned: ids.length, templateIds: ids };
}

export const assignTemplatesToCategory = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('assignTemplatesToCategory', assignTemplatesToCategoryHandler),
);
