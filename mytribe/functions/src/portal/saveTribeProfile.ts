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

  // The caller's real role, for the audit trail. A missing member doc is a
  // legacy primary, the same reading memberGate gives it.
  let actorRole: 'AUNTIE' | 'PRIMARY' | 'SECONDARY' = 'AUNTIE';
  if (!isOperator) {
    const memberSnap = await firestore.doc(`families/${kinfolkId}/members/${uid}`).get();
    const role = memberSnap.exists ? (memberSnap.data() as { role?: string }).role : undefined;
    actorRole = role === 'SECONDARY' ? 'SECONDARY' : 'PRIMARY';
  }

  // #829: Emergency Contacts live on the kinfolk record, written only by
  // saveEmergencyContacts (gated on `home_access` there). The
  // `emergencyContact*` rows in these customFields are a store nothing reads, so
  // this callable no longer judges them: it strips them from EVERY payload and
  // never writes a value a client sent. An old portal bundle or portal Android
  // still sends them; that save goes through with them removed.
  //
  // Why the #843 comparison is gone rather than taught to ignore absent keys:
  // once sent keys are stripped, nothing this callable writes can change an
  // Emergency Contact, so there is nothing left to gate. Keeping the comparison
  // would keep a permission check over a dead store, and it is what locked every
  // secondary without Home access out of profile saves once the new portal
  // stopped sending the keys.
  //
  // A STORED copy is carried through unchanged instead of being dropped, because
  // `customFields` is replaced whole and a profile save must not destroy the
  // only copy before the migration (scripts/backfillKinfolkEmergencyContacts.ts)
  // moves it onto the kinfolk record and deletes it.
  let customFields = args.customFields;
  if (customFields !== undefined) {
    const sentStale = customFields.filter((f) => isEmergencyContactKey(f.key)).length;
    const stored = await firestore.collection('families').doc(kinfolkId).get();
    const carried = storedEmergencyContactRows((stored.data() ?? {})['customFields']);
    customFields = [...customFields.filter((f) => !isEmergencyContactKey(f.key)), ...carried];
    if (sentStale > 0) {
      logEvent({ severity: 'info', function: 'saveTribeProfile', event: 'portal.tribe.emergency_contact_keys.stripped', uid, extra: { kinfolkId, stripped: sentStale } });
    }
  }

  const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (args.displayName !== undefined) update['displayName'] = args.displayName;
  if (customFields !== undefined) update['customFields'] = customFields;
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

const EMERGENCY_CONTACT_KEYS: ReadonlySet<string> = new Set(['emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation']);

function isEmergencyContactKey(key: string): boolean {
  return EMERGENCY_CONTACT_KEYS.has(key);
}

/** The stored emergencyContact* rows, exactly as stored, for carrying through a save. */
function storedEmergencyContactRows(fields: unknown): Array<z.infer<typeof CustomFieldZ>> {
  const list = Array.isArray(fields) ? fields : [];
  return list.filter(
    (f): f is z.infer<typeof CustomFieldZ> =>
      typeof f === 'object' &&
      f !== null &&
      typeof (f as { key?: unknown }).key === 'string' &&
      isEmergencyContactKey((f as { key: string }).key) &&
      typeof (f as { label?: unknown }).label === 'string' &&
      typeof (f as { value?: unknown }).value === 'string',
  );
}

export const saveTribeProfile = onCall(
  // AUNTIE_OPERATOR_UIDS is required because resolveKinfolkAccess -> isStaff
  // reads it. Binding it is not optional: without it the allowlist arm
  // silently evaluates false and an operator not yet holding the admin claim
  // gets permission-denied with no indication why.
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('saveTribeProfile', saveTribeProfileHandler),
);
