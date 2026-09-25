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

/**
 * Writes `value` at a dotted path inside `target`, creating intermediate
 * objects as needed (`setPath(out, 'nextVisit.date', 'x')` ->
 * `out.nextVisit.date === 'x'`). `TEMPLATE_FIELDS` spells nested enrichment
 * fields (`nextVisit.date`, `nextVisit.time`, `nextVisit.weekday`, from
 * `visitDates.ts`'s `{ weekday, date, time }` shape) as dotted strings, and
 * Handlebars resolves `{{nextVisit.date}}` as a path into a nested object, not
 * a literal `"nextVisit.date"` key -- a flat key would leave the token
 * unresolved and the preview would render blank where a real send shows the
 * date.
 */
function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let node = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const next = node[key];
    node = (next && typeof next === 'object' ? next : (node[key] = {})) as Record<string, unknown>;
  }
  node[parts[parts.length - 1]!] = value;
}

/** Sample merge data for a catalog key's known fields, so a preview never shows a raw `{{token}}`. */
export function sampleDataFor(catalogKey?: string): Record<string, unknown> {
  // #953 review fix: `catalogKey` is operator-typed free text (the editor's
  // catalog-key field), and `TEMPLATE_FIELDS[catalogKey]` on a plain object is
  // a prototype-chain lookup -- 'constructor' and '__proto__' both resolve to
  // something (a function, or the prototype itself) rather than `undefined`,
  // which `Array.isArray` then rejects, but only after the lookup already ran.
  // `Object.hasOwn` refuses anything not an OWN property before the lookup
  // happens at all, so a mistyped or malicious key can never reach a prototype
  // member.
  const raw = catalogKey && Object.hasOwn(TEMPLATE_FIELDS, catalogKey) ? TEMPLATE_FIELDS[catalogKey] : undefined;
  const fields = Array.isArray(raw) ? raw : [];
  const out: Record<string, unknown> = {};
  for (const f of fields) setPath(out, f, /link|url/i.test(f) ? SAMPLE_URL : `[${f}]`);
  return out;
}

export async function previewEmailTemplateHandler(
  req: CallableRequest<unknown>,
): Promise<{ subject: string; html: string; text: string; issues: string[] }> {
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  // safeParse + an explicit HttpsError, not `Args.parse` (which would throw a
  // raw ZodError that `wrapCallable`'s catch-all maps to `internal` and
  // reports to Sentry): this callable is called on a debounce, per keystroke,
  // from the editor, so an oversized/malformed body during normal typing must
  // read as an ordinary client-fault refusal, not a captured server error.
  const parsed = Args.safeParse(req.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', parsed.error.issues.map((i) => i.message).join(' '));
  }
  const args = parsed.data;
  const cloud = process.env.CLOUDINARY_CLOUD_NAME ?? '';
  // #953 review fix: without a configured Cloudinary cloud name, the sanitizer
  // cannot build a matching image-src prefix, so every <img> looks foreign and
  // is silently stripped (an "issue", not a refusal -- see saveTemplate's
  // filter). That left an operator previewing a template with an image
  // believing the picture would send, when in fact no server in this
  // deployment could ever validate one. Refuse outright instead.
  if (!cloud && /<img\b/i.test(args.content)) {
    throw new HttpsError('failed-precondition', 'Image uploads are not configured on the server (CLOUDINARY_CLOUD_NAME).');
  }
  const { content, issues } = sanitizeEmailContent(args.content, cloud);
  const parts = sendPartsFor({ subject: args.subject, format: 'visual', headline: args.headline, content });
  const out = renderEmailParts({ ...parts, data: sampleDataFor(args.catalogKey) });
  return { subject: out.subject, html: out.html ?? '', text: out.text, issues };
}

export const previewEmailTemplate = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'CLOUDINARY_CLOUD_NAME'] },
  wrapAdminCallable('previewEmailTemplate', previewEmailTemplateHandler),
);
