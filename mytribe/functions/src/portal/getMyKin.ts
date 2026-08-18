import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { db } from '../lib/firestoreAdmin';
import { resolveKinfolkAccess } from '../lib/resolveKinfolkAccess';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { isPortalHiddenKinStatus } from '../lib/kinStatus';

interface GetMyKinRequest {
  kinfolkId?: string;
}

interface KinDto {
  id: string;
  name: string | null;
  species: string | null;
  breed: string | null;
  ageYears: number | null;
  photoUrl: string | null;
  status: 'active' | 'noLongerWithUs';
  /**
   * `aiBlurb` IS GONE, AND MUST NOT COME BACK. It carried
   * `the_411/{legacyKinId}.rawSummary`, falling back to `.personality`, straight
   * to the signed-in household, and the portal rendered it under "ABOUT / The
   * basics" on the Kin detail screen (`KinDetailScreen.kt:206`).
   *
   * The_411 and dossiers are ADMIN-ONLY. Kinfolk never see them. That is a
   * standing operator ruling, and `firestore.rules:873` already gates the
   * collection to `isAuntie()` — this callable reached around it, because the
   * Admin SDK does not evaluate rules. Only households whose kin carried a
   * `legacyKinId` were affected, which is why nobody noticed.
   *
   * A suite was pinning it in place: `test/getMyKin.test.ts` asserted
   * `aiBlurb === 'Mr Biggles is pure joy.'`, so the leak was green.
   *
   * If a kin-facing "about" blurb is wanted, it is a different field with
   * content the operator writes for the household, not a summary of internal
   * notes rewritten by a model.
   */
  feedingInstructions: string | null;
  walkingInstructions: string | null;
  medications: string | null;
  allergies: string | null;
  emergencyNotes: string | null;
  sitterNotes: string | null;
}

interface GetMyKinResult {
  kin: KinDto[];
}

/**
 * Returns the kin (pets) for the signed-in kinfolk.
 *
 * ONE SOURCE: `families/{kinfolkId}/kin/{kinId}`, the MyTribe structured fields
 * (name, breed, photo, status, instructions).
 *
 * It used to be two. The second was `the_411/{legacyKinId}`, the AuntieOS AI
 * summary, merged in as `aiBlurb`. That collection is admin-only by operator
 * ruling and by `firestore.rules:873`; this callable runs on the Admin SDK,
 * which does not evaluate rules, so the gate never applied to it. See the
 * KinDto note above. Nothing in this file reads `the_411` any more, and nothing
 * in it should.
 */
export async function getMyKinHandler(
  req: CallableRequest<GetMyKinRequest>,
): Promise<GetMyKinResult> {
  initSentry();

  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const firestore = db();
  const { kinfolkId } = await resolveKinfolkAccess(uid, req.data?.kinfolkId, req.auth?.token?.admin === true, 'getMyKin');

  // NO SERVER-SIDE STATUS FILTER. This used to be
  // `.where('status', 'in', ['active', 'noLongerWithUs'])`, and Firestore's `in`
  // also excludes every document MISSING the field, so a kin doc created by the
  // flat -> family mirror (which merges staff fields into a doc that may not
  // exist yet) disappeared from the portal with no error. Status is a two-value
  // flag with a default; an inclusion filter is the wrong shape for it. The
  // whole subcollection is fetched (a household has a handful of pets, and
  // there is no `limit` here, so nothing about page sizes changes) and only the
  // legacy admin spellings are dropped in memory below.
  const kinSnap = await firestore
    .collection('families')
    .doc(kinfolkId)
    .collection('kin')
    .get();

  const visibleDocs = kinSnap.docs.filter(
    (d) => !isPortalHiddenKinStatus((d.data() as Record<string, unknown>)['status']),
  );

  const kin: KinDto[] = await Promise.all(
    visibleDocs.map(async (d) => {
      const data = d.data() as Record<string, unknown>;
      return {
        id: d.id,
        name: stringOrNull(data['name']),
        species: stringOrNull(data['species']),
        breed: stringOrNull(data['breed']),
        ageYears: numericOrNull(data['ageYears']),
        photoUrl: stringOrNull(data['photoUrl']),
        status: (stringOrNull(data['status']) === 'noLongerWithUs' ? 'noLongerWithUs' : 'active') as 'active' | 'noLongerWithUs',
        feedingInstructions: stringOrNull(data['feedingInstructions']),
        walkingInstructions: stringOrNull(data['walkingInstructions']),
        medications: stringOrNull(data['medications']),
        allergies: stringOrNull(data['allergies']),
        emergencyNotes: stringOrNull(data['emergencyNotes']),
        sitterNotes: stringOrNull(data['sitterNotes']),
      };
    }),
  );

  logEvent({
    severity: 'info',
    function: 'getMyKin',
    event: 'portal.kin.resolved',
    uid,
    extra: { kinfolkId, count: kin.length },
  });

  return { kin };
}

function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function numericOrNull(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  }
  return null;
}

export const getMyKin = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('getMyKin', getMyKinHandler),
);
