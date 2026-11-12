import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldPath, FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import { logEvent } from '../lib/logger';
import { savedByStamp } from '../lib/savedByStamp';
import { BUSINESS_SETTINGS_DOC, FALLBACK_BUSINESS_TIME_ZONE, zonedNow } from '../lib/businessHours';
import type { SettingsRefusal } from '../lib/businessSettingsChecks';

/**
 * #1593: the one save for Settings.
 *
 * Before this, the admin web, admin Android and the desktop console wrote
 * `business_settings/business_settings` straight to Firestore, and the rules'
 * `validBusinessSettings()` (#519, #1409, #1410) was the only server check: types
 * and ranges on two dozen fields and nothing on the rest. The 2026-11-05 QA walk
 * saved a price of "abc", a close before the open and a date of 2026-13-45.
 * Every client now sends its changed fields here, each field is checked
 * (`lib/businessSettingsChecks.ts`), and the rules deny the document to every
 * client, so this is the only way in.
 *
 * Owner-only: not in `AUNTIE_ALLOWED_CALLABLES`, the same as the rules'
 * `isOwner()` it replaces. An Auntie never edits business configuration
 * (D-2026-09-22-AUNTIE-ROLE).
 *
 * WRITE SHAPE, unchanged from the direct writes it replaces:
 *  - A partial patch. Fields the request does not name are untouched.
 *  - Nested maps merge key by key (`mytribePortal`, `paymentOptions`,
 *    `businessHours`), so one section's slice never clobbers another's.
 *  - The KinCare rate card (`WHOLE_MAP_SETTINGS_FIELDS`) replaces what is stored,
 *    so a removed type is removed.
 *  - Arrays replace. `null` is a value (it is how a send hour is cleared).
 *  - #1978: a save that closes a day keeps the hours it had in `closedDayHours`,
 *    and one that opens a day drops them (`closedDayHoursChanges`). The server
 *    derives it from what is stored; no client sends it.
 *
 * REFUSED SAVES WRITE NOTHING. Every field is checked before the write, and a
 * refusal names the field (`details.field`) and lists every refusal
 * (`details.refusals`) so a client can put each sentence beside its field.
 */

export const Args = z
  .object({
    /** The changed fields, by top-level name. */
    changes: z.record(z.string(), z.unknown()),
  })
  .strict();

export interface SaveBusinessSettingsResult {
  updatedAt: string;
  updatedBy: string;
}

export const SETTINGS_REFUSED_CODE = 'settings_refused';

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The field paths a `set(..., { mergeFields })` has to name for the write to
 * mean "merge": every leaf of a nested map, and the top-level key of a
 * whole-map field. An empty map is a leaf, so `{}` still lands.
 */
export function mergeFieldPaths(
  changes: Record<string, unknown>,
  wholeMapFields: ReadonlySet<string>,
): FieldPath[] {
  const out: FieldPath[] = [];
  const walk = (segments: string[], value: unknown): void => {
    if (isPlainObject(value) && Object.keys(value).length > 0) {
      for (const [k, v] of Object.entries(value)) walk([...segments, k], v);
      return;
    }
    out.push(new FieldPath(...segments));
  };
  for (const [field, value] of Object.entries(changes)) {
    if (wholeMapFields.has(field)) out.push(new FieldPath(field));
    else walk([field], value);
  }
  return out;
}

/** The name the business would be left with: the patch's, else the stored one. */
function mergedNameRefusal(
  changes: Record<string, unknown>,
  stored: Record<string, unknown>,
  sentence: string,
): SettingsRefusal | null {
  const name = 'businessName' in changes ? changes['businessName'] : stored['businessName'];
  if (name === undefined) return null;
  if (typeof name === 'string' && name.trim() !== '') return null;
  return { field: 'businessName', message: sentence };
}

export async function saveBusinessSettingsHandler(
  req: CallableRequest<unknown>,
): Promise<SaveBusinessSettingsResult> {
  const uid = req.auth!.uid;
  const parsed = Args.safeParse(req.data);
  if (!parsed.success) {
    throw new HttpsError(
      'invalid-argument',
      'The settings did not arrive in a form the server can read. Reload and try again.',
    );
  }
  const { changes } = parsed.data;
  const fields = Object.keys(changes);
  if (fields.length === 0) throw new HttpsError('invalid-argument', 'Nothing to save.');

  const ref = db().doc(BUSINESS_SETTINGS_DOC);
  const snap = await ref.get();
  const stored = (snap.exists ? snap.data() : undefined) ?? {};
  const zone =
    typeof stored['timeZone'] === 'string' && stored['timeZone'].trim() !== ''
      ? stored['timeZone']
      : FALLBACK_BUSINESS_TIME_ZONE;
  const todayIso =
    zonedNow(Date.now(), zone)?.dateIso ??
    zonedNow(Date.now(), FALLBACK_BUSINESS_TIME_ZONE)!.dateIso;

  // Loaded here, not at file scope: the checks and the parsers they pull in are
  // only this callable's, and a file-scope import would charge them to every
  // function's cold start (`test/coldStartImportGraph.test.ts`).
  const checks = await import('../lib/businessSettingsChecks.js');
  const refusals = checks.businessSettingsRefusals(changes, {
    stored,
    todayIso,
    cloudName: process.env.CLOUDINARY_CLOUD_NAME ?? '',
  });
  if (!refusals.some((r) => r.field === 'businessName')) {
    const nameRefusal = mergedNameRefusal(changes, stored, checks.BUSINESS_NAME_REQUIRED);
    if (nameRefusal) refusals.push(nameRefusal);
  }
  if (refusals.length > 0) {
    logEvent({
      severity: 'info',
      function: 'saveBusinessSettings',
      event: 'admin.business_settings.refused',
      uid,
      extra: { fields: refusals.map((r) => r.field) },
    });
    throw new HttpsError('invalid-argument', refusals[0]!.message, {
      code: SETTINGS_REFUSED_CODE,
      field: refusals[0]!.field,
      refusals,
    });
  }

  // #1962: the uid, not the sign-in email. The screens name the person from it.
  const { updatedAt, updatedBy } = savedByStamp(uid);
  // #1978: the hours each day closed by this save had, kept beside the weekly
  // hours so reopening the day gives them back. Each day is its own merge path.
  const kept = checks.closedDayHoursChanges(changes['businessHours'], stored);
  const keptDays = Object.keys(kept);
  const closedDayHours: Record<string, unknown> = {};
  for (const day of keptDays) closedDayHours[day] = kept[day] ?? FieldValue.delete();
  const body = {
    ...changes,
    ...(keptDays.length > 0 ? { closedDayHours } : {}),
    updatedAt,
    updatedBy,
  };
  await ref.set(body, {
    mergeFields: [
      ...mergeFieldPaths(changes, checks.WHOLE_MAP_SETTINGS_FIELDS),
      ...keptDays.map((day) => new FieldPath('closedDayHours', day)),
      new FieldPath('updatedAt'),
      new FieldPath('updatedBy'),
    ],
  });

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.BUSINESS_SETTINGS_UPDATED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetCollection: 'business_settings',
    description: 'Business settings saved',
    payload: { fields },
  });
  logEvent({
    severity: 'info',
    function: 'saveBusinessSettings',
    event: 'admin.business_settings.saved',
    uid,
    extra: { fields },
  });
  return { updatedAt, updatedBy };
}

export const saveBusinessSettings = onCall(
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    secrets: ['SENTRY_DSN', 'CLOUDINARY_CLOUD_NAME'],
  },
  wrapAdminCallable('saveBusinessSettings', saveBusinessSettingsHandler),
);
