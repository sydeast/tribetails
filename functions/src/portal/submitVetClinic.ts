import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';

const Args = z.object({
  name: z.string().trim().min(1, 'A clinic name is required.').max(160),
  phone: z.string().trim().max(40).optional().default(''),
  address: z.string().trim().max(240).optional().default(''),
  website: z.string().trim().max(400).optional().default(''),
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

  const ref = await db().collection('vet_clinics').add({
    name: args.name,
    phone: args.phone,
    address: args.address,
    website: args.website,
    googleMapsUrl: '',
    isEmergency: false,
    verified: false,
    submittedBy: uid,
    notes: '',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  logEvent({ severity: 'info', function: 'submitVetClinic', event: 'portal.vetClinic.submitted', uid, extra: { clinicId: ref.id, name: args.name } });
  return { clinicId: ref.id, created: true, pending: true };
}

export const submitVetClinic = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapCallable('submitVetClinic', submitVetClinicHandler),
);
