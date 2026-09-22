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
import { RATE_LIMITED_MESSAGE, readRateLimitInTx } from '../lib/rateLimit';
import {
  LEGACY_EMERGENCY_CONTACT_KEYS,
  legacyContactFromRows,
  legacyServedKey,
  readStoredEmergencyContacts,
  sameLegacyContact,
} from '../lib/emergencyContacts';
import { parseEmergencyContactsInput, prepareEmergencyContactsSave, readLegacyServedKeys } from './emergencyContacts';
import {
  conflictingCustomFieldKeys,
  CustomFieldsZ,
  mergeCustomFieldsForSave,
  PROFILE_SAVE_RATE_LIMIT,
  RemoveCustomFieldKeysZ,
  sameAsStored,
  type CustomFieldRow,
} from '../lib/customFieldsMerge';

const Args = z.object({
  kinfolkId: z.string().optional(),
  displayName: z.string().min(1).max(120).optional(),
  /** #873 final review: a transport guard only. What a save may change is capped inside the transaction. */
  customFields: CustomFieldsZ.optional(),
  /** #873: the only way to delete a stored row. Emergency Contact keys are ignored here. */
  removeCustomFieldKeys: RemoveCustomFieldKeysZ.optional(),
});

/**
 * Updates `families/{kinfolkId}` doc with displayName and/or customFields.
 * Additive, only writes fields the caller passed.
 *
 * #873: `customFields` merges by key into the stored list (lib/customFieldsMerge.ts).
 * A row the client did not send is kept; only `removeCustomFieldKeys` deletes.
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
  const conflicts = conflictingCustomFieldKeys(args.customFields, args.removeCustomFieldKeys);
  if (conflicts.length > 0) {
    throw new HttpsError('invalid-argument', `A custom field cannot be both saved and removed: ${conflicts.join(', ')}.`);
  }
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
  // a profile save must not destroy the only copy before the migration
  // (scripts/backfillKinfolkEmergencyContacts.ts) moves it onto the kinfolk
  // record and deletes it. (Operator: agreed.) Since #873 the list merges by
  // key, so an unsent stored row is kept in place, and `removeCustomFieldKeys`
  // cannot name one of these keys either.
  //
  // OLD CLIENTS. Portal Android on an old install and cached portal web bundles
  // still edit the contact as these rows, and their edit must reach the real
  // store or fail visibly, never vanish under "Saved." (operator ruling):
  //   - an echo is a no-op: the values match a contact getMyTribeProfile served
  //     this caller (the server-only record in portal/emergencyContacts.ts), the
  //     families copy, or kinfolk slot 1. The served record is what catches an
  //     untouched save of something loaded before the office changed slot 1,
  //     which matches neither of the other two and must not overwrite it;
  //   - with Home access the edit replaces slot 1, keeps slot 2, and goes
  //     through saveEmergencyContacts' own parser and rules, so a refusal fails
  //     this whole call with the message a new client would show;
  //   - without Home access nothing is written to the contact and the reply
  //     carries emergencyContactIgnored.
  const isAdmin = req.auth?.token?.admin === true;
  const familiesRef = firestore.collection('families').doc(kinfolkId);
  const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (args.displayName !== undefined) update['displayName'] = args.displayName;
  const touchesCustomFields = args.customFields !== undefined || args.removeCustomFieldKeys !== undefined;
  if (!touchesCustomFields && args.displayName === undefined) {
    return { ok: true }; // nothing sent to write; spend no save
  }

  let stripped: { count: number; outcome: 'echo' | 'applied' | 'ignored' } | null = null;
  const sentFields = args.customFields ?? [];
  const sentRows = sentFields.filter((f) => isEmergencyContactKey(f.key));
  const sent = legacyContactFromRows(sentRows);
  const removeKeys = (args.removeCustomFieldKeys ?? []).filter((k) => !isEmergencyContactKey(k));
  // #873 second review: Home access is checked ONCE, before the transaction.
  // Inside it, the check was a plain read the transaction did not lock, and a
  // retry ran it again (and isStaff logged its allowlist fallback twice). A
  // permission change racing a save is not a risk worth a transactional read:
  // the gate is the same one saveEmergencyContacts applies without one. Only an
  // old client that sent contact rows pays for the read.
  const canEditContacts = sent !== null && (await hasKinfolkPerm(uid, kinfolkId, 'home_access', isAdmin, 'saveTribeProfile'));
  // #873 review: the families read, the Emergency Contact reads, and both
  // writes are one transaction. Two devices saving at once used to read the
  // same list, and the second write dropped the rows the first had added.
  // Firestore now retries the loser against the winner's list. Every read comes
  // before the first write, and nothing with a side effect (a log line, the
  // audit entry) runs in here, because the callback can run more than once.
  //
  // #873 final review: the rate limit (60 saves an hour per household, in this
  // callable's own bucket; PROFILE_SAVE_RATE_LIMIT says why) is read and counted
  // in the SAME transaction, so it counts only a save that commits a change. A
  // refused save throws before any write, and a save that changes nothing
  // writes nothing, counter included.
  const result = await firestore.runTransaction(async (tx) => {
    const stored = await tx.get(familiesRef);
    const storedData = (stored.data() ?? {}) as Record<string, unknown>;
    const storedFields = storedData['customFields'];
    const limit = await readRateLimitInTx(tx, 'profileSave', kinfolkId, PROFILE_SAVE_RATE_LIMIT.max, PROFILE_SAVE_RATE_LIMIT.windowSecs);
    {
      // #873: merged by key. Sent Emergency Contact rows never land, and stored
      // ones are unsent and so kept where they are. Refusals throw from here,
      // before anything is written.
      const customFields = touchesCustomFields
        ? mergeCustomFieldsForSave(storedFields, sentFields.filter((f) => !isEmergencyContactKey(f.key)), removeKeys)
        : null;

      // Sent none (sent === null). Either an old client cleared every contact
      // field, or a new client (which never sends these rows) saved the profile;
      // the rows alone cannot tell them apart. The contact stays as it is in both
      // cases, because a household needs at least one and clearing it goes through
      // saveEmergencyContacts' own rules. The rest of the profile saves. Nothing is
      // logged: it would fire on every new-client save and say nothing.
      let outcome: 'echo' | 'applied' | 'ignored' | null = null;
      let ecWrite: Awaited<ReturnType<typeof prepareEmergencyContactsSave>> | null = null;
      if (sent !== null) {
        outcome = 'echo';
        const servedKeys = await readLegacyServedKeys(firestore, kinfolkId, uid, tx);
        const kinSnap = await tx.get(firestore.doc(`kinfolk/${kinfolkId}`));
        const current = readStoredEmergencyContacts((kinSnap.data() ?? {}) as Record<string, unknown>).contacts;
        const loaded = legacyContactFromRows(storedEmergencyContactRows(storedFields));
        const slot1 = current[0];
        const isEcho =
          servedKeys.includes(legacyServedKey(sent)) ||
          (loaded !== null && sameLegacyContact(sent, loaded)) ||
          (slot1 !== undefined && sameLegacyContact(sent, slot1));
        if (!isEcho) {
          if (canEditContacts) {
            // Validated before anything is written; a refusal throws out of this call.
            // Only the slot being written is parsed. A stored slot 2 is carried
            // through as stored: one that no longer parses (a hand-typed phone the
            // migration carried) must not block a slot 1 edit. Both slots still go
            // through the outside-the-household and different-phone checks.
            const [slot1Input] = parseEmergencyContactsInput([sent]);
            if (slot1Input === undefined) throw new HttpsError('invalid-argument', 'Invalid arguments.');
            const contacts = [
              slot1Input,
              ...current.slice(1).map((c) => ({ name: c.name, phone: c.phone, relationship: c.relationship })),
            ];
            ecWrite = await prepareEmergencyContactsSave(firestore, kinfolkId, contacts, tx);
            outcome = 'applied';
          } else {
            outcome = 'ignored';
          }
        }
      }

      // #873 final review: a save that changes nothing writes nothing (no
      // updatedAt bump) and spends no save. Real clients always send displayName
      // and customFields, so this, not the check above, is the no-op skip.
      const changes =
        (args.displayName !== undefined && args.displayName !== storedData['displayName']) ||
        (customFields !== null && !sameAsStored(customFields, storedFields)) ||
        ecWrite !== null;
      if (!changes) return { ecWrite, outcome, wrote: false };
      if (!limit.allowed) throw new HttpsError('resource-exhausted', RATE_LIMITED_MESSAGE);

      // Writes. The contact, the rest of the profile and the save count land together or not at all.
      if (ecWrite !== null) {
        tx.update(ecWrite.ref, { emergencyContacts: ecWrite.merged, updatedAt: FieldValue.serverTimestamp() });
      }
      tx.set(familiesRef, customFields !== null ? { ...update, customFields } : update, { merge: true });
      limit.record();
      return { ecWrite, outcome, wrote: true };
    }
  });
  if (touchesCustomFields) update['customFields'] = true;
  const emergencyContactWrite = result.ecWrite;
  const emergencyContactIgnored = result.outcome === 'ignored';
  if (result.outcome !== null) stripped = { count: sentRows.length, outcome: result.outcome };

  if (stripped !== null) {
    logEvent({
      severity: stripped.outcome === 'ignored' ? 'warn' : 'info',
      function: 'saveTribeProfile',
      event: 'portal.tribe.emergency_contact_keys.stripped',
      uid,
      extra: { kinfolkId, stripped: stripped.count, outcome: stripped.outcome },
    });
  }
  if (!result.wrote) {
    // Nothing changed, so nothing was written and no audit entry is due.
    logEvent({ severity: 'info', function: 'saveTribeProfile', event: 'portal.tribe.save.unchanged', uid, extra: { kinfolkId } });
    return emergencyContactIgnored ? { ok: true, emergencyContactIgnored: true } : { ok: true };
  }
  const fields = [...Object.keys(update).filter((k) => k !== 'updatedAt'), ...(emergencyContactWrite !== null ? ['emergencyContacts'] : [])];
  logEvent({ severity: 'info', function: 'saveTribeProfile', event: 'portal.tribe.saved', uid, extra: { kinfolkId, fields } });
  if (emergencyContactWrite !== null) {
    // The same event saveEmergencyContacts logs for a save, so one query finds
    // every Emergency Contact write whichever client made it. No names or phones.
    logEvent({
      severity: 'info',
      function: 'saveTribeProfile',
      event: 'kinfolk.emergencyContacts.saved',
      uid,
      extra: { kinfolkId, count: emergencyContactWrite.merged.length },
    });
  }
  const targets = [
    { collection: 'families', id: kinfolkId },
    ...(emergencyContactWrite !== null ? [{ collection: 'kinfolk', id: kinfolkId }] : []),
  ];
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
    payload: { kinfolkId, fields, targets },
  }).catch((err) => {
    logEvent({
      severity: 'warn', function: 'saveTribeProfile', event: 'audit.write.failed',
      uid, errorMessage: (err as Error)?.message,
    });
  });
  return emergencyContactIgnored ? { ok: true, emergencyContactIgnored: true } : { ok: true };
}

function isEmergencyContactKey(key: string): boolean {
  return LEGACY_EMERGENCY_CONTACT_KEYS.has(key);
}

/** The stored emergencyContact* rows, exactly as stored, for carrying through a save. */
function storedEmergencyContactRows(fields: unknown): CustomFieldRow[] {
  const list = Array.isArray(fields) ? fields : [];
  return list.filter(
    (f): f is CustomFieldRow =>
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
