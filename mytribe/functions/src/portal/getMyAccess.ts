import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { db } from '../lib/firestoreAdmin';
import { isStaff } from '../lib/staffGate';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { logEvent } from '../lib/logger';
import { TRIBETAILS_CORS } from '../lib/cors';
import { FULL_CPU } from '../lib/runtimeOptions';

interface GetMyAccessResult {
  kinfolkIds: string[];
  isOperator: boolean;
}

/**
 * Returns the kinfolkIds the caller is allowed to view, plus the operator flag.
 *
 * Non-operator: returns `clients/{uid}.kinfolkIds` (or empty).
 * Operator (in `AUNTIE_OPERATOR_UIDS` env): returns the union of
 *   - `clients/{uid}.kinfolkIds` (so primary memberships still resolve)
 *   - all `kinfolk/{kinfolkId}` doc ids (full directory)
 *
 * The client uses this to drive `LaunchDestination` (NoTribes / Home / Pick).
 * Operators always land on `Pick` because they see every tribe.
 */
export async function getMyAccessHandler(
  req: CallableRequest<unknown>,
): Promise<GetMyAccessResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Sign-in required.');
  }

  const firestore = db();
  const clientSnap = await firestore.collection('clients').doc(uid).get();
  const ownIds: string[] = (clientSnap.data()?.kinfolkIds ?? []) as string[];

  const operator = isStaff(uid, req.auth?.token?.admin === true, 'getMyAccess');
  // Diagnostic: log env state so prod logs reveal why operator gate fires (or doesn't).
  const rawEnv = process.env.AUNTIE_OPERATOR_UIDS ?? '';
  const allowedList = rawEnv.split(',').map((s) => s.trim()).filter(Boolean);
  logEvent({
    severity: 'info',
    function: 'getMyAccess',
    event: 'portal.access.resolved',
    uid,
    extra: {
      isOperator: operator,
      ownIdsCount: ownIds.length,
      envSecretPresent: rawEnv.length > 0,
      envSecretLen: rawEnv.length,
      allowlistSize: allowedList.length,
      // Hash-style hints, never log the full UID list.
      uidPrefix: uid.slice(0, 6),
      firstAllowedPrefix: allowedList[0]?.slice(0, 6) ?? null,
    },
  });

  if (!operator) {
    return { kinfolkIds: ownIds, isOperator: false };
  }

  // Operator: enumerate all kinfolk docs. `.select()` with no fields is an
  // ids-only projection (RULING O-6, Q4) — no household field payload is
  // read/transferred just to list existence.
  const kinfolkSnap = await firestore.collection('kinfolk').select().get();
  const allIds = kinfolkSnap.docs.map((d) => d.id);
  const merged = Array.from(new Set([...allIds, ...ownIds]));

  logEvent({
    severity: 'info',
    function: 'getMyAccess',
    event: 'portal.access.operator',
    uid,
    extra: { count: merged.length, kinfolkCollectionSize: allIds.length },
  });

  return { kinfolkIds: merged, isOperator: true };
}

export const getMyAccess = onCall(
  // Gates every portal screen.
  // Kept at a full vCPU so the warm instance minInstances buys keeps 80-way
  // concurrency; below 1 vCPU Cloud Run pins concurrency to 1.
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'],
    minInstances: 1,
    ...FULL_CPU,
  },
  wrapCallable('getMyAccess', getMyAccessHandler),
);
