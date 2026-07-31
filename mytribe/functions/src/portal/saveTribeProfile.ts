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
import { resolveKinfolkAccess } from '../lib/resolveKinfolkAccess';

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
  // Was a hard clients/{uid}.kinfolkIds check with no staff path: an operator
  // impersonating a household loaded it fine (reads already went through
  // resolveKinfolkAccess) and got permission-denied here on save. Same
  // resolver the read side (getMyKin, etc.) uses, so an operator on either
  // the admin claim or the AUNTIE_OPERATOR_UIDS allowlist gets through, and a
  // cross-tenant resolution is audit-logged inside the resolver itself.
  const { kinfolkId, isOperator } = await resolveKinfolkAccess(
    uid,
    args.kinfolkId,
    req.auth?.token?.admin === true,
    'saveTribeProfile',
  );

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
    // Matches the AUNTIE/PRIMARY split requestBooking already draws: a
    // kinfolk PRIMARY writes their own profile, an operator writes on the
    // household's behalf and is labeled AUNTIE, never falsely as PRIMARY.
    actorRole: isOperator ? 'AUNTIE' : 'PRIMARY',
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
  // AUNTIE_OPERATOR_UIDS is required because resolveKinfolkAccess -> isStaff
  // reads it. Binding it is not optional: without it the allowlist arm
  // silently evaluates false and an operator not yet holding the admin claim
  // gets permission-denied with no indication why.
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('saveTribeProfile', saveTribeProfileHandler),
);
