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
import { comparablePhone, normaliseName, readStoredEmergencyContacts } from '../lib/emergencyContacts';
import { parseEmergencyContactsInput, prepareEmergencyContactsSave } from './emergencyContacts';

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
 *
 * `emergencyContactIgnored: true` in the reply means an old client sent an
 * Emergency Contact edit the caller has no Home access to make (#829). New
 * clients never send one and can ignore the field.
 */
export async function saveTribeProfileHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; emergencyContactIgnored?: true }> {
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

  // #829: Emergency Contacts live on the kinfolk record. The `emergencyContact*`
  // rows in these customFields are a store nothing reads, so they are stripped
  // from EVERY payload and a sent value never lands in customFields.
  //
  // Why the #843 comparison is gone rather than taught to ignore absent keys: it
  // compared the dead store with the payload, read a missing key as "cleared",
  // and locked every secondary without Home access out of profile saves once the
  // new portal stopped sending the keys.
  //
  // A STORED copy is carried through unchanged instead of being dropped, because
  // `customFields` is replaced whole and a profile save must not destroy the
  // only copy before the migration (scripts/backfillKinfolkEmergencyContacts.ts)
  // moves it onto the kinfolk record and deletes it. (Operator: agreed.)
  //
  // OLD CLIENTS. Portal Android on an old install and cached portal web bundles
  // still edit the contact as these rows, and their edit must reach the real
  // store or fail visibly, never vanish under "Saved." (operator ruling):
  //   - an echo is a no-op: the values match the families copy the client
  //     loaded, or match kinfolk slot 1. Matching the families copy matters,
  //     because an old client re-sends what it loaded on every save, and that
  //     stale copy must not overwrite a newer contact the office entered;
  //   - with Home access the edit replaces slot 1, keeps slot 2, and goes
  //     through saveEmergencyContacts' own parser and rules, so a refusal fails
  //     this whole call with the message a new client would show;
  //   - without Home access nothing is written to the contact and the reply
  //     carries emergencyContactIgnored.
  const isAdmin = req.auth?.token?.admin === true;
  let customFields = args.customFields;
  let emergencyContactWrite: Awaited<ReturnType<typeof prepareEmergencyContactsSave>> | null = null;
  let emergencyContactIgnored = false;
  if (customFields !== undefined) {
    const sentRows = customFields.filter((f) => isEmergencyContactKey(f.key));
    const stored = await firestore.collection('families').doc(kinfolkId).get();
    const carried = storedEmergencyContactRows((stored.data() ?? {})['customFields']);
    customFields = [...customFields.filter((f) => !isEmergencyContactKey(f.key)), ...carried];

    const sent = contactFromRows(sentRows);
    if (sent !== null) {
      let outcome: 'echo' | 'applied' | 'ignored' = 'echo';
      const kinSnap = await firestore.doc(`kinfolk/${kinfolkId}`).get();
      const current = readStoredEmergencyContacts((kinSnap.data() ?? {}) as Record<string, unknown>).contacts;
      const loaded = contactFromRows(carried);
      const slot1 = current[0];
      const isEcho = (loaded !== null && sameContact(sent, loaded)) || (slot1 !== undefined && sameContact(sent, slot1));
      if (!isEcho) {
        if (await hasKinfolkPerm(uid, kinfolkId, 'home_access', isAdmin, 'saveTribeProfile')) {
          // Validated before anything is written; a refusal throws out of this call.
          const contacts = parseEmergencyContactsInput([
            sent,
            ...current.slice(1).map((c) => ({ name: c.name, phone: c.phone, relationship: c.relationship })),
          ]);
          emergencyContactWrite = await prepareEmergencyContactsSave(firestore, kinfolkId, contacts);
          outcome = 'applied';
        } else {
          emergencyContactIgnored = true;
          outcome = 'ignored';
        }
      }
      logEvent({
        severity: outcome === 'ignored' ? 'warn' : 'info',
        function: 'saveTribeProfile',
        event: 'portal.tribe.emergency_contact_keys.stripped',
        uid,
        extra: { kinfolkId, stripped: sentRows.length, outcome },
      });
    }
  }

  const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (args.displayName !== undefined) update['displayName'] = args.displayName;
  if (customFields !== undefined) update['customFields'] = customFields;
  if (Object.keys(update).length === 1 && emergencyContactWrite === null) {
    return { ok: true }; // only timestamp would be written; skip
  }

  const familiesRef = firestore.collection('families').doc(kinfolkId);
  if (emergencyContactWrite !== null) {
    // One batch, so the contact and the rest of the profile land together or not at all.
    const batch = firestore.batch();
    batch.update(emergencyContactWrite.ref, { emergencyContacts: emergencyContactWrite.merged, updatedAt: FieldValue.serverTimestamp() });
    batch.set(familiesRef, update, { merge: true });
    await batch.commit();
  } else {
    await familiesRef.set(update, { merge: true });
  }
  const fields = [...Object.keys(update).filter((k) => k !== 'updatedAt'), ...(emergencyContactWrite !== null ? ['emergencyContacts'] : [])];
  logEvent({ severity: 'info', function: 'saveTribeProfile', event: 'portal.tribe.saved', uid, extra: { kinfolkId, fields } });
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
    description: `Tribe profile updated: ${fields.join(', ')}`,
    payload: { kinfolkId, fields },
  }).catch((err) => {
    logEvent({
      severity: 'warn', function: 'saveTribeProfile', event: 'audit.write.failed',
      uid, errorMessage: (err as Error)?.message,
    });
  });
  return emergencyContactIgnored ? { ok: true, emergencyContactIgnored: true } : { ok: true };
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

interface OldClientContact {
  name: string;
  phone: string;
  relationship: string | null;
}

/** The one contact an old client's emergencyContact* rows describe; null when there are no such rows. */
function contactFromRows(rows: Array<{ key: string; value: string }>): OldClientContact | null {
  const hits = rows.filter((r) => isEmergencyContactKey(r.key));
  if (hits.length === 0) return null;
  const valueOf = (key: string) => (hits.find((r) => r.key === key)?.value ?? '').trim();
  const relationship = valueOf('emergencyContactRelation');
  return { name: valueOf('emergencyContactName'), phone: valueOf('emergencyContactPhone'), relationship: relationship === '' ? null : relationship };
}

/** Same person, same number: name ignoring case and spacing, phone in any spelling, relationship trimmed. */
function sameContact(a: OldClientContact, b: OldClientContact): boolean {
  return (
    normaliseName(a.name) === normaliseName(b.name) &&
    comparablePhone(a.phone) === comparablePhone(b.phone) &&
    (a.relationship ?? '').trim() === (b.relationship ?? '').trim()
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
