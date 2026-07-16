import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';

interface VetClinicDto {
  id: string;
  name: string;
  phone: string;
  address: string;
  website: string;
  googleMapsUrl: string;
  isEmergency: boolean;
}

interface GetVetClinicsResult {
  clinics: VetClinicDto[];
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Returns the shared `vet_clinics` catalog (the "vet bank"). Read-only for any
 * signed-in user (kinfolk + admin). Admin writes happen via the AuntieOS
 * clients writing directly to Firestore (rules: isAuntie). Kinfolk add-new goes
 * through `submitVetClinic`, which lands a `verified: false` pending entry.
 *
 * This callable returns only APPROVED clinics: a doc is hidden iff
 * `verified === false`. Legacy/admin-authored docs predate the `verified`
 * field, so a MISSING flag is treated as approved (fail-open for curated data);
 * only an explicit pending submission is withheld from other households. The
 * AuntieOS admin reads `vet_clinics` directly (not via this callable) so it
 * still sees pending entries to approve.
 */
export async function getVetClinicsHandler(
  req: CallableRequest<unknown>,
): Promise<GetVetClinicsResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const snap = await db().collection('vet_clinics').get();
  const clinics: VetClinicDto[] = snap.docs
    .filter((d) => {
      const data = d.data() as Record<string, unknown>;
      return str(data['name']).length > 0 && data['verified'] !== false;
    })
    .map((d) => {
      const data = d.data() as Record<string, unknown>;
      return {
        id: d.id,
        name: str(data['name']),
        phone: str(data['phone']),
        address: str(data['address']),
        website: str(data['website']),
        googleMapsUrl: str(data['googleMapsUrl']),
        isEmergency: data['isEmergency'] === true,
      };
    });

  logEvent({ severity: 'info', function: 'getVetClinics', event: 'portal.vetClinics.resolved', uid, extra: { count: clinics.length } });
  return { clinics };
}

export const getVetClinics = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapCallable('getVetClinics', getVetClinicsHandler),
);
