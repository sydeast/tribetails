import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { auditActorPayload, resolveAuditActor } from '../lib/auditActor';
import { TRIBETAILS_CORS } from '../lib/cors';

/**
 * #2287: a staff member saves her OWN Account profile.
 *
 * The Account page on admin web edits six text fields on `users/{uid}`: the
 * name (display name, first name, last name), phone, title and bio. The owner
 * writes that record from the browser, which `firestore.rules` allows him. An
 * Auntie reads her own record (#2215) and the rules refuse her every client
 * write to it, so her Save needs a server path. This is it.
 *
 * THE RECORD WRITTEN IS THE CALLER'S (`req.auth.uid`). The request carries no
 * uid, and the schema is strict, so a payload that names one is refused rather
 * than ignored. The same strictness keeps every other key on the record out of
 * reach: her photo goes through `setMediaProfilePhoto`, her Home layout through
 * `saveDashboardLayout`, and her email belongs to sign-in.
 *
 * `{ merge: true }` writes the six fields and `updatedAt` and leaves the rest
 * of the record alone. `updatedAt` is an ISO string because that is what the
 * admin web's own profile save has always written to this field.
 *
 * Refusals a person can fix are written as sentences for her, because the
 * clients show a server sentence as it is (`callableErrorText`).
 */

/** The six fields, each with its on-screen label and the longest value kept. */
export const STAFF_PROFILE_FIELDS = [
  { key: 'displayName', label: 'Display name', max: 120 },
  { key: 'firstName', label: 'First name', max: 80 },
  { key: 'lastName', label: 'Last name', max: 80 },
  { key: 'phone', label: 'Phone', max: 40 },
  { key: 'title', label: 'Title', max: 120 },
  { key: 'bio', label: 'Bio', max: 2000 },
] as const;

export type StaffProfileField = (typeof STAFF_PROFILE_FIELDS)[number]['key'];

export type StaffProfile = Record<StaffProfileField, string>;

export const Args = z
  .object({
    displayName: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    phone: z.string(),
    title: z.string(),
    bio: z.string(),
  })
  .strict();

export interface SaveMyStaffProfileResult {
  ok: true;
  /** The six fields as stored, trimmed. */
  profile: StaffProfile;
  /** The fields this save changed. Empty when nothing differed. */
  changed: StaffProfileField[];
}

export async function saveMyStaffProfileHandler(
  req: CallableRequest<unknown>,
): Promise<SaveMyStaffProfileResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'saveMyStaffProfile validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const profile = {} as StaffProfile;
  for (const { key, label, max } of STAFF_PROFILE_FIELDS) {
    const value = args[key].trim();
    if (value.length > max) {
      throw new HttpsError(
        'invalid-argument',
        `${label} can be at most ${max.toLocaleString('en-US')} characters.`,
        { validationErrors: [{ path: key, message: 'too long' }] },
      );
    }
    profile[key] = value;
  }
  if (profile.displayName === '') {
    throw new HttpsError('invalid-argument', 'Enter a display name.', {
      validationErrors: [{ path: 'displayName', message: 'required' }],
    });
  }

  const ref = db().collection('users').doc(uid);
  const snap = await ref.get();
  const stored = (snap.exists ? snap.data() : undefined) ?? {};
  const changed = STAFF_PROFILE_FIELDS.map((f) => f.key).filter((key) => {
    const before = typeof stored[key] === 'string' ? (stored[key] as string) : '';
    return before !== profile[key];
  });
  if (changed.length === 0) return { ok: true, profile, changed };

  await ref.set({ ...profile, updatedAt: new Date().toISOString() }, { merge: true });

  // Field names only. The values (a phone number, a bio) stay off the log.
  const actor = await resolveAuditActor(req.auth, 'saveMyStaffProfile');
  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.PROFILE_UPDATED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetUid: uid,
    targetCollection: 'users',
    description: `Account profile updated: ${changed.join(', ')}`,
    payload: { fields: changed, ...auditActorPayload(actor) },
  }).catch((err: unknown) => {
    // The profile is saved. A log line that failed to write must not tell her
    // the save failed.
    logEvent({
      severity: 'error',
      function: 'saveMyStaffProfile',
      event: 'admin.staffProfile.auditFailed',
      uid,
      extra: { message: err instanceof Error ? err.message : String(err) },
    });
  });

  logEvent({
    severity: 'info',
    function: 'saveMyStaffProfile',
    event: 'admin.staffProfile.saved',
    uid,
    extra: { fields: changed },
  });

  return { ok: true, profile, changed };
}

export const saveMyStaffProfile = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('saveMyStaffProfile', saveMyStaffProfileHandler),
);
