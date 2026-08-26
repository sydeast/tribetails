import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import { validateResponse } from '../lib/callableResponse';
import { classifyArrivalDistance, haversineMeters } from '../lib/geo';
import { readArrivalSettings } from '../lib/arrivalVerification';
import { resolveHouseholdLocation } from '../lib/householdLocation';

/**
 * ISSUE #582: measures how far a recorded arrival was from the household, and
 * stamps the DISTANCE — never the position — on the visit.
 *
 * THE SHAPE, and why arrival itself is untouched. Marking a visit ARRIVED stays
 * exactly what it was: a direct client patch on `kin_care_sessions`, riding
 * Firestore's offline write queue, because a phone between houses is regularly
 * offline and `KinCareRepository.kt`'s own comment records that as a standing
 * decision. This callable runs BESIDE that patch, best effort, when there is a
 * network. It cannot fail an arrival, it does not gate one, and an Auntie who
 * is offline, has no fix, or has denied location permission still arrives
 * normally. What she loses is the verification, and an unverified arrival is
 * ALLOWED to complete later — see `lib/arrivalVerification.ts`.
 *
 * WHY THE MEASUREMENT IS SERVER-SIDE. The device has the GPS, so the fix has to
 * come from the client; but the household coordinate, the operator's radius, the
 * distance arithmetic, the accuracy rule, and the write are all here. The client
 * is told the verdict, it does not compute one, and the three stored fields are
 * written with the Admin SDK from values the server derived.
 *
 * WHAT THIS DOES NOT CLAIM. It is not proof of presence against a determined
 * forger: a client that wants to can send a coordinate it was never at, exactly
 * as it can already write an `arrivedAt` for a visit it never made
 * (`firestore.rules` leaves the in-visit lifecycle client-writable on purpose).
 * This raises the same honest-mistake floor `arrivedAt` sits on — a skipped
 * visit, a batch of stamps entered from the car at the end of the day — and it
 * is described that way in the PR rather than as a security control.
 *
 * THE FIX IS NEVER PERSISTED. `lat`/`lng` arrive, get measured against the
 * household, and are dropped. They are not written to the session, not put in
 * the audit payload, and not logged: a coordinate carefully kept off the
 * document is no better off in `activity_log`.
 */

const SESSIONS_COLLECTION = 'kin_care_sessions';
const MAPBOX_ACCESS_TOKEN = 'MAPBOX_ACCESS_TOKEN';

export const Args = z.object({
  sessionId: z.string().min(1).max(120),
  /** The device's fix at the moment "Arrived" was pressed. */
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  /**
   * The fix's own error radius in metres, as the platform reported it
   * (`Location.accuracy` on Android, `coords.accuracy` in a browser). Optional
   * because not every provider supplies one; absent is treated as 0 slack,
   * which is the strict reading, and a huge value is treated as no evidence.
   */
  accuracyMeters: z.number().min(0).max(100_000).optional(),
});

/**
 * The four things that can come back, as a code the client branches on rather
 * than a message it matches. Only `outside` is bad news, and even that does not
 * undo the arrival — it warns now instead of at COMPLETE, which is the whole
 * point of running this at arrival time.
 */
export const ARRIVAL_CHECK_STATUSES = [
  'within',
  'outside',
  'unverified',
  'household_location_unknown',
] as const;

export const Result = z
  .object({
    ok: z.literal(true),
    sessionId: z.string(),
    status: z.enum(ARRIVAL_CHECK_STATUSES),
    /** Metres from the household. Null when no household coordinate could be resolved. */
    distanceMeters: z.number().nullable(),
    /** The operator's radius, echoed so the client can word its own message. */
    radiusMeters: z.number(),
    /** False when the operator has not switched arrival verification on at all. */
    verificationRequired: z.boolean(),
    /** Why there is no distance, when there is none. */
    reason: z.string().nullable(),
  })
  .strict();

export type VerifyVisitArrivalResult = z.infer<typeof Result>;

export async function verifyVisitArrivalHandler(
  req: CallableRequest<unknown>,
): Promise<VerifyVisitArrivalResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'verifyVisitArrival validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const ref = db().doc(`${SESSIONS_COLLECTION}/${args.sessionId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', `Session '${args.sessionId}' not found.`);
  const session = (snap.data() ?? {}) as Record<string, unknown>;

  // DELIBERATELY NOT gated on `status === 'ARRIVED'`. The arrival patch rides
  // the offline queue and this call does not, so on a flaky connection this can
  // land first and the status can still say ON_MY_WAY. Refusing on that would
  // drop the verification on precisely the arrivals most worth verifying.
  const settings = await readArrivalSettings(db());

  const kinfolkId = typeof session['kinfolkId'] === 'string' ? session['kinfolkId'] : '';
  const token = (process.env[MAPBOX_ACCESS_TOKEN] ?? '').trim();
  const lookup = await resolveHouseholdLocation(db(), kinfolkId, token);

  let status: (typeof ARRIVAL_CHECK_STATUSES)[number];
  let distanceMeters: number | null = null;
  let reason: string | null = null;

  if (!lookup.found) {
    // No coordinate for this household: no address, an address Mapbox will not
    // match, or the geocoder being down. None of those is the Auntie's doing,
    // so none of them records a distance and none of them will refuse a
    // COMPLETE later. The reason is returned so the operator can go fix the
    // address rather than wonder why the check never runs.
    status = 'household_location_unknown';
    reason = lookup.reason;
  } else {
    distanceMeters =
      Math.round(haversineMeters({ lat: args.lat, lng: args.lng }, lookup.location) * 10) / 10;
    status = classifyArrivalDistance({
      distanceMeters,
      accuracyMeters: args.accuracyMeters ?? null,
      radiusMeters: settings.radiusMeters,
    });
    if (status === 'unverified') reason = 'fix_too_imprecise';
  }

  // The three stamped fields, written together so a re-check overwrites a stale
  // measurement rather than leaving half of one behind. `null` on the no-
  // coordinate path clears any earlier reading for the same reason.
  await ref.set(
    {
      arrivalDistanceMeters: distanceMeters,
      arrivalAccuracyMeters: distanceMeters === null ? null : (args.accuracyMeters ?? null),
      arrivalLocationCheckedAt: new Date().toISOString(),
    },
    { merge: true },
  );

  await writeAuditEntry({
    event: AUDIT_EVENTS.VISIT_ARRIVAL_LOCATION_CHECK,
    // `outside` is the one an operator should be able to find later without
    // reading every info-level row.
    severity: status === 'outside' ? 'warn' : 'info',
    status: 'SUCCESS',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetUid: args.sessionId,
    targetCollection: SESSIONS_COLLECTION,
    description: `Arrival location check on session ${args.sessionId}: ${status}`,
    payload: {
      sessionId: args.sessionId,
      // Distance, radius and accuracy only. The coordinate that produced them
      // is not written here any more than it is written to the session.
      checkStatus: status,
      distanceMeters,
      radiusMeters: settings.radiusMeters,
      accuracyMeters: args.accuracyMeters ?? null,
      verificationRequired: settings.required,
      ...(reason ? { reason } : {}),
    },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'verifyVisitArrival',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  logEvent({
    severity: 'info',
    function: 'verifyVisitArrival',
    event: 'admin.visit.arrivalChecked',
    uid,
    extra: {
      sessionId: args.sessionId,
      status,
      distanceMeters,
      radiusMeters: settings.radiusMeters,
      geocodedNow: lookup.found ? lookup.geocodedNow : false,
    },
  });

  return validateResponse('verifyVisitArrival', Result, {
    ok: true as const,
    sessionId: args.sessionId,
    status,
    distanceMeters,
    radiusMeters: settings.radiusMeters,
    verificationRequired: settings.required,
    reason,
  });
}

export const verifyVisitArrival = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', MAPBOX_ACCESS_TOKEN] },
  wrapAdminCallable('verifyVisitArrival', verifyVisitArrivalHandler),
);
