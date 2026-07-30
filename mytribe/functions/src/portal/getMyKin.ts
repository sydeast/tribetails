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
  /** AI-summarized blurb from AuntieOS `the_411/{kinId}` (rawSummary or personality). */
  aiBlurb: string | null;
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
 * Reads from two sources, merged:
 *  1. `families/{kinfolkId}/kin/{kinId}`, MyTribe structured fields (name, breed, photo, status, instructions)
 *  2. `the_411/{kinId}`, AuntieOS AI summary (rawSummary, personality, dietaryDetails, etc.)
 *
 * The `the_411` collection is keyed by integer-string `kinId`. Production data
 * has no link from kinId to kinfolkId today, we look up `the_411` only for
 * structured kin docs that carry a `legacyKinId` field referencing them.
 *
 * If structured kin docs don't exist yet, returns empty list (NOT the_411 contents,
 * because those are unauth-bounded by kinfolkId until AuntieOS adds the link).
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
      const legacyKinId = stringOrNull(data['legacyKinId']);
      let aiBlurb: string | null = null;
      if (legacyKinId) {
        const summarySnap = await firestore.collection('the_411').doc(legacyKinId).get();
        const summary = summarySnap.data() as Record<string, unknown> | undefined;
        aiBlurb =
          stringOrNull(summary?.['rawSummary']) ??
          stringOrNull(summary?.['personality']);
      }
      return {
        id: d.id,
        name: stringOrNull(data['name']),
        species: stringOrNull(data['species']),
        breed: stringOrNull(data['breed']),
        ageYears: numericOrNull(data['ageYears']),
        photoUrl: stringOrNull(data['photoUrl']),
        status: (stringOrNull(data['status']) === 'noLongerWithUs' ? 'noLongerWithUs' : 'active') as 'active' | 'noLongerWithUs',
        aiBlurb,
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
