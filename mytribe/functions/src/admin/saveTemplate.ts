import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import {
  TEMPLATE_ID_MAX_LENGTH,
  TEMPLATE_ID_PATTERN,
  TEMPLATE_ID_RULE,
  noTripleStash,
  noUnquotedAttributeMerge,
  tripleStashMessage,
  unquotedAttributeMessage,
} from '../lib/templateValidation';

// The triple-stash guard and the id rule moved to `lib/templateValidation.ts`
// under issue #468, when the bulk importer became a second door into the same
// three collections. The rules are unchanged; they simply stopped being local
// to this file, so a template an operator cannot type here is also a template
// they cannot smuggle in through an import. The reasoning behind the guard
// itself now lives in that module.

/**
 * The machine-readable half of the "that key is taken" refusal, so a client can
 * branch on it without matching prose. Mirrors `deleteTemplate`'s
 * `LIVE_CATALOG_KEY_REFUSAL` convention.
 */
export const TEMPLATE_EXISTS_REFUSAL = 'template-exists';

export interface TemplateExistsDetails {
  reason: typeof TEMPLATE_EXISTS_REFUSAL;
  templateId: string;
}

/**
 * Firestore reports a losing `create()` as gRPC status 6, ALREADY_EXISTS. The
 * code arrives as a number from the real client and as a string from some
 * emulator and test doubles, so both are accepted.
 */
function isAlreadyExists(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 6 || code === 'already-exists' || code === 'ALREADY_EXISTS';
}

// Exported for the recursive callable-contract freeze (nested/effects shape).
export const Args = z.object({
  templateId: z
    .string()
    .min(1)
    .max(TEMPLATE_ID_MAX_LENGTH)
    .regex(TEMPLATE_ID_PATTERN, { message: TEMPLATE_ID_RULE }),
  subject: z.string().min(1).max(500).refine(noTripleStash, {
    message: tripleStashMessage('subject'),
  }),
  body: z.string().min(1).max(20000).refine(noTripleStash, {
    message: tripleStashMessage('body'),
  }),
  html: z.string().max(50000).nullable().optional()
    .refine((s) => s == null || noTripleStash(s), {
      message: tripleStashMessage('html'),
    })
    // #892 review 2: the same unquoted-attribute rule the importer applies, so
    // the authoring door cannot store what the import door refuses.
    .refine((s) => s == null || noUnquotedAttributeMerge(s), {
      message: unquotedAttributeMessage('html'),
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
  // "I am creating this template, not editing one." Optional, because this
  // callable has always been an upsert and the superseded Compose clients still
  // call it without the flag; absent means the old behaviour exactly.
  //
  // Issue #468: the editors on both clients offer a New Template button that
  // lets the operator type the key, and neither checked whether that key was
  // already taken. Web checked nothing, so naming an existing template silently
  // replaced its subject and body. Android compared against the page of
  // templates it happened to have loaded, which misses anything further down
  // the list. Both are the same mistake at different depths: only the server
  // knows what exists. With this set, the write becomes `create()`, which fails
  // natively when the document is there, so there is no read-then-write window
  // for a second operator to land in.
  expectNew: z.boolean().optional(),
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

  if (args.expectNew) {
    // `create()` rather than the read above plus a set, so two operators naming
    // the same key at once cannot both believe they made it. The read is still
    // worth keeping for the friendlier message in the common case.
    try {
      await ref.create(data);
    } catch (err) {
      if (!isCreate || isAlreadyExists(err)) {
        throw new HttpsError(
          'already-exists',
          `A template with the key ${args.templateId} already exists. ` +
            `Pick a different key, or close this and edit the existing template.`,
          { reason: TEMPLATE_EXISTS_REFUSAL, templateId: args.templateId },
        );
      }
      throw err;
    }
  } else {
    await ref.set(data, { merge: true });
  }

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
