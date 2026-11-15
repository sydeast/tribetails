import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { resolveKinfolkAccess } from '../lib/resolveKinfolkAccess';
import { readHouseholdKinRoster } from '../lib/kinRoster';
import { chooseKinEnabled } from '../lib/featureFlags';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { householdStaffFlag } from '../lib/staffGate';
import { TRIBETAILS_CORS } from '../lib/cors';

interface GetHouseholdKinRosterRequest {
  kinfolkId?: string;
}

interface GetHouseholdKinRosterResult {
  /**
   * The household's active Kin, the ones a new visit covers. `adminId` is the
   * Kin's admin record, given to staff only and only when it differs from
   * `id`: a visit made before 2026-11-14 may have stored that id, and the
   * visit's Kin editor has to recognise it.
   */
  kin: Array<{ id: string; name: string | null; adminId?: string }>;
  /**
   * Whether this caller may choose specific Kin for a visit. False, the
   * default: every visit covers every Kin above and the screen shows no
   * picker. True: the screen offers the Kin above, all chosen to begin with,
   * and the ids it sends back are kept.
   */
  chooseKin: boolean;
}

/**
 * The Kin a new visit for this household covers, and whether the caller may
 * narrow them (#1822, #1862, operator ruling 2026-11-12).
 *
 * WHY A CALLABLE. Every booking screen used to build this list itself, from a
 * different place: the admin apps from the flat `kin` records, the portal
 * from the household's copies with a memorial Kin among them, the server from
 * the household's copies without. One booking read six Kin, three and four
 * depending on the screen. This returns the list the booking writers store
 * (`lib/kinRoster.ts#readHouseholdKinRoster`), so the admin web app, the
 * admin Android app, the desktop console and both portal apps name the same
 * Kin the visit will carry.
 *
 * `chooseKin` rides with it rather than being read from `getFeatureFlags`,
 * so a screen never shows a picker the write would then set aside: both come
 * from `lib/featureFlags.ts#chooseKinEnabled` for the same caller.
 *
 * GATE: `resolveKinfolkAccess`. A household reads its own roster; the owner
 * and an Auntie (on `lib/auntieAccess.ts`, for the visit's Kin editor) read
 * the one they name. Names and ids only: no care notes, no 411. A household
 * is never handed an admin record id.
 */
export async function getHouseholdKinRosterHandler(
  req: CallableRequest<GetHouseholdKinRosterRequest>,
): Promise<GetHouseholdKinRosterResult> {
  initSentry();

  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const { kinfolkId, isOperator } = await resolveKinfolkAccess(
    uid,
    req.data?.kinfolkId,
    householdStaffFlag(req.auth, 'getHouseholdKinRoster'),
    'getHouseholdKinRoster',
    req.auth,
  );

  const [roster, chooseKin] = await Promise.all([readHouseholdKinRoster(kinfolkId), chooseKinEnabled(uid)]);

  logEvent({
    severity: 'info',
    function: 'getHouseholdKinRoster',
    event: 'portal.kinRoster.resolved',
    uid,
    extra: { kinfolkId, count: roster.length, chooseKin },
  });

  return {
    kin: roster.map((k) => ({
      id: k.id,
      name: k.name,
      ...(isOperator && k.flatId !== null && k.flatId !== k.id ? { adminId: k.flatId } : {}),
    })),
    chooseKin,
  };
}

export const getHouseholdKinRoster = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('getHouseholdKinRoster', getHouseholdKinRosterHandler),
);
