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
import { hasKinfolkPerm } from '../lib/memberGate';

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

  // The caller's real role, for the audit trail. A missing member doc is a
  // legacy primary, the same reading memberGate gives it.
  let actorRole: 'AUNTIE' | 'PRIMARY' | 'SECONDARY' = 'AUNTIE';
  if (!isOperator) {
    const memberSnap = await firestore.doc(`families/${kinfolkId}/members/${uid}`).get();
    const role = memberSnap.exists ? (memberSnap.data() as { role?: string }).role : undefined;
    actorRole = role === 'SECONDARY' ? 'SECONDARY' : 'PRIMARY';
  }

  // #843: the Emergency Contact is a home detail. saveHomeAccess gates the gate
  // code and Wi-Fi on `home_access`, and this callable used to let any member
  // of the household overwrite the Emergency Contact beside them. Only a CHANGE
  // is refused: the portal re-sends the stored values on every save, so a
  // secondary without the permission can still save the rest of the profile.
  if (args.customFields !== undefined && !isOperator) {
    const stored = await firestore.collection('families').doc(kinfolkId).get();
    const before = emergencyContactSnapshot((stored.data() ?? {})['customFields']);
    const after = emergencyContactSnapshot(args.customFields);
    if (before !== after) {
      const allowed = await hasKinfolkPerm(uid, kinfolkId, 'home_access', req.auth?.token?.admin === true, 'saveTribeProfile');
      if (!allowed) {
        logEvent({ severity: 'warn', function: 'saveTribeProfile', event: 'portal.tribe.emergency_contact.denied', uid, extra: { kinfolkId } });
        throw new HttpsError('permission-denied', 'Only someone with Home access can change the Emergency Contact.');
      }
    }
  }

  const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (args.displayName !== undefined) update['displayName'] = args.displayName;
  if (args.customFields !== undefined) update['customFields'] = args.customFields;
  if (Object.keys(update).length === 1) {
    return { ok: true }; // only timestamp would be written; skip
  }

  await firestore.collection('families').doc(kinfolkId).set(update, { merge: true });
  logEvent({ severity: 'info', function: 'saveTribeProfile', event: 'portal.tribe.saved', uid, extra: { kinfolkId, fields: Object.keys(update) } });
  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.PROFILE_UPDATED,
    severity: 'info',
    // An operator writing on the household's behalf is AUNTIE, never falsely
    // PRIMARY; a secondary is SECONDARY, never falsely the primary (#843).
    actorRole,
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

const EMERGENCY_CONTACT_KEYS = ['emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation'] as const;

/** The three Emergency Contact values as one comparable string; absent reads as empty. */
function emergencyContactSnapshot(fields: unknown): string {
  const list = Array.isArray(fields) ? fields : [];
  const valueOf = (key: string): string => {
    const hit = list.find((f) => typeof f === 'object' && f !== null && (f as { key?: unknown }).key === key) as
      | { value?: unknown }
      | undefined;
    return typeof hit?.value === 'string' ? hit.value.trim() : '';
  };
  return JSON.stringify(EMERGENCY_CONTACT_KEYS.map(valueOf));
}

export const saveTribeProfile = onCall(
  // AUNTIE_OPERATOR_UIDS is required because resolveKinfolkAccess -> isStaff
  // reads it. Binding it is not optional: without it the allowlist arm
  // silently evaluates false and an operator not yet holding the admin claim
  // gets permission-denied with no indication why.
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('saveTribeProfile', saveTribeProfileHandler),
);
