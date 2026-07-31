import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { requireKinfolkPerm } from '../lib/memberGate';
import { TRIBETAILS_CORS } from '../lib/cors';
import { resolveKinfolkAccess } from '../lib/resolveKinfolkAccess';

const CustomFieldZ = z.object({
  key: z.string().min(1).max(80),
  label: z.string().min(1).max(80),
  value: z.string().max(1000),
});

const Args = z.object({
  kinfolkId: z.string().optional(),
  gateCode: z.string().max(80).nullable().optional(),
  keyLocation: z.string().max(500).nullable().optional(),
  wifiPassword: z.string().max(200).nullable().optional(),
  customFields: z.array(CustomFieldZ).max(40).optional(),
});

/**
 * Writes `families/{kinfolkId}/homeAccess/current`.
 * MyTribe-owned subcollection. AuntieOS reads via her own client; we send
 * a notification ping so she knows fields changed (Phase 2C wires the FCM ping).
 */
export async function saveHomeAccessHandler(req: CallableRequest<unknown>): Promise<{ ok: true }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const args = Args.parse(req.data);
  const firestore = db();
  const hasAdminClaim = req.auth?.token?.admin === true;
  // Was a hard clients/{uid}.kinfolkIds check with no staff path, so an
  // operator got permission-denied here even though requireKinfolkPerm below
  // (and the read side) already knew how to let staff through. Same resolver
  // getMyKin/getMyBookings use; a cross-tenant resolution is audit-logged
  // inside it.
  const { kinfolkId } = await resolveKinfolkAccess(uid, args.kinfolkId, hasAdminClaim, 'saveHomeAccess');
  await requireKinfolkPerm(uid, kinfolkId, 'home_access', hasAdminClaim, 'saveHomeAccess');

  const update: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
    updatedByUid: uid,
  };
  if (args.gateCode !== undefined) update['gateCode'] = args.gateCode;
  if (args.keyLocation !== undefined) update['keyLocation'] = args.keyLocation;
  if (args.wifiPassword !== undefined) update['wifiPassword'] = args.wifiPassword;
  if (args.customFields !== undefined) update['customFields'] = args.customFields;

  await firestore.doc(`families/${kinfolkId}/homeAccess/current`).set(update, { merge: true });
  logEvent({ severity: 'info', function: 'saveHomeAccess', event: 'portal.homeAccess.saved', uid, extra: { kinfolkId, fields: Object.keys(update) } });
  return { ok: true };
}

export const saveHomeAccess = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('saveHomeAccess', saveHomeAccessHandler),
);
