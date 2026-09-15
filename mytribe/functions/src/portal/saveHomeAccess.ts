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
import { LEGACY_EMERGENCY_CONTACT_KEYS } from '../lib/emergencyContacts';
import {
  conflictingCustomFieldKeys,
  CustomFieldsZ,
  hasKeyIn,
  mergeCustomFieldsForSave,
  RemoveCustomFieldKeysZ,
} from '../lib/customFieldsMerge';

const Args = z.object({
  kinfolkId: z.string().optional(),
  gateCode: z.string().max(80).nullable().optional(),
  keyLocation: z.string().max(500).nullable().optional(),
  wifiPassword: z.string().max(200).nullable().optional(),
  /** #873 review: sized to what can be stored, not 40. See CUSTOM_FIELDS_MAX_ROWS. */
  customFields: CustomFieldsZ.optional(),
  /** #873: the only way to delete a stored row. */
  removeCustomFieldKeys: RemoveCustomFieldKeysZ.optional(),
});

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
  const { kinfolkId } = await resolveKinfolkAccess(uid, args.kinfolkId, hasAdminClaim, 'saveHomeAccess');
  await requireKinfolkPerm(uid, kinfolkId, 'home_access', hasAdminClaim, 'saveHomeAccess');

  const update: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
    updatedByUid: uid,
  };
  if (args.gateCode !== undefined) update['gateCode'] = args.gateCode;
  if (args.keyLocation !== undefined) update['keyLocation'] = args.keyLocation;
  if (args.wifiPassword !== undefined) update['wifiPassword'] = args.wifiPassword;
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
  if (args.customFields !== undefined || args.removeCustomFieldKeys !== undefined) {
    // #873 review: read, merge and write in one transaction. Two devices saving
    // at once used to read the same list, and the second write dropped the rows
    // the first had added. Firestore now retries the loser against the winner's
    // list. Nothing with a side effect runs in here, because it can run twice.
    const sent = (args.customFields ?? []).filter((f) => !LEGACY_EMERGENCY_CONTACT_KEYS.has(f.key));
    const removeKeys = args.removeCustomFieldKeys ?? [];
    await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const merged = mergeCustomFieldsForSave((snap.data() ?? {})['customFields'], sent, removeKeys);
      tx.set(ref, { ...update, customFields: merged.filter((entry) => !hasKeyIn(entry, LEGACY_EMERGENCY_CONTACT_KEYS)) }, { merge: true });
    });
    update['customFields'] = true;
  } else {
    await ref.set(update, { merge: true });
  }

  logEvent({ severity: 'info', function: 'saveHomeAccess', event: 'portal.homeAccess.saved', uid, extra: { kinfolkId, fields: Object.keys(update) } });
  return { ok: true };
}

export const saveHomeAccess = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('saveHomeAccess', saveHomeAccessHandler),
);
