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
  STAFF_ONLY_KIN_FIELDS,
  buildFamilyCopyFromFlat,
  changedKeys,
  isMirrorEcho,
  mirrorStamp,
  omitKeys,
  toFamilyFields,
} from './kinMirror';
import { DEFAULT_KIN_STATUS, isInactiveKinStatus } from '../lib/kinStatus';

type FlatKinDoc = {
  kinfolkId?: string;
  familyKinPath?: string;
  legacyKinId?: string;
  _mirrorOrigin?: string;
  _mirrorWriteId?: string;
} & Record<string, unknown>;

export type FlatMirrorResult = {
  action: 'mirrored' | 'adopted' | 'linked' | 'skipped';
  reason?: string;
  familyKinPath?: string;
};

function text(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function familyPathFor(kinfolkId: string, kinId: string): string {
  return `families/${kinfolkId}/kin/${kinId}`;
}

/**
 * Reverse mirror: copies the shared fields that CHANGED on a flat `kin/{docId}`
 * doc into the canonical `families/{kinfolkId}/kin/{kinId}` record, translated
 * to the household's keys (kinMirror.ts field table). Staff-only fields
 * (officeNotes, reactive, tags) never leave the flat doc (#1335).
 *
 * Loop prevention:
 *   1. Echo guard: skip the forward mirror's own write, recognised by a write
 *      id that is new on this write. A client write that leaves an old
 *      `_mirrorOrigin: family` in place is NOT an echo, and is mirrored.
 *   2. Change guard: only the fields that changed on this write travel; none
 *      changed, nothing is written.
 *
 * #1847: a flat Kin with no household copy gets one. The office can make a Kin
 * first (admin web wrote no link at all; admin Android stamped a link to a copy
 * nobody made), and the household's Tribe page then said "No Kin yet" for a
 * household whose Directory card listed one. `adoptFlatKin` makes the copy.
 *
 * The household copy is never written with a household-owned field (name,
 * photo, status) once it exists. The one exception is a `status` SEED: when
 * the merge would otherwise create a statusless family doc it is stamped
 * `active`, so the pet is visible in the portal.
 */
export async function mirrorFlatKinToFamily(
  before: FlatKinDoc | undefined,
  after: FlatKinDoc,
  flatDocId?: string,
): Promise<FlatMirrorResult> {
  if (isMirrorEcho(before, after, MIRROR_ORIGIN_FAMILY)) {
    return { action: 'skipped', reason: 'family-origin' };
  }

  const familyKinPath = text(after.familyKinPath);
  if (familyKinPath === '') {
    if (!flatDocId) return { action: 'skipped', reason: 'no-link' };
    return adoptFlatKin(flatDocId, after);
  }

  // Inclusion list first, translated, then strip every household-owned field
  // and every staff-only field. The lists are disjoint today, so both strips
  // are no-ops; they are here so that adding a field to STAFF_EDITABLE_FIELDS
  // can never silently hand staff a field the household owns (`status` above
  // all), nor copy a staff note onto a document every household member can
  // read (#1335).
  const payload = omitKeys(
    omitKeys(toFamilyFields(after, changedKeys(before, after, STAFF_EDITABLE_FIELDS)), PARENT_OWNED_FIELDS),
    STAFF_ONLY_KIN_FIELDS,
  );
  // A link that is new on this write (a create, or admin Android stamping one
  // after its add) or a Kin coming back from archive may name a household copy
  // that does not exist yet. Those are the writes that make sure it does.
  const linkIsNew = before === undefined || text(before.familyKinPath) !== familyKinPath;
  const restored = isInactiveKinStatus(before?.status) && !isInactiveKinStatus(after.status);
  if (Object.keys(payload).length === 0 && !linkIsNew && !restored) {
    return { action: 'skipped', reason: 'no-change' };
  }

  // The read and the write share a transaction so a memorial the household
  // sets concurrently cannot be overwritten by a stale "absent" read.
  const familyRef = db().doc(familyKinPath);
  const wrote = await db().runTransaction(async (tx) => {
    const snap = await tx.get(familyRef);
    if (!snap.exists) {
      // No household copy: make the whole one, not a nameless shell of the
      // changed fields. An archived Kin gets none; it is made when restored.
      if (isInactiveKinStatus(after.status)) return 'none' as const;
      tx.set(familyRef, {
        ...buildFamilyCopyFromFlat(after),
        ...payload,
        status: DEFAULT_KIN_STATUS,
        ...(flatDocId ? { legacyKinId: flatDocId } : {}),
        familyKinPath,
        ...mirrorStamp(MIRROR_ORIGIN_FLAT),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return 'created' as const;
    }
    if (Object.keys(payload).length === 0) return 'none' as const;
    const existing = (snap.data() as Record<string, unknown> | undefined)?.['status'];
    const seedStatus = typeof existing === 'string' && existing.length > 0 ? {} : { status: DEFAULT_KIN_STATUS };
    tx.set(
      familyRef,
      {
        ...payload,
        ...seedStatus,
        ...mirrorStamp(MIRROR_ORIGIN_FLAT),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return 'merged' as const;
  });
  if (wrote === 'none') return { action: 'skipped', reason: 'no-change', familyKinPath };
  return { action: wrote === 'created' ? 'adopted' : 'mirrored', familyKinPath };
}

/**
 * #1847. Gives a flat Kin with no link its household copy, or ties it to the
 * one it already has. Never makes a second copy of one Kin:
 *   - a household copy already stamped with this record keeps it (the pointer
 *     was all that was missing);
 *   - an unstamped, live household copy of the same name is the same animal
 *     (a seeded household, or a Kin the household added before the link
 *     existed), and is tied to this record rather than duplicated;
 *   - otherwise a copy is made at `families/{kinfolkId}/kin/{flatId}`, the
 *     path admin Android has always stamped for a Kin the office made.
 * An archived or memorialised record gets nothing: it would only be hidden.
 * The claim is made in a transaction on the flat doc, so a link that arrived
 * in the meantime (the household's own add taking this record by name) wins.
 */
export async function adoptFlatKin(flatId: string, flat: FlatKinDoc): Promise<FlatMirrorResult> {
  const kinfolkId = text(flat.kinfolkId).trim();
  if (kinfolkId === '' || kinfolkId.includes('/') || flatId.includes('/')) {
    return { action: 'skipped', reason: 'no-household' };
  }
  if (isInactiveKinStatus(flat['status'])) return { action: 'skipped', reason: 'inactive' };
  const firestore = db();

  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const stamped = await firestore.collection(`families/${kinfolkId}/kin`).where('legacyKinId', '==', flatId).get();
  let targetKinId: string | null = [...stamped.docs].sort(byId)[0]?.id ?? null;
  if (targetKinId === null) {
    const name = text(flat['name']).trim();
    if (name !== '') {
      const byName = await firestore.collection(`families/${kinfolkId}/kin`).where('name', '==', name).get();
      const twin = [...byName.docs].sort(byId).find((d) => {
        const data = (d.data() ?? {}) as Record<string, unknown>;
        return text(data['legacyKinId']) === '' && !isInactiveKinStatus(data['status']);
      });
      targetKinId = twin?.id ?? null;
    }
  }
  const path = familyPathFor(kinfolkId, targetKinId ?? flatId);
  const familyRef = firestore.doc(path);
  const flatRef = firestore.doc(`kin/${flatId}`);

  const outcome = await firestore.runTransaction(async (tx) => {
    const flatSnap = await tx.get(flatRef);
    const famSnap = await tx.get(familyRef);
    if (!flatSnap.exists) return 'gone' as const;
    const current = (flatSnap.data() ?? {}) as Record<string, unknown>;
    const pointer = text(current['familyKinPath']);
    if (pointer !== '' && pointer !== path) return 'linked-elsewhere' as const;
    if (isInactiveKinStatus(current['status'])) return 'inactive' as const;
    if (!famSnap.exists) {
      tx.set(familyRef, {
        ...buildFamilyCopyFromFlat(current),
        status: DEFAULT_KIN_STATUS,
        legacyKinId: flatId,
        familyKinPath: path,
        ...mirrorStamp(MIRROR_ORIGIN_FLAT),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else if (text(((famSnap.data() ?? {}) as Record<string, unknown>)['legacyKinId']) === '') {
      tx.set(familyRef, { legacyKinId: flatId, familyKinPath: path, ...mirrorStamp(MIRROR_ORIGIN_FLAT) }, { merge: true });
    }
    tx.set(
      flatRef,
      { kinfolkId, familyKinPath: path, legacyKinId: flatId, ...mirrorStamp(MIRROR_ORIGIN_FAMILY) },
      { merge: true },
    );
    return famSnap.exists ? ('linked' as const) : ('adopted' as const);
  });

  if (outcome === 'adopted' || outcome === 'linked') {
    logEvent({
      severity: 'info',
      function: 'onFlatKinWrite',
      event: outcome === 'adopted' ? 'mirror.family.adopted' : 'mirror.family.linked',
      extra: { kinfolkId, flatId, familyKinPath: path },
    });
    return { action: outcome, familyKinPath: path };
  }
  return { action: 'skipped', reason: outcome };
}

/**
 * Watches the AuntieOS flat `kin/{docId}` collection and mirrors staff edits
 * back into the canonical MyTribe family record, making that record first
 * when the office made the Kin (#1847).
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

    const result = await mirrorFlatKinToFamily(before, after, docId);
    logEvent({
      severity: 'info',
      function: 'onFlatKinWrite',
      event: result.action === 'skipped' ? 'mirror.family.skipped' : 'mirror.family.updated',
      extra: { docId, action: result.action, reason: result.reason ?? null },
    });
  }),
);
