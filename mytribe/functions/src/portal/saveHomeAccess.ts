import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { requireKinfolkPerm } from '../lib/memberGate';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { RATE_LIMITED_MESSAGE, readRateLimitInTx } from '../lib/rateLimit';
import { TRIBETAILS_CORS } from '../lib/cors';
import { resolveKinfolkAccess } from '../lib/resolveKinfolkAccess';
import { LEGACY_EMERGENCY_CONTACT_KEYS } from '../lib/emergencyContacts';
import {
  conflictingCustomFieldKeys,
  CustomFieldsZ,
  hasKeyIn,
  mergeCustomFieldsForSave,
  PROFILE_SAVE_RATE_LIMIT,
  RemoveCustomFieldKeysZ,
  sameAsStored,
} from '../lib/customFieldsMerge';

const Args = z.object({
  kinfolkId: z.string().optional(),
  gateCode: z.string().max(80).nullable().optional(),
  keyLocation: z.string().max(500).nullable().optional(),
  wifiPassword: z.string().max(200).nullable().optional(),
  /** #873 final review: a transport guard only. What a save may change is capped inside the transaction. */
  customFields: CustomFieldsZ.optional(),
  /** #873: the only way to delete a stored row. */
  removeCustomFieldKeys: RemoveCustomFieldKeysZ.optional(),
});

const SCALAR_FIELDS = ['gateCode', 'keyLocation', 'wifiPassword'] as const;

/** #868: what a member without Home access is told when this callable refuses. */
export const HOME_ACCESS_REQUIRED_MESSAGE =
  'You need Home access to change the home details. Ask your primary kinfolk to give you Home access.';

/**
 * Writes `families/{kinfolkId}/homeAccess/current`.
 * MyTribe-owned subcollection. AuntieOS reads via her own client; we send
 * a notification ping so she knows fields changed (Phase 2C wires the FCM ping).
 *
 * #873: `customFields` merges by key into the stored list (lib/customFieldsMerge.ts).
 * A row the client did not send is kept; only `removeCustomFieldKeys` deletes.
 */
export async function saveHomeAccessHandler(req: CallableRequest<unknown>): Promise<{ ok: true }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const args = Args.parse(req.data);
  const conflicts = conflictingCustomFieldKeys(args.customFields, args.removeCustomFieldKeys);
  if (conflicts.length > 0) {
    throw new HttpsError('invalid-argument', `A custom field cannot be both saved and removed: ${conflicts.join(', ')}.`);
  }
  const firestore = db();
  const hasAdminClaim = req.auth?.token?.admin === true;
  // Was a hard clients/{uid}.kinfolkIds check with no staff path, so an
  // operator got permission-denied here even though requireKinfolkPerm below
  // (and the read side) already knew how to let staff through. Same resolver
  // getMyKin/getMyBookings use; a cross-tenant resolution is audit-logged
  // inside it.
  const { kinfolkId, isOperator } = await resolveKinfolkAccess(uid, args.kinfolkId, hasAdminClaim, 'saveHomeAccess');
  // #868: the shared gate refuses with the bare message 'permission-denied'.
  // Portal Android before #868 prints the message after "Save failed:", so a
  // secondary without Home access read "Save failed: permission-denied". Say
  // what is missing and who can grant it. Nothing has been read or written yet.
  try {
    await requireKinfolkPerm(uid, kinfolkId, 'home_access', hasAdminClaim, 'saveHomeAccess');
  } catch (err) {
    if (err instanceof HttpsError && err.code === 'permission-denied') {
      throw new HttpsError('permission-denied', HOME_ACCESS_REQUIRED_MESSAGE);
    }
    throw err;
  }

  const update: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
    updatedByUid: uid,
  };
  for (const field of SCALAR_FIELDS) {
    if (args[field] !== undefined) update[field] = args[field];
  }
  // #829 review: the emergencyContact* rows never ride along, the same strip
  // saveTribeProfile does. Emergency Contacts are written only by
  // saveEmergencyContacts, and a stale copy here would be a second store nobody
  // validates. A STORED copy is dropped too, as it was when the list was
  // replaced whole: nothing reads it, and the #829 migration reads the families
  // copy, never this one.
  //
  // #873: merged by key, never replaced. An old client that rebuilt the list
  // from the schema keys no longer deletes the rows it did not send.
  const ref = firestore.doc(`families/${kinfolkId}/homeAccess/current`);
  const touchesCustomFields = args.customFields !== undefined || args.removeCustomFieldKeys !== undefined;
  const sent = (args.customFields ?? []).filter((f) => !LEGACY_EMERGENCY_CONTACT_KEYS.has(f.key));
  const removeKeys = args.removeCustomFieldKeys ?? [];
  // #873 review: read, merge and write in one transaction. Two devices saving
  // at once used to read the same list, and the second write dropped the rows
  // the first had added. Firestore now retries the loser against the winner's
  // list. Nothing with a side effect runs in here, because it can run twice.
  //
  // #873 final review: the rate limit (60 saves an hour per household, in this
  // callable's own bucket; PROFILE_SAVE_RATE_LIMIT says why) is read and counted
  // in the same transaction, so only a save that commits a change counts. A save
  // that changes nothing writes nothing: no updatedAt or updatedByUid bump, no
  // count.
  //
  // #901: the callback returns the NAMES of the fields it changed, not just a
  // flag, so the audit entry below says which of the home details moved. It is
  // pure (a comparison of what was read with what was sent), so a retry
  // recomputes it against the winning read rather than carrying a stale list.
  const changed = await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const stored = (snap.data() ?? {}) as Record<string, unknown>;
    const limit = await readRateLimitInTx(tx, 'homeAccessSave', kinfolkId, PROFILE_SAVE_RATE_LIMIT.max, PROFILE_SAVE_RATE_LIMIT.windowSecs);
    const customFields = touchesCustomFields
      ? mergeCustomFieldsForSave(stored['customFields'], sent, removeKeys).filter((entry) => !hasKeyIn(entry, LEGACY_EMERGENCY_CONTACT_KEYS))
      : null;
    const changes: string[] = SCALAR_FIELDS.filter(
      (field) => args[field] !== undefined && (args[field] ?? null) !== (stored[field] ?? null),
    );
    if (customFields !== null && !sameAsStored(customFields, stored['customFields'])) changes.push('customFields');
    if (changes.length === 0) return null;
    if (!limit.allowed) throw new HttpsError('resource-exhausted', RATE_LIMITED_MESSAGE);
    tx.set(ref, customFields !== null ? { ...update, customFields } : update, { merge: true });
    limit.record();
    return changes;
  });

  if (changed === null) {
    logEvent({ severity: 'info', function: 'saveHomeAccess', event: 'portal.homeAccess.unchanged', uid, extra: { kinfolkId } });
    return { ok: true };
  }
  logEvent({ severity: 'info', function: 'saveHomeAccess', event: 'portal.homeAccess.saved', uid, extra: { kinfolkId, fields: changed } });

  // #901: this callable wrote no audit entry at all, while saveTribeProfile has
  // written one since #843. The fields behind it are the most sensitive a
  // household holds - the gate code, where the key is hidden, the Wi-Fi password
  // - so "who changed the gate code, and when" had no answer anywhere.
  //
  // FIELD NAMES ONLY, NEVER VALUES. Nothing on this path may carry a gate code,
  // a key location, a Wi-Fi password or a custom row's value into `activity_log`:
  // the audit trail is read by every operator and admin surface, and a secret
  // copied into it is a second store of that secret with a different, weaker
  // reader set. `changed` holds field names, and `customFields` is one name for
  // the whole list - not its rows, whose keys would say which sensitive row moved
  // but whose presence would invite a value to be added beside them later.
  //
  // The caller's real role, the same reading saveTribeProfile takes: a missing
  // member doc is a legacy primary, and an operator saving on the household's
  // behalf is AUNTIE rather than falsely PRIMARY. Read only once a save has
  // committed, so a no-op costs nothing.
  let actorRole: 'AUNTIE' | 'PRIMARY' | 'SECONDARY' = 'AUNTIE';
  if (!isOperator) {
    const memberSnap = await firestore.doc(`families/${kinfolkId}/members/${uid}`).get();
    const role = memberSnap.exists ? (memberSnap.data() as { role?: string }).role : undefined;
    actorRole = role === 'SECONDARY' ? 'SECONDARY' : 'PRIMARY';
  }
  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.HOME_ACCESS_UPDATED,
    severity: 'info',
    actorRole,
    actorUid: uid,
    targetUid: kinfolkId,
    targetCollection: 'families',
    description: `Home access updated: ${changed.join(', ')}`,
    payload: { kinfolkId, fields: changed, targets: [{ collection: 'families', id: kinfolkId, doc: 'homeAccess/current' }] },
  }).catch((err) => {
    // The save has already committed. A failed audit write must not turn a
    // landed save into an error the household is told to retry.
    logEvent({
      severity: 'warn', function: 'saveHomeAccess', event: 'audit.write.failed',
      uid, errorMessage: (err as Error)?.message,
    });
  });
  return { ok: true };
}

export const saveHomeAccess = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('saveHomeAccess', saveHomeAccessHandler),
);
