import { FieldValue } from 'firebase-admin/firestore';
import { db } from './firestoreAdmin';
import { logEvent } from './logger';
import { isInactiveKinStatus } from './kinStatus';
import { isFamilyKinPath } from './kinArchive';
import { KIN_REMOVAL_REQUESTS, kinRemovalRequestId } from './kinRemovalRequest';
import { MIRROR_ORIGIN_FAMILY, mirrorStamp } from '../triggers/kinMirror';

/**
 * #1912. Which admin record (`kin/{id}`, the flat doc) is a household Kin's own.
 *
 * A Kin lives in two places: the household's copy
 * `families/{kinfolkId}/kin/{kinId}` and the admin's flat `kin/{id}`. The pair
 * is tied by `legacyKinId` on the household copy and `familyKinPath` on the
 * flat doc. Every reader used to trust whichever of those it met first, and
 * the mirror used to tie a new Kin to any flat doc of the same name. A Kin
 * added under the name of an archived Kin was tied to the archived Kin's
 * record: the office never saw the new Kin, and its history, delete and
 * removal request were all answered from the archived one.
 *
 * ONE RECORD, ONE KIN. A flat doc belongs to a household Kin only when
 *   - it exists and sits in the same household, and
 *   - no other Kin of that household has the older claim to it.
 * When two Kin claim one flat doc, the one created first keeps it. The other
 * is `crossed` and gets a record of its own (`healKinLink`).
 *
 * `familyKinPath` on the flat doc is NOT the test of ownership. The crossing
 * overwrote it with the newcomer's path, and the admin Android app re-stamps
 * it on every save from the flat id. Ownership is read from the household
 * copies' `legacyKinId`; the pointer is repaired to match.
 *
 * Nothing here chooses which fields travel between the two copies. That is
 * `triggers/kinMirror.ts`.
 */

type Data = Record<string, unknown>;

export type KinLink =
  /** `contested`: another Kin also claims this record and must be given its own. */
  | { state: 'linked'; flatId: string; contested: boolean }
  /** No admin record yet (or the stamp names one that no longer exists). */
  | { state: 'none' }
  /** The stamp names a record outside this household. It is never read further or written. */
  | { state: 'foreign'; flatId: string }
  /** The stamp names a record that is another Kin's (`ownerKinId`), or a record the office holds alone (null). */
  | { state: 'crossed'; flatId: string; ownerKinId: string | null };

export interface KinLinkHeal {
  /** The Kin that keeps the record, or null when no household Kin does. */
  ownerKinId: string | null;
  /** Each Kin that was given a record of its own. */
  moved: Array<{ kinId: string; flatId: string }>;
}

interface Claimant {
  kinId: string;
  data: Data;
  createdMs: number;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function familyKinPathFor(kinfolkId: string, kinId: string): string {
  return `families/${kinfolkId}/kin/${kinId}`;
}

function millisOf(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (value && typeof (value as { toMillis?: unknown }).toMillis === 'function') {
    const ms = (value as { toMillis: () => unknown }).toMillis();
    return typeof ms === 'number' ? ms : null;
  }
  return null;
}

/**
 * When a document was first written. Firestore's own `createTime` where the
 * snapshot carries one, else the `createdAt` field, else 0: a document with
 * neither predates every stamp and counts as the oldest.
 */
function createdMillis(snap: unknown, data: Data): number {
  return millisOf((snap as { createTime?: unknown } | null)?.createTime) ?? millisOf(data['createdAt']) ?? 0;
}

/** True when the flat doc sits in this household. */
function inHousehold(flat: Data, kinfolkId: string): boolean {
  const stored = text(flat['kinfolkId']);
  if (stored !== '') return stored === kinfolkId;
  return text(flat['familyKinPath']).startsWith(`families/${kinfolkId}/kin/`);
}

/**
 * Every household Kin that claims this flat doc: the ones stamped with its id,
 * plus the one its pointer names when that copy carries no stamp yet (a record
 * the office made first).
 */
async function readClaimants(kinfolkId: string, flatId: string, flat: Data): Promise<Claimant[]> {
  const firestore = db();
  const stamped = await firestore.collection(`families/${kinfolkId}/kin`).where('legacyKinId', '==', flatId).get();
  const claimants: Claimant[] = stamped.docs.map((d) => {
    const data = (d.data() ?? {}) as Data;
    return { kinId: d.id, data, createdMs: createdMillis(d, data) };
  });
  const pointer = text(flat['familyKinPath']);
  if (isFamilyKinPath(pointer) && pointer.startsWith(`families/${kinfolkId}/kin/`)) {
    const kinId = pointer.split('/')[3];
    if (!claimants.some((c) => c.kinId === kinId)) {
      const snap = await firestore.doc(pointer).get();
      const data = (snap.data() ?? {}) as Data;
      if (snap.exists && text(data['legacyKinId']) === '') {
        claimants.push({ kinId, data, createdMs: createdMillis(snap, data) });
      }
    }
  }
  return claimants.sort((a, b) => a.createdMs - b.createdMs || (a.kinId < b.kinId ? -1 : a.kinId > b.kinId ? 1 : 0));
}

/**
 * True for a portal-made Kin tied to a record that was already there and is
 * archived or memorialised, while the Kin itself is on the household's roster.
 * That is the crossing with nobody else to point at: the archived record was
 * the office's alone. A Kin's own record is made after the Kin, so the order
 * of creation is what tells this apart from a household's own memorial.
 */
function adoptedWhileHidden(claimant: Claimant, flat: Data, flatCreatedMs: number): boolean {
  return (
    text(claimant.data['createdByUid']) !== '' &&
    !isInactiveKinStatus(claimant.data['status']) &&
    isInactiveKinStatus(flat['status']) &&
    flatCreatedMs < claimant.createdMs
  );
}

/** The claimant that keeps the record: the earliest, unless it was tied to a hidden record it never owned. */
function pickOwner(claimants: Claimant[], flat: Data, flatCreatedMs: number, restoringKinId: string | null): Claimant | null {
  const first = claimants[0];
  if (!first) return null;
  if (first.kinId !== restoringKinId && adoptedWhileHidden(first, flat, flatCreatedMs)) return null;
  return first;
}

/**
 * Reads the Kin's link and says whether the record it names is its own.
 * Read-only. `restoring` is set by the mirror on the one write that brings a
 * Kin back from a memorial: for that moment the household copy is active and
 * the flat copy is not, by design.
 */
export async function resolveKinLink(
  kinfolkId: string,
  kinId: string,
  family: Data,
  opts: { restoring?: boolean } = {},
): Promise<KinLink> {
  const firestore = db();
  const path = familyKinPathFor(kinfolkId, kinId);

  let flatId = text(family['legacyKinId']);
  let flat: Data;
  let flatCreatedMs: number;
  if (flatId !== '') {
    // A stamp is a document id. Anything with a slash would address some other
    // collection, so it is no link at all.
    if (flatId.includes('/')) return { state: 'none' };
    const snap = await firestore.doc(`kin/${flatId}`).get();
    if (!snap.exists) return { state: 'none' };
    flat = (snap.data() ?? {}) as Data;
    flatCreatedMs = createdMillis(snap, flat);
    if (!inHousehold(flat, kinfolkId)) return { state: 'foreign', flatId };
  } else {
    const byPath = await firestore.collection('kin').where('familyKinPath', '==', path).get();
    const own = byPath.docs.find((d) => inHousehold((d.data() ?? {}) as Data, kinfolkId));
    if (!own) return { state: 'none' };
    flatId = own.id;
    flat = (own.data() ?? {}) as Data;
    flatCreatedMs = createdMillis(own, flat);
  }

  const claimants = await readClaimants(kinfolkId, flatId, flat);
  if (!claimants.some((c) => c.kinId === kinId)) {
    claimants.push({ kinId, data: family, createdMs: createdMillis(null, family) });
    claimants.sort((a, b) => a.createdMs - b.createdMs);
  }
  const owner = pickOwner(claimants, flat, flatCreatedMs, opts.restoring ? kinId : null);
  if (owner?.kinId === kinId) return { state: 'linked', flatId, contested: claimants.length > 1 };
  return { state: 'crossed', flatId, ownerKinId: owner?.kinId ?? null };
}

/** The flat status that goes with a household copy's status. */
function flatStatusOf(familyStatus: unknown): 'active' | 'inactive' | 'archived' {
  if (familyStatus === 'archived') return 'archived';
  return isInactiveKinStatus(familyStatus) ? 'inactive' : 'active';
}

/**
 * Puts one flat doc and every Kin that claims it right. Safe to call on a
 * healthy record: it reads, finds one claimant with a matching pointer, and
 * writes nothing.
 *
 *   - The owner keeps the record. Its pointer is set back to the owner, and
 *     when another Kin had been writing into it, the owner's own facts are
 *     copied over it again from the household copy (the canonical side).
 *     Status and everything staff keep on the record are left as they are.
 *   - Every other claimant gets a new record made from its household copy and
 *     is stamped with it. Its waiting removal request follows it.
 *   - A record no household Kin owns loses its pointer (deleted, never null:
 *     the admin Android model decodes it as a non-null String).
 *
 * One batch, so a pair is never left half moved.
 */
export async function healKinLink(kinfolkId: string, flatId: string): Promise<KinLinkHeal> {
  const untouched: KinLinkHeal = { ownerKinId: null, moved: [] };
  if (flatId === '' || flatId.includes('/')) return untouched;
  const firestore = db();
  const flatRef = firestore.doc(`kin/${flatId}`);
  const flatSnap = await flatRef.get();
  if (!flatSnap.exists) return untouched;
  const flat = (flatSnap.data() ?? {}) as Data;
  if (!inHousehold(flat, kinfolkId)) return untouched;

  const claimants = await readClaimants(kinfolkId, flatId, flat);
  if (claimants.length === 0) return untouched;
  const owner = pickOwner(claimants, flat, createdMillis(flatSnap, flat), null);
  const others = claimants.filter((c) => c.kinId !== owner?.kinId);
  const ownerPath = owner ? familyKinPathFor(kinfolkId, owner.kinId) : null;
  if (others.length === 0 && text(flat['familyKinPath']) === ownerPath) {
    return { ownerKinId: owner?.kinId ?? null, moved: [] };
  }

  // Loaded here, not imported at the top: the mirror trigger imports this
  // module, and its projection is only needed on the rare repair.
  const { buildFlatMirrorPayload, buildAdminPortraitStamp } = await import('../triggers/onFamilyKinWrite.js');
  const batch = firestore.batch();
  const moved: KinLinkHeal['moved'] = [];
  for (const other of others) {
    const path = familyKinPathFor(kinfolkId, other.kinId);
    const newRef = firestore.collection('kin').doc();
    batch.set(newRef, {
      ...buildFlatMirrorPayload(other.data),
      ...buildAdminPortraitStamp(undefined, other.data),
      kinfolkId,
      familyKinPath: path,
      legacyKinId: newRef.id,
      status: flatStatusOf(other.data['status']),
      ...mirrorStamp(MIRROR_ORIGIN_FAMILY),
      updatedAt: FieldValue.serverTimestamp(),
    });
    batch.set(firestore.doc(path), { legacyKinId: newRef.id, familyKinPath: path }, { merge: true });
    const requestRef = firestore.doc(`${KIN_REMOVAL_REQUESTS}/${kinRemovalRequestId(kinfolkId, other.kinId)}`);
    const requestSnap = await requestRef.get();
    if (requestSnap.exists && (requestSnap.data() ?? {})['status'] === 'pending') {
      batch.set(requestRef, { flatKinId: newRef.id, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    }
    moved.push({ kinId: other.kinId, flatId: newRef.id });
  }

  if (owner && ownerPath) {
    batch.set(
      flatRef,
      {
        ...(others.length > 0 ? buildFlatMirrorPayload(owner.data) : {}),
        kinfolkId,
        familyKinPath: ownerPath,
        legacyKinId: flatId,
        ...mirrorStamp(MIRROR_ORIGIN_FAMILY),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  } else {
    batch.set(
      flatRef,
      { familyKinPath: FieldValue.delete(), ...mirrorStamp(MIRROR_ORIGIN_FAMILY), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  }
  await batch.commit();
  logEvent({
    severity: 'warn',
    function: 'healKinLink',
    event: 'kin.link.healed',
    extra: { kinfolkId, flatId, ownerKinId: owner?.kinId ?? null, moved },
  });
  return { ownerKinId: owner?.kinId ?? null, moved };
}

/**
 * The link after any repair it needed: the Kin's own flat id, or null when it
 * has no admin record. For the write paths (a confirmed delete, a removal
 * request, the office's answer). Read paths use `resolveKinLink` alone.
 */
export async function ensureOwnFlatKinId(kinfolkId: string, kinId: string, family: Data): Promise<string | null> {
  const link = await resolveKinLink(kinfolkId, kinId, family);
  if (link.state === 'linked' && !link.contested) return link.flatId;
  if (link.state === 'none' || link.state === 'foreign') return null;
  const healed = await healKinLink(kinfolkId, link.flatId);
  const own = healed.moved.find((m) => m.kinId === kinId);
  if (own) return own.flatId;
  return healed.ownerKinId === kinId ? link.flatId : null;
}

/**
 * A flat doc of this name that a new household Kin may take as its own, or
 * null. The office can make a Kin's record first, with no household copy; the
 * Kin the household then adds under that name is the same animal. That is the
 * ONLY case a name decides anything. A record is passed over when it is
 * archived or memorialised, when its pointer names a household copy that
 * exists, or when any household Kin is stamped with it. Two Kin of one name
 * are two Kin.
 *
 * The claim is made in a transaction, so two Kin added at once under one name
 * cannot both take the record.
 */
export async function adoptUnlinkedFlatKinByName(kinfolkId: string, kinId: string, name: string | null): Promise<string | null> {
  if (!name || name.length === 0) return null;
  const firestore = db();
  const path = familyKinPathFor(kinfolkId, kinId);
  const byName = await firestore.collection('kin').where('kinfolkId', '==', kinfolkId).where('name', '==', name).get();
  const candidates = [...byName.docs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const candidate of candidates) {
    const data = (candidate.data() ?? {}) as Data;
    if (isInactiveKinStatus(data['status'])) continue;
    const pointer = text(data['familyKinPath']);
    if (pointer !== '' && pointer !== path && isFamilyKinPath(pointer)) {
      const pointed = await firestore.doc(pointer).get();
      if (pointed.exists) continue;
    }
    const stamped = await firestore.collection(`families/${kinfolkId}/kin`).where('legacyKinId', '==', candidate.id).get();
    if (stamped.docs.some((d) => d.id !== kinId)) continue;

    const flatRef = firestore.doc(`kin/${candidate.id}`);
    const adopted = await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(flatRef);
      const current = (snap.data() ?? {}) as Data;
      if (!snap.exists || isInactiveKinStatus(current['status']) || text(current['familyKinPath']) !== pointer) return false;
      tx.set(flatRef, { kinfolkId, familyKinPath: path, legacyKinId: candidate.id, ...mirrorStamp(MIRROR_ORIGIN_FAMILY) }, { merge: true });
      return true;
    });
    if (adopted) return candidate.id;
  }
  return null;
}
