import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { isStaff } from '../lib/staffGate';
import { TRIBETAILS_CORS } from '../lib/cors';

/**
 * Exported for `test/callableContract.test.ts`: two clients now build this
 * payload (the kinfolk portal and the AuntieOS vet-clinic picker), so the field
 * set is frozen there.
 *
 * `isEmergency` is OPTIONAL with a `false` default, which is what keeps every
 * payload written before 2026-07-25 valid: the portal has never sent it and
 * still does not. It is not `.coerce`d, because "yes" or 1 arriving from a
 * mis-wired client should fail loudly rather than quietly flag a clinic as a
 * 24-hour emergency room that it is not.
 */
export const Args = z.object({
  name: z.string().trim().min(1, 'A clinic name is required.').max(160),
  phone: z.string().trim().max(40).optional().default(''),
  address: z.string().trim().max(240).optional().default(''),
  website: z.string().trim().max(400).optional().default(''),
  isEmergency: z.boolean().optional().default(false),
});

/** Normalizes a clinic name for case/space-insensitive dedupe. */
function normName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Kinfolk-facing "add a vet that isn't on the list". Firestore rules block
 * direct kinfolk writes to `vet_clinics` (write: isAuntie), so this admin-SDK
 * callable lands a PENDING entry (`verified: false`) tagged with `submittedBy`.
 * The operator approves it in AuntieOS (flips `verified: true`), which is when
 * it becomes visible to other households via getVetClinics.
 *
 * Dedupe: if a clinic with the same normalized name already exists (approved or
 * pending), we return that id instead of creating a duplicate. This keeps the
 * bank clean and makes the call idempotent under double-tap.
 *
 * STAFF BRANCH (2026-07-25): the AuntieOS vet-clinic picker creates through
 * this same callable, and an operator typing a clinic into a household's record
 * IS the curation step. Landing it pending would queue the operator's own entry
 * for the operator's own approval, and the clinic would be invisible to every
 * household until they did that. So a staff caller lands `verified: true`.
 * Kinfolk submissions are untouched and still land pending.
 */
export async function submitVetClinicHandler(
  req: CallableRequest<unknown>,
): Promise<{ clinicId: string; created: boolean; pending: boolean }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const parsed = Args.safeParse(req.data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', parsed.error.issues[0]?.message ?? 'Invalid clinic.');
  }
  const args = parsed.data;
  const wanted = normName(args.name);

  // Dedupe against the existing catalog (small collection; full read is fine).
  const snap = await db().collection('vet_clinics').get();
  const existing = snap.docs.find((d) => {
    const n = (d.data() as Record<string, unknown>)['name'];
    return typeof n === 'string' && normName(n) === wanted;
  });
  if (existing) {
    const pending = (existing.data() as Record<string, unknown>)['verified'] === false;
    logEvent({ severity: 'info', function: 'submitVetClinic', event: 'portal.vetClinic.deduped', uid, extra: { clinicId: existing.id } });
    return { clinicId: existing.id, created: false, pending };
  }

  const staff = isStaff(uid, req.auth?.token?.admin === true, 'submitVetClinic');

  const ref = await db().collection('vet_clinics').add({
    name: args.name,
    phone: args.phone,
    address: args.address,
    website: args.website,
    googleMapsUrl: '',
    isEmergency: args.isEmergency,
    verified: staff,
    submittedBy: uid,
    notes: '',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  logEvent({ severity: 'info', function: 'submitVetClinic', event: 'portal.vetClinic.submitted', uid, extra: { clinicId: ref.id, name: args.name, verified: staff } });
  return { clinicId: ref.id, created: true, pending: !staff };
}

export const submitVetClinic = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapCallable('submitVetClinic', submitVetClinicHandler),
);
