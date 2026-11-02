import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { householdStaffFlag } from '../lib/staffGate';
import { requireKinfolkPerm } from '../lib/memberGate';
import { TRIBETAILS_CORS } from '../lib/cors';
import { resolveKinfolkAccess } from '../lib/resolveKinfolkAccess';

/** Only http(s) URLs allowed, defends against javascript:, data:, file: payloads. */
const SafeUrl = z
  .string()
  .url()
  .refine((s) => /^https?:\/\//i.test(s), { message: 'photoUrl must be http or https' });

const KinPayload = z.object({
  name: z
    .string()
    .min(1)
    .max(80)
    .refine((s) => s.trim().length > 0, { message: 'name cannot be whitespace-only' }),
  species: z.string().max(40).nullable().optional(),
  breed: z.string().max(80).nullable().optional(),
  ageYears: z.number().nonnegative().nullable().optional(),
  photoUrl: SafeUrl.nullable().optional(),
  feedingInstructions: z.string().max(2000).nullable().optional(),
  walkingInstructions: z.string().max(2000).nullable().optional(),
  medications: z.string().max(2000).nullable().optional(),
  allergies: z.string().max(2000).nullable().optional(),
  emergencyNotes: z.string().max(2000).nullable().optional(),
  sitterNotes: z.string().max(2000).nullable().optional(),
  legacyKinId: z.string().max(40).nullable().optional(),
  // Descriptive fields the admin also persists on the pet (the AuntieOS `Kin`
  // model: sex, weight, colorMarkings, spayedNeutered, vetInfo). The household
  // owns them too (kinMirror.ts HOUSEHOLD_SHARED_FIELDS). They are NOT
  // nullable on purpose: the admin Android model declares them non-null
  // `String` / `Boolean`, and a null written here crashes its toObject()
  // decode. An empty string is how a household clears one.
  sex: z.string().max(40).optional(),
  weight: z.string().max(40).optional(),
  colorMarkings: z.string().max(200).optional(),
  spayedNeutered: z.boolean().optional(),
  vetInfo: z.string().max(2000).optional(),
});

const AddArgs = z.object({
  kinfolkId: z.string().optional(),
  kin: KinPayload,
});
const UpdateArgs = z.object({
  kinfolkId: z.string().optional(),
  kinId: z.string().min(1),
  kin: KinPayload.partial(),
});
const ArchiveArgs = z.object({
  kinfolkId: z.string().optional(),
  kinId: z.string().min(1),
  reason: z.enum(['noLongerWithUs', 'restore']),
});
const DeleteArgs = z.object({
  kinfolkId: z.string().optional(),
  kinId: z.string().min(1).max(120),
  /**
   * Fail-safe polarity (#1314): without `confirm: true` the callable only
   * reports whether the Kin can be deleted and writes nothing. The edit
   * screens call it that way on open to decide whether to show the row, so
   * the one function instance the confirm tap will hit is already warm.
   */
  confirm: z.boolean().optional(),
});

/** What a Kin's history can consist of, in the order the refusal names it. */
export type KinHistoryKind = 'visits' | 'tales' | 'photos' | 'records';

export interface DeleteKinResult {
  ok: true;
  /** True only after a confirmed delete removed the documents. */
  deleted: boolean;
  /** False when any document anywhere still references this Kin. */
  canDelete: boolean;
  blockedBy: KinHistoryKind[];
}

/** First row, or none, of a single-field query; the only shape the history check needs. */
async function anyMatch(query: FirebaseFirestore.Query): Promise<boolean> {
  const snap = await query.limit(1).get();
  return !snap.empty;
}

/**
 * #1314. Every collection that stores a Kin id, checked for THIS Kin under
 * either of its two ids: the family doc id (what the portal writes into
 * `kinIds` on bookings, visits and sessions it creates) and the flat
 * `kin/{docId}` mirror id (what AuntieOS writes into sessions, KinTales,
 * media tags, training documents and `the_411`). Every query is single-field
 * so no composite index is needed, and the ids are Firestore document ids, so
 * a match in another household is not a real possibility.
 *
 * Invoices are NOT queried: `invoices/{id}` carries `sessionIds` and line
 * items, never a kin id (see portal/getMyInvoices.ts). An invoice reaches a
 * Kin only through a `kin_care_sessions` row, and that row is caught here, so
 * a Kin with an invoice is a Kin with a session and is refused on that.
 *
 * `families/{fid}/kinTales` (the legacy `ingestKinTale` layout) carries no kin
 * id at all, so it cannot be checked and is not.
 */
export async function findKinHistory(
  kinfolkId: string,
  ids: readonly string[],
): Promise<KinHistoryKind[]> {
  const firestore = db();
  const idList = [...new Set(ids.filter((id) => id.length > 0))];
  if (idList.length === 0) return [];
  const flatIds = idList.slice(0, 10);

  // Portal bookings stamp `kinIds` on the envelope and on each visit; the
  // kinCares collection-group read filtered in memory is the same read
  // getMyBookings makes, so its index already exists.
  const visitChecks = await Promise.all([
    anyMatch(firestore.collection(`families/${kinfolkId}/bookings`).where('kinIds', 'array-contains-any', flatIds)),
    firestore
      .collectionGroup('kinCares')
      .where('familyId', '==', kinfolkId)
      .get()
      .then((snap) =>
        snap.docs.some((d) => {
          const kinIds = (d.data() as Record<string, unknown>)['kinIds'];
          return Array.isArray(kinIds) && kinIds.some((k) => typeof k === 'string' && idList.includes(k));
        }),
      ),
    anyMatch(firestore.collection('kin_care_sessions').where('kinIds', 'array-contains-any', flatIds)),
  ]);
  const taleChecks = await Promise.all([
    anyMatch(firestore.collection('kin_care_reports').where('kinIds', 'array-contains-any', flatIds)),
  ]);
  // media_files points at a pet three ways: the admin gallery's owner link
  // (`entityType: 'KIN'` + `entityId`, the flat id), the #447 tag list, and a
  // legacy `kinId`. `entityType` is not filtered on (its casing is
  // inconsistent in production, see admin/deleteMediaFile.ts); a kin id in
  // `entityId` is a kin reference whatever the type says.
  const photoChecks = await Promise.all([
    anyMatch(firestore.collection('media_files').where('entityId', 'in', flatIds)),
    anyMatch(firestore.collection('media_files').where('kinId', 'in', flatIds)),
    anyMatch(firestore.collection('media_files').where('taggedKinIds', 'array-contains-any', flatIds)),
  ]);
  // the_411: `upsert_kin411` writes the deterministic id `411_{kinId}`; the
  // admin Android app reads by the `kinId` field, so older records may sit
  // under any id. Both spellings are checked.
  const recordChecks = await Promise.all([
    anyMatch(firestore.collection('training_documents').where('targetKinId', 'in', flatIds)),
    anyMatch(firestore.collection('the_411').where('kinId', 'in', flatIds)),
    ...idList.map((id) => firestore.doc(`the_411/411_${id}`).get().then((s) => s.exists)),
  ]);

  const blockedBy: KinHistoryKind[] = [];
  if (visitChecks.some(Boolean)) blockedBy.push('visits');
  if (taleChecks.some(Boolean)) blockedBy.push('tales');
  if (photoChecks.some(Boolean)) blockedBy.push('photos');
  if (recordChecks.some(Boolean)) blockedBy.push('records');
  return blockedBy;
}

/** The one plain sentence a refused delete carries. */
export function deleteRefusalMessage(kinName: string | null, blockedBy: readonly KinHistoryKind[]): string {
  const who = kinName && kinName.trim().length > 0 ? kinName.trim() : 'This Kin';
  const words: Record<KinHistoryKind, string> = {
    visits: 'visits',
    tales: 'KinTales',
    photos: 'photos',
    records: 'records',
  };
  const named = blockedBy.map((b) => words[b]);
  const list =
    named.length <= 1
      ? named[0] ?? 'history'
      : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
  return `${who} has ${list} on file, so this profile cannot be deleted from here.`;
}

// Was a hard clients/{uid}.kinfolkIds check with no staff path: an operator
// impersonating a household got permission-denied here, before ever reaching
// requireKinfolkPerm below (which already knew how to bypass staff). Now
// delegates to the same resolver the read side uses, so staff (admin claim OR
// the AUNTIE_OPERATOR_UIDS allowlist) resolve any existing kinfolkId, and a
// cross-tenant resolution is audit-logged inside the resolver itself.
async function resolveKinfolkId(
  uid: string,
  requested: string | undefined,
  hasAdminClaim: boolean,
  functionName: string,
): Promise<string> {
  const { kinfolkId } = await resolveKinfolkAccess(uid, requested, hasAdminClaim, functionName);
  return kinfolkId;
}

export async function addKinHandler(req: CallableRequest<unknown>): Promise<{ kinId: string }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = AddArgs.parse(req.data);
  const hasAdminClaim = householdStaffFlag(req.auth, 'addKin');
  const kinfolkId = await resolveKinfolkId(uid, args.kinfolkId, hasAdminClaim, 'addKin');
  await requireKinfolkPerm(uid, kinfolkId, 'kin_edit', hasAdminClaim, 'addKin');

  const ref = await db().collection(`families/${kinfolkId}/kin`).add({
    ...args.kin,
    status: 'active',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    createdByUid: uid,
  });
  logEvent({ severity: 'info', function: 'addKin', event: 'portal.kin.added', uid, extra: { kinfolkId, kinId: ref.id } });
  return { kinId: ref.id };
}

export async function updateKinHandler(req: CallableRequest<unknown>): Promise<{ ok: true }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = UpdateArgs.parse(req.data);
  const hasAdminClaim = householdStaffFlag(req.auth, 'updateKin');
  const kinfolkId = await resolveKinfolkId(uid, args.kinfolkId, hasAdminClaim, 'updateKin');
  await requireKinfolkPerm(uid, kinfolkId, 'kin_edit', hasAdminClaim, 'updateKin');

  await db().doc(`families/${kinfolkId}/kin/${args.kinId}`).set(
    {
      ...args.kin,
      updatedAt: FieldValue.serverTimestamp(),
      updatedByUid: uid,
    },
    { merge: true },
  );
  logEvent({ severity: 'info', function: 'updateKin', event: 'portal.kin.updated', uid, extra: { kinfolkId, kinId: args.kinId } });
  return { ok: true };
}

export async function archiveKinHandler(req: CallableRequest<unknown>): Promise<{ ok: true }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = ArchiveArgs.parse(req.data);
  const hasAdminClaim = householdStaffFlag(req.auth, 'archiveKin');
  const kinfolkId = await resolveKinfolkId(uid, args.kinfolkId, hasAdminClaim, 'archiveKin');
  await requireKinfolkPerm(uid, kinfolkId, 'kin_edit', hasAdminClaim, 'archiveKin');

  const status = args.reason === 'restore' ? 'active' : 'noLongerWithUs';
  await db().doc(`families/${kinfolkId}/kin/${args.kinId}`).set(
    {
      status,
      updatedAt: FieldValue.serverTimestamp(),
      updatedByUid: uid,
    },
    { merge: true },
  );
  logEvent({ severity: 'info', function: 'archiveKin', event: 'portal.kin.archived', uid, extra: { kinfolkId, kinId: args.kinId, status } });
  return { ok: true };
}

/**
 * #1314. A household deletes a Kin itself ONLY when nothing references it:
 * no booking, visit or session, no KinTale, no tagged photo, no admin record.
 * With history the request path is #1408 (operator archives), not this.
 *
 * Without `confirm: true` this is a read: it answers `canDelete` and writes
 * nothing. With it, and no history, it hard-deletes the family doc
 * `families/{kinfolkId}/kin/{kinId}` AND its flat mirror `kin/{legacyKinId}`
 * in one batch. Both mirror triggers (`onFamilyKinWrite`, `onFlatKinWrite`)
 * return on a delete event (`!after`), so neither copy is re-created. The flat
 * doc is only deleted when it links back to this family doc; a flat pet that
 * merely shares the name (the `findFlatMirror` name fallback) is left alone.
 */
export async function deleteKinHandler(req: CallableRequest<unknown>): Promise<DeleteKinResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = DeleteArgs.parse(req.data);
  const hasAdminClaim = householdStaffFlag(req.auth, 'deleteKin');
  const kinfolkId = await resolveKinfolkId(uid, args.kinfolkId, hasAdminClaim, 'deleteKin');
  await requireKinfolkPerm(uid, kinfolkId, 'kin_edit', hasAdminClaim, 'deleteKin');

  const firestore = db();
  const familyKinPath = `families/${kinfolkId}/kin/${args.kinId}`;
  const familyRef = firestore.doc(familyKinPath);
  const familySnap = await familyRef.get();
  if (!familySnap.exists) throw new HttpsError('not-found', 'That Kin is no longer on this profile.');
  const family = (familySnap.data() ?? {}) as Record<string, unknown>;
  const kinName = typeof family['name'] === 'string' ? (family['name'] as string) : null;

  // The flat mirror: the stamped link first, else the reverse link the mirror
  // writes onto the flat doc. Never the name fallback (see the docblock).
  let flatId = typeof family['legacyKinId'] === 'string' && family['legacyKinId'] !== '' ? (family['legacyKinId'] as string) : null;
  if (!flatId) {
    const byPath = await firestore.collection('kin').where('familyKinPath', '==', familyKinPath).limit(1).get();
    if (!byPath.empty) flatId = byPath.docs[0].id;
  }

  const blockedBy = await findKinHistory(kinfolkId, flatId ? [args.kinId, flatId] : [args.kinId]);
  const canDelete = blockedBy.length === 0;

  if (args.confirm !== true) {
    logEvent({ severity: 'info', function: 'deleteKin', event: 'portal.kin.delete.checked', uid, extra: { kinfolkId, kinId: args.kinId, canDelete, blockedBy } });
    return { ok: true, deleted: false, canDelete, blockedBy };
  }
  if (!canDelete) {
    logEvent({ severity: 'info', function: 'deleteKin', event: 'portal.kin.delete.refused', uid, extra: { kinfolkId, kinId: args.kinId, blockedBy } });
    throw new HttpsError('failed-precondition', deleteRefusalMessage(kinName, blockedBy));
  }

  const batch = firestore.batch();
  batch.delete(familyRef);
  let flatDeleted: string | null = null;
  if (flatId) {
    const flatRef = firestore.doc(`kin/${flatId}`);
    const flatSnap = await flatRef.get();
    const flat = (flatSnap.data() ?? {}) as Record<string, unknown>;
    const linksBack = flat['familyKinPath'] === familyKinPath || flat['kinfolkId'] === kinfolkId;
    if (flatSnap.exists && linksBack) {
      batch.delete(flatRef);
      flatDeleted = flatId;
    } else if (flatSnap.exists) {
      logEvent({ severity: 'warn', function: 'deleteKin', event: 'portal.kin.delete.flat-unlinked', uid, extra: { kinfolkId, kinId: args.kinId, flatId } });
    }
  }
  await batch.commit();
  logEvent({ severity: 'info', function: 'deleteKin', event: 'portal.kin.deleted', uid, extra: { kinfolkId, kinId: args.kinId, flatId: flatDeleted } });
  return { ok: true, deleted: true, canDelete: true, blockedBy: [] };
}

export const addKin = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('addKin', addKinHandler),
);
export const updateKin = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('updateKin', updateKinHandler),
);
export const archiveKin = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('archiveKin', archiveKinHandler),
);
export const deleteKin = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('deleteKin', deleteKinHandler),
);
