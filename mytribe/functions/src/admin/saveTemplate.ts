import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';

// Reject Handlebars triple-stash `{{{var}}}` in any template content.
// Triple-stash renders variables WITHOUT HTML-escape, so an attacker-controlled
// `bodyCopy`, `preview`, or comment field reaches every kinfolk inbox as raw
// HTML, phishing payload, stored XSS, link smuggling. Double-stash `{{var}}`
// is HTML-escaped by default; `{{{` is the unsafe form. Block at author time
// rather than rendering with `noEscape: true` because admins still need rich
// formatting and may not understand which fields are attacker-controllable.
const NO_TRIPLE_STASH = (s: string | null | undefined): boolean => !s || !/\{\{\{/.test(s);

const Args = z.object({
  templateId: z.string().min(1).max(120).regex(/^[a-zA-Z0-9_.-]+$/, {
    message: 'templateId must be [a-zA-Z0-9_.-]+',
  }),
  subject: z.string().min(1).max(500).refine(NO_TRIPLE_STASH, {
    message: 'subject must not use unescaped Handlebars {{{var}}} triple-stash',
  }),
  body: z.string().min(1).max(20000).refine(NO_TRIPLE_STASH, {
    message: 'body must not use unescaped Handlebars {{{var}}} triple-stash',
  }),
  html: z.string().max(50000).nullable().optional()
    .refine((s) => s == null || NO_TRIPLE_STASH(s), {
      message: 'html must not use unescaped Handlebars {{{var}}} triple-stash',
    }),
  title: z.string().max(200).optional(),
  description: z.string().max(1000).optional(),
  tags: z.array(z.string().max(60)).max(20).optional(),
  category: z.string().max(60).optional(),
  // I9: operator-authoring metadata. Not Handlebars-rendered to kinfolk (unlike
  // subject/body/html), so they carry no triple-stash guard, matching the
  // unguarded title/description/tags convention above.
  usageInstructions: z.string().max(2000).optional(),
  sectionDefinitions: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        description: z.string().max(1000),
      }),
    )
    .max(50)
    .optional(),
});

export async function saveTemplateHandler(
  req: CallableRequest<unknown>,
): Promise<{ templateId: string }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = Args.parse(req.data);

  const ref = db().doc(`emailTemplates/${args.templateId}`);
  const snap = await ref.get();
  const isCreate = !snap.exists;

  const data: Record<string, unknown> = {
    subject: args.subject,
    body: args.body,
    html: args.html ?? null,
    title: args.title ?? args.templateId,
    description: args.description ?? null,
    tags: args.tags ?? [],
    category: args.category ?? null,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: uid,
    ...(isCreate ? { createdAt: FieldValue.serverTimestamp(), createdBy: uid } : {}),
  };
  // I9 backward compat: write the two new fields ONLY when the caller supplied
  // them. Under {merge:true} this means an older client (the Compose web/android
  // apps, which do not know these fields) that omits them never clobbers a value
  // a newer client set. The React editor always sends them (a possibly-empty
  // string / array), so clearing them from that surface still works.
  if (args.usageInstructions !== undefined) data.usageInstructions = args.usageInstructions;
  if (args.sectionDefinitions !== undefined) data.sectionDefinitions = args.sectionDefinitions;

  await ref.set(data, { merge: true });

  // Hybrid category pool: persist the chosen category into `template_categories`
  // so it survives even if this template is later deleted, and so `listCategories`
  // surfaces admin-added categories before any template uses them. Idempotent
  // (doc id = slug). Best-effort: a pool-write failure must not fail the template
  // save (the category still surfaces via the distinct-on-templates half of the
  // union), but it is logged loudly rather than swallowed.
  if (args.category && args.category.trim()) {
    const name = args.category.trim();
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (slug) {
      try {
        await db().doc(`template_categories/${slug}`).set(
          { name, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid },
          { merge: true },
        );
      } catch (e) {
        logEvent({
          severity: 'warn',
          function: 'saveTemplate',
          event: 'admin.category.upsert.failed',
          uid,
          extra: { category: name, error: e instanceof Error ? e.message : String(e) },
        });
      }
    }
  }

  logEvent({
    severity: 'info',
    function: 'saveTemplate',
    event: isCreate ? 'admin.template.created' : 'admin.template.updated',
    uid,
    extra: { templateId: args.templateId, category: args.category ?? null },
  });
  return { templateId: args.templateId };
}

export const saveTemplate = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('saveTemplate', saveTemplateHandler),
);
