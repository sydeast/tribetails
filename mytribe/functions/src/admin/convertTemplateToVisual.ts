import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { TEMPLATE_ID_MAX_LENGTH, TEMPLATE_ID_PATTERN } from '../lib/templateValidation';
import type { EmailTemplateDoc } from '../lib/sendFromTemplate';

/**
 * #953: the web editor's Convert button. Reads a stored template, converts it
 * with `convertLegacyTemplate`, and returns the result WITHOUT writing -- Save
 * is the write, same split as `previewEmailTemplate`.
 *
 * `convertLegacyTemplate` is loaded with `await import()`, not a file-scope
 * import: it is the only caller anywhere in `src/`, and it pulls in
 * `dom-serializer`, a package no other deployed function reaches. A file-scope
 * import would put that cost on every function's cold start (the whole
 * entrypoint graph, per `coldStartImportGraph.test.ts`), not just this one's.
 */
const Args = z.object({ templateId: z.string().min(1).max(TEMPLATE_ID_MAX_LENGTH).regex(TEMPLATE_ID_PATTERN) });

export type ConvertTemplateResponse =
  | { ok: true; subject: string; headline: string; content: string; warnings: string[] }
  | { ok: false; reason: 'unreadable'; subject: string; body: string };

export async function convertTemplateToVisualHandler(req: CallableRequest<unknown>): Promise<ConvertTemplateResponse> {
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  // safeParse + an explicit HttpsError, not `Args.parse` (which would throw a
  // raw ZodError that `wrapCallable`'s catch-all maps to `internal` and pages
  // Sentry): a malformed templateId is an ordinary client-fault refusal, not a
  // captured server error. Matches `previewEmailTemplate`.
  const parsed = Args.safeParse(req.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', parsed.error.issues.map((i) => i.message).join(' '));
  }
  const { templateId } = parsed.data;
  const snap = await db().doc(`emailTemplates/${templateId}`).get();
  if (!snap.exists) throw new HttpsError('not-found', `No template ${templateId}.`);
  const doc = snap.data() as EmailTemplateDoc;
  // #953 review fix: `doc.subject` is Firestore data cast to `EmailTemplateDoc`,
  // not validated -- an old hand-edited or partially-migrated doc can be
  // missing it entirely, and `ConvertTemplateResponse.subject` is a required
  // `string`, not `string | undefined`.
  const subject = doc.subject ?? '';
  if (doc.format === 'visual' && doc.headline && doc.content) {
    return { ok: true, subject, headline: doc.headline, content: doc.content, warnings: [] };
  }
  if (!doc.html) return { ok: false, reason: 'unreadable', subject, body: doc.body ?? '' };
  const cloud = process.env.CLOUDINARY_CLOUD_NAME ?? '';
  // #953 review fix: mirrors previewEmailTemplate's guard. Without a
  // configured Cloudinary cloud name, `convertLegacyTemplate` can't tell a
  // real image from a foreign one -- every `<img>` looks foreign and
  // `sanitizeEmailContent` silently strips it, which would convert an old
  // template into a visual one with the picture just gone and only a
  // "warning" (easy to miss on a one-off Convert click) to show for it.
  // Refuse outright instead, same as the preview does.
  if (!cloud && /<img\b/i.test(doc.html)) {
    throw new HttpsError('failed-precondition', 'Image uploads are not configured on the server (CLOUDINARY_CLOUD_NAME).');
  }
  const { convertLegacyTemplate } = await import('../notifications/convertLegacyTemplate.js');
  const r = convertLegacyTemplate(doc.html, cloud);
  if (r.ok) return { ok: true, subject, headline: r.headline, content: r.content, warnings: r.warnings };
  return { ok: false, reason: 'unreadable', subject, body: doc.body ?? '' };
}

export const convertTemplateToVisual = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'CLOUDINARY_CLOUD_NAME'] },
  wrapAdminCallable('convertTemplateToVisual', convertTemplateToVisualHandler),
);
