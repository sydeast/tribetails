import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';

const CustomFieldZ = z.object({
  key: z.string().min(1).max(80),
  label: z.string().min(1).max(80),
  value: z.string().max(1000),
});

const Args = z.object({
  kinfolkId: z.string().optional(),
  displayName: z.string().min(1).max(120).optional(),
  customFields: z.array(CustomFieldZ).max(40).optional(),
});

/**
 * Updates `families/{kinfolkId}` doc with displayName and/or customFields.
 * Additive, only writes fields the caller passed.
 *
 * Safety: `families` is MyTribe-owned. AuntieOS reads this doc but does not
 * own writes. Updates are scoped to the caller's allowed kinfolkIds.
 */
export async function saveTribeProfileHandler(req: CallableRequest<unknown>): Promise<{ ok: true }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const args = Args.parse(req.data);
  const firestore = db();
  const clientSnap = await firestore.collection('clients').doc(uid).get();
  const allowedIds: string[] = (clientSnap.data()?.kinfolkIds ?? []) as string[];
  if (allowedIds.length === 0) throw new HttpsError('failed-precondition', 'No tribes linked.');
  const kinfolkId = args.kinfolkId ?? allowedIds[0];
  if (!allowedIds.includes(kinfolkId)) throw new HttpsError('permission-denied', 'No access.');

  const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (args.displayName !== undefined) update['displayName'] = args.displayName;
  if (args.customFields !== undefined) update['customFields'] = args.customFields;
  if (Object.keys(update).length === 1) {
    return { ok: true }; // only timestamp would be written; skip
  }

  await firestore.collection('families').doc(kinfolkId).set(update, { merge: true });
  logEvent({ severity: 'info', function: 'saveTribeProfile', event: 'portal.tribe.saved', uid, extra: { kinfolkId, fields: Object.keys(update) } });
  await writeAuditEntry({
    event: AUDIT_EVENTS.PROFILE_UPDATED,
    severity: 'info',
    actorRole: 'PRIMARY',
    actorUid: uid,
    targetUid: kinfolkId,
    targetCollection: 'families',
    description: `Tribe profile updated: ${Object.keys(update).filter((k) => k !== 'updatedAt').join(', ')}`,
    payload: { kinfolkId, fields: Object.keys(update).filter((k) => k !== 'updatedAt') },
  }).catch((err) => {
    logEvent({
      severity: 'warn', function: 'saveTribeProfile', event: 'audit.write.failed',
      uid, errorMessage: (err as Error)?.message,
    });
  });
  return { ok: true };
}

export const saveTribeProfile = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapCallable('saveTribeProfile', saveTribeProfileHandler),
);
