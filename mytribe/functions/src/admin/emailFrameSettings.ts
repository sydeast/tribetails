import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import { logEvent } from '../lib/logger';
import { assertCloudinaryUrlInFolder } from '../lib/cloudinary';
import { sendPartsFor } from '../lib/emailFrame';
import { renderEmailParts } from '../lib/email';
import { readStoredEmailFrame } from '../lib/emailFrameStore';
import {
  DEFAULT_EMAIL_FRAME,
  EMAIL_FRAME_DOC_PATH,
  EMAIL_FRAME_FIELDS,
  EMAIL_FRAME_FIELD_SCHEMAS,
  EMAIL_FRAME_LOGO_FOLDER,
  resolveEmailFrame,
  type EmailFrame,
  type EmailFrameField,
  type StoredEmailFrame,
} from '../lib/emailFrameConfig';

/**
 * #957: the operator's email frame editor, server side.
 * Spec: docs/superpowers/specs/2026-09-28-email-frame-editor-design.md
 *
 * Three callables, all owner-only: none is in `AUNTIE_ALLOWED_CALLABLES`,
 * because editing business configuration is owner work
 * (D-2026-09-22-AUNTIE-ROLE). The frame document is denied to every client in
 * the rules, so these are the only way in, and the only place it is validated.
 */

export interface EmailFrameState {
  /** Only the fields the operator set. Shown as values. */
  stored: StoredEmailFrame;
  /** Every field's default. Shown as placeholders, never saved (D-DEFAULT-IS-HINT). */
  defaults: EmailFrame;
  updatedAt: string | null;
  updatedBy: string | null;
}

function isField(key: string): key is EmailFrameField {
  return (EMAIL_FRAME_FIELDS as readonly string[]).includes(key);
}

/** Checks one field's value, throwing `invalid-argument` with the schema's sentence. */
function parseField(field: EmailFrameField, value: unknown): string {
  const parsed = EMAIL_FRAME_FIELD_SCHEMAS[field].safeParse(value);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', parsed.error.issues.map((i) => i.message).join(' '), { field });
  }
  return parsed.data;
}

/**
 * The account-and-folder half of the logo check (the structural half is in the
 * schema). Same check and same folder as the business logo
 * (`confirmBrandAssetUpload`): both admin clients upload business images there.
 */
function assertLogoInLibrary(url: string): void {
  const cloud = process.env.CLOUDINARY_CLOUD_NAME ?? '';
  if (!cloud) {
    throw new HttpsError('failed-precondition', 'Image uploads are not configured on the server (CLOUDINARY_CLOUD_NAME).');
  }
  try {
    assertCloudinaryUrlInFolder(url, cloud, EMAIL_FRAME_LOGO_FOLDER);
  } catch {
    throw new HttpsError('invalid-argument', 'The logo must be an image uploaded to the business library.', {
      field: 'logoUrl',
    });
  }
}

/** A draft or patch's set fields, validated. Blank values mean "the default" and are left out. */
function parseFrameFields(input: Record<string, unknown>): StoredEmailFrame {
  const out: StoredEmailFrame = {};
  for (const [key, value] of Object.entries(input)) {
    if (!isField(key)) throw new HttpsError('invalid-argument', `Unknown email frame field: ${key}.`);
    const parsed = parseField(key, value);
    if (parsed === '') continue;
    if (key === 'logoUrl') assertLogoInLibrary(parsed);
    out[key] = parsed;
  }
  return out;
}

export async function getEmailFrameHandler(_req: CallableRequest<unknown>): Promise<EmailFrameState> {
  const read = await readStoredEmailFrame('getEmailFrame');
  return { ...read, defaults: { ...DEFAULT_EMAIL_FRAME } };
}

const SaveArgs = z
  .object({
    /** A value sets the field, null resets it to the default, a missing key is untouched. */
    changes: z.record(z.string(), z.union([z.string(), z.null()])).optional(),
    /** Removes every frame field: the whole frame back to its defaults. */
    resetAll: z.literal(true).optional(),
  })
  .strict();

export async function saveEmailFrameHandler(req: CallableRequest<unknown>): Promise<EmailFrameState> {
  const uid = req.auth!.uid;
  const parsedArgs = SaveArgs.safeParse(req.data);
  if (!parsedArgs.success) {
    throw new HttpsError('invalid-argument', parsedArgs.error.issues.map((i) => i.message).join(' '));
  }
  const { changes = {}, resetAll = false } = parsedArgs.data;
  const changedKeys = Object.keys(changes);
  if (resetAll && changedKeys.length > 0) {
    throw new HttpsError('invalid-argument', 'Reset the frame or change fields, not both in one save.');
  }
  if (!resetAll && changedKeys.length === 0) {
    throw new HttpsError('invalid-argument', 'Nothing to save.');
  }

  // Validate every change before reading or writing anything, so a refused
  // save writes nothing (D-SAVE-OR-FAIL-VISIBLY).
  const sets: StoredEmailFrame = {};
  const resets: EmailFrameField[] = [];
  for (const key of changedKeys) {
    if (!isField(key)) throw new HttpsError('invalid-argument', `Unknown email frame field: ${key}.`);
    const value = changes[key];
    if (value === null) {
      resets.push(key);
      continue;
    }
    const parsed = parseField(key, value);
    if (parsed === '') {
      resets.push(key);
      continue;
    }
    if (key === 'logoUrl') assertLogoInLibrary(parsed);
    sets[key] = parsed;
  }

  // The whole document is replaced with the merged result, not merged field by
  // field: this callable is its only writer, so the result is exactly what the
  // response reports. Fields this request did not name are carried over from
  // the current document, so an older client that does not know a field never
  // wipes it.
  const current = resetAll ? {} : (await readStoredEmailFrame('saveEmailFrame')).stored;
  const next: StoredEmailFrame = { ...current, ...sets };
  for (const key of resets) delete next[key];

  const updatedAt = new Date().toISOString();
  await db()
    .doc(EMAIL_FRAME_DOC_PATH)
    .set({ ...next, updatedAt, updatedBy: uid });

  const auditFields: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(sets)) auditFields[key] = value;
  for (const key of resets) auditFields[key] = null;
  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.EMAIL_FRAME_UPDATED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetCollection: 'business_settings',
    description: resetAll ? 'Email frame reset to its defaults' : `Email frame changed: ${Object.keys(auditFields).join(', ')}`,
    payload: { resetAll, fields: auditFields },
  });
  logEvent({
    severity: 'info',
    function: 'saveEmailFrame',
    event: resetAll ? 'admin.email_frame.reset' : 'admin.email_frame.saved',
    uid,
    extra: { fields: Object.keys(auditFields) },
  });

  return { stored: next, defaults: { ...DEFAULT_EMAIL_FRAME }, updatedAt, updatedBy: uid };
}

/**
 * The sample email the frame preview renders. It uses every element the frame
 * styles (headline, paragraph, list, button, callout), so every color field
 * shows somewhere. Plain markup of the kind the template sanitizer keeps.
 */
export const FRAME_PREVIEW_SAMPLE = {
  subject: 'Your visit is booked',
  headline: 'See you Saturday, Biscuit',
  content: [
    '<p>Hi Jordan,</p>',
    '<p>Your drop-in visit is confirmed. Here is the plan:</p>',
    '<ul><li>Saturday, 10:00 AM</li><li>Walk, fresh water and dinner</li></ul>',
    '<p><a class="button" href="https://kinfolk.tribetails.com/sample">View the visit</a></p>',
    '<blockquote><p>Leave the spare key in the lockbox by Friday night.</p></blockquote>',
    '<p>Thanks,<br>Auntie</p>',
  ].join(''),
} as const;

const PreviewArgs = z.object({ frame: z.record(z.string(), z.unknown()) }).strict();

export async function previewEmailFrameHandler(
  req: CallableRequest<unknown>,
): Promise<{ subject: string; html: string; text: string }> {
  const parsedArgs = PreviewArgs.safeParse(req.data);
  if (!parsedArgs.success) {
    throw new HttpsError('invalid-argument', parsedArgs.error.issues.map((i) => i.message).join(' '));
  }
  const frame = resolveEmailFrame(parseFrameFields(parsedArgs.data.frame));
  const parts = sendPartsFor({ ...FRAME_PREVIEW_SAMPLE, format: 'visual' }, frame);
  const out = renderEmailParts({ ...parts, data: {} });
  return { subject: out.subject, html: out.html ?? '', text: out.text };
}

const OPTS = { region: 'us-central1', cors: TRIBETAILS_CORS } as const;

export const getEmailFrame = onCall(
  { ...OPTS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('getEmailFrame', getEmailFrameHandler),
);

export const saveEmailFrame = onCall(
  { ...OPTS, secrets: ['SENTRY_DSN', 'CLOUDINARY_CLOUD_NAME'] },
  wrapAdminCallable('saveEmailFrame', saveEmailFrameHandler),
);

export const previewEmailFrame = onCall(
  { ...OPTS, secrets: ['SENTRY_DSN', 'CLOUDINARY_CLOUD_NAME'] },
  wrapAdminCallable('previewEmailFrame', previewEmailFrameHandler),
);
