import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { sanitizeEmailContent } from '../lib/emailContent';
import { sendPartsFor } from '../lib/emailFrame';
import { renderEmailParts } from '../lib/email';
import { TEMPLATE_FIELDS } from '../notifications/enrichTemplateData';

/**
 * #953: what the editor shows beside the content. Same sanitizer, same frame,
 * same renderer as a real send, so the preview cannot disagree with the inbox.
 *
 * Unlike `saveTemplate`, a sanitizer issue does not refuse the preview -- the
 * editor needs to render something to show the issue beside, not a thrown
 * error. `issues` is returned alongside the render so the caller can display
 * both at once.
 */
const Args = z.object({
  subject: z.string().max(500),
  headline: z.string().max(300),
  content: z.string().max(50000),
  catalogKey: z.string().max(200).optional(),
});

const SAMPLE_URL = 'https://kinfolk.tribetails.com/sample';

/** Sample merge data for a catalog key's known fields, so a preview never shows a raw `{{token}}`. */
export function sampleDataFor(catalogKey?: string): Record<string, string> {
  const fields = (catalogKey && TEMPLATE_FIELDS[catalogKey]) || [];
  const out: Record<string, string> = {};
  for (const f of fields) out[f] = /link|url/i.test(f) ? SAMPLE_URL : `[${f}]`;
  return out;
}

export async function previewEmailTemplateHandler(
  req: CallableRequest<unknown>,
): Promise<{ subject: string; html: string; text: string; issues: string[] }> {
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = Args.parse(req.data);
  const { content, issues } = sanitizeEmailContent(args.content, process.env.CLOUDINARY_CLOUD_NAME ?? '');
  const parts = sendPartsFor({ subject: args.subject, format: 'visual', headline: args.headline, content });
  const out = renderEmailParts({ ...parts, data: sampleDataFor(args.catalogKey) });
  return { subject: out.subject, html: out.html ?? '', text: out.text, issues };
}

export const previewEmailTemplate = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'CLOUDINARY_CLOUD_NAME'] },
  wrapAdminCallable('previewEmailTemplate', previewEmailTemplateHandler),
);
