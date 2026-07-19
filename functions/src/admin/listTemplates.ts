import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldPath } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';

type TemplateDoc = {
  subject?: string;
  body?: string;
  html?: string | null;
  title?: string;
  description?: string | null;
  tags?: string[];
  category?: string | null;
  usageInstructions?: string;
  sectionDefinitions?: Array<{ title?: unknown; description?: unknown }>;
  updatedAtMs?: number;
};

/**
 * I8: optional server-side page window. `emailTemplates` has no timestamp/order
 * field the admin read exposes (which is why this was a one-shot full read), but
 * the document id is always present and gives a stable, deterministic cursor.
 * Firestore's default `.get()` already returns docs in `__name__` order, so
 * ordering by the document id here preserves the existing visible order while
 * making `startAfter` cursoring possible. Omitting `limit` returns the whole
 * collection with `nextCursor: null` (the pre-I8 behaviour), so every existing
 * caller (the Compose apps, TemplateAssignments) is unaffected.
 */
const ListArgs = z.object({
  limit: z.number().int().min(1).max(500).optional(),
  startAfter: z.string().min(1).max(200).optional(),
});

export async function listTemplatesHandler(
  req: CallableRequest<unknown>,
): Promise<{ templates: Array<Record<string, unknown>>; nextCursor: string | null }> {
  initSentry();
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = ListArgs.parse(req.data ?? {});

  let query: FirebaseFirestore.Query = db()
    .collection('emailTemplates')
    .orderBy(FieldPath.documentId());
  if (args.startAfter) query = query.startAfter(args.startAfter);
  if (args.limit) query = query.limit(args.limit);

  const snap = await query.get();
  const templates = snap.docs.map((d) => {
    const data = d.data() as TemplateDoc;
    return {
      templateId: d.id,
      subject: data.subject ?? '',
      body: data.body ?? '',
      html: data.html ?? null,
      title: data.title ?? d.id,
      description: data.description ?? null,
      tags: data.tags ?? [],
      category: data.category ?? null,
      // I9 new fields, defaulted so pre-existing docs without them still load.
      usageInstructions: typeof data.usageInstructions === 'string' ? data.usageInstructions : '',
      sectionDefinitions: Array.isArray(data.sectionDefinitions)
        ? data.sectionDefinitions.map((s) => ({
            title: typeof s?.title === 'string' ? s.title : '',
            description: typeof s?.description === 'string' ? s.description : '',
          }))
        : [],
    };
  });

  // A full page came back => there may be more; hand back the last id as the
  // cursor. A short (or unbounded) page means the list is exhausted.
  const nextCursor =
    args.limit && snap.docs.length === args.limit
      ? (snap.docs[snap.docs.length - 1]?.id ?? null)
      : null;

  return { templates, nextCursor };
}

export async function listTemplateBindingsHandler(
  req: CallableRequest<unknown>,
): Promise<{ bindings: Array<Record<string, unknown>> }> {
  initSentry();
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const snap = await db().collection('notificationTemplateBindings').get();
  const bindings = snap.docs.map((d) => {
    const data = d.data() as {
      templateId?: string;
      audience?: string | null;
      triggerKey?: string | null;
      active?: boolean;
    };
    return {
      catalogKey: d.id,
      templateId: data.templateId ?? '',
      audience: data.audience ?? null,
      triggerKey: data.triggerKey ?? null,
      active: data.active ?? false,
    };
  });
  return { bindings };
}

export const listTemplates = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('listTemplates', listTemplatesHandler),
);

export const listTemplateBindings = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('listTemplateBindings', listTemplateBindingsHandler),
);
