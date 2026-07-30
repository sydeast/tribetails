import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapTrigger } from '../lib/wrapTrigger';
import {
  MIRROR_ORIGIN_FAMILY,
  MIRROR_ORIGIN_FLAT,
  PARENT_OWNED_FIELDS,
  STAFF_EDITABLE_FIELDS,
  omitKeys,
  pickDefined,
  projectChanged,
} from './kinMirror';
import { DEFAULT_KIN_STATUS } from '../lib/kinStatus';

type FlatKinDoc = {
  kinfolkId?: string;
  familyKinPath?: string;
  legacyKinId?: string;
  _mirrorOrigin?: string;
} & Record<string, unknown>;

/**
 * Reverse mirror: copies staff-editable fields from a flat `kin/{docId}` doc
 * back into the canonical `families/{kinfolkId}/kin/{kinId}` record.
 *
 * Loop prevention (two independent guards, either one short-circuits):
 *   1. Origin guard: skip when the write was authored by the family -> flat
 *      mirror (`_mirrorOrigin === family`). That write only ever touches
 *      parent-owned fields, which we exclude anyway, but the origin guard stops
 *      us even attempting a write.
 *   2. Real-change guard: skip when no staff-editable field actually changed
 *      between before and after. This catches the echo our OWN write produces
 *      (it flips `_mirrorOrigin` to `flat` but leaves staff fields identical).
 *
 * The reverse write EXCLUDES every parent-owned field so a stale staff doc can
 * never clobber what the parent just typed in the portal. The one exception is
 * a `status` SEED (not a mirror): when the merge would otherwise create a
 * statusless family doc, it is stamped `active` so the pet is visible in the
 * portal. An existing status is never overwritten.
 */
export async function mirrorFlatKinToFamily(
  before: FlatKinDoc | undefined,
  after: FlatKinDoc,
): Promise<{ action: 'mirrored' | 'skipped'; reason?: string }> {
  const familyKinPath =
    typeof after.familyKinPath === 'string' ? after.familyKinPath : null;
  if (!familyKinPath) return { action: 'skipped', reason: 'no-link' };

  // Guard 1: skip echoes from the family -> flat mirror.
  if (after._mirrorOrigin === MIRROR_ORIGIN_FAMILY) {
    return { action: 'skipped', reason: 'family-origin' };
  }

  // Guard 2: skip when no staff-editable field actually changed.
  if (!projectChanged(before, after, STAFF_EDITABLE_FIELDS)) {
    return { action: 'skipped', reason: 'no-change' };
  }

  // Inclusion list first, then strip every parent-owned field. The two lists are
  // disjoint today, so the strip is a no-op; it is here so that adding a field
  // to STAFF_EDITABLE_FIELDS can never silently hand staff a field the parent
  // owns (`status` above all: AuntieOS writes `archived` onto the flat doc, and
  // that must never travel back and un-memorialize a pet).
  const payload = omitKeys(pickDefined(after, STAFF_EDITABLE_FIELDS), PARENT_OWNED_FIELDS);
  if (Object.keys(payload).length === 0) {
    return { action: 'skipped', reason: 'empty-projection' };
  }

  // This is a merge write against a family kin doc that MAY NOT EXIST: staff can
  // create the flat pet first and link it to a family path the portal has not
  // written yet. A merge creates that doc, and it used to be created with no
  // `status` at all, which dropped the pet out of the portal's Kin list.
  //
  // So seed the default, ONCE, and only into the gap. The parent stays the sole
  // writer of the VALUE: an existing status, memorial included, is never
  // touched. The read and the write share a transaction so a memorial the
  // parent sets concurrently cannot be overwritten by a stale "absent" read.
  const familyRef = db().doc(familyKinPath);
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(familyRef);
    const existing = (snap.data() as Record<string, unknown> | undefined)?.['status'];
    const seedStatus =
      typeof existing === 'string' && existing.length > 0 ? {} : { status: DEFAULT_KIN_STATUS };
    tx.set(
      familyRef,
      {
        ...payload,
        ...seedStatus,
        _mirrorOrigin: MIRROR_ORIGIN_FLAT,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });
  return { action: 'mirrored' };
}

/**
 * Watches the AuntieOS flat `kin/{docId}` collection and mirrors staff edits
 * back into the canonical MyTribe family record. No-op for flat docs that carry
 * no `familyKinPath` link (AuntieOS-only pets never adopted by a portal user).
 */
export const onFlatKinWrite = onDocumentWritten(
  {
    document: 'kin/{docId}',
    region: 'us-central1',
    secrets: ['SENTRY_DSN'],
  },
  wrapTrigger('onFlatKinWrite', async (event) => {
    const docId = event.params.docId;
    const before = event.data?.before.data() as FlatKinDoc | undefined;
    const after = event.data?.after.data() as FlatKinDoc | undefined;
    if (!after) return;

    const result = await mirrorFlatKinToFamily(before, after);
    logEvent({
      severity: 'info',
      function: 'onFlatKinWrite',
      event: result.action === 'mirrored' ? 'mirror.family.updated' : 'mirror.family.skipped',
      extra: { docId, action: result.action, reason: result.reason ?? null },
    });
  }),
);
