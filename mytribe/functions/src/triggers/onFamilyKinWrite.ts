import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapTrigger } from '../lib/wrapTrigger';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';
import { enqueueNotification } from '../notifications/dispatcher';
import {
  MIRROR_ORIGIN_FAMILY,
  MIRROR_ORIGIN_FLAT,
  FLAT_MIRROR_FIELDS,
  pickDefined,
  projectChanged,
} from './kinMirror';
import { isInactiveKinStatus } from '../lib/kinStatus';
import { adoptUnlinkedFlatKinByName, healKinLink, resolveKinLink } from '../lib/kinLink';

type KinDoc = {
  status?: string;
  name?: string;
  species?: string;
  breed?: string;
  photoUrl?: string;
  ageYears?: number;
  feedingInstructions?: string;
  walkingInstructions?: string;
  medications?: string;
  allergies?: string;
  emergencyNotes?: string;
  sitterNotes?: string;
  /** flat mirror doc id, stamped by this trigger (symmetric link). */
  legacyKinId?: string;
  /** family doc path string, stamped by this trigger (symmetric link). */
  familyKinPath?: string;
  /** which side authored the last mirror write; guards the reverse trigger. */
  _mirrorOrigin?: string;
  /**
   * #1408: stamped by `resolveKinRemovalRequest` when the office archives this
   * Kin at the household's request. Its arrival is the office's own decision.
   */
  removalRequestId?: string;
  /**
   * #1492: stamped fresh by the admin's Archive / Restore
   * (`admin/kinArchive.ts`) on every write it makes to this copy.
   */
  officeStatusWriteId?: string;
};

/**
 * #1408. True on the one write that archives a Kin through the office's answer
 * to a removal request: the stamp is new on this write. The office made that
 * decision itself, so it needs no `pet.marked.inactive` notice about it.
 */
export function isRemovalArchiveWrite(before: KinDoc | undefined, after: KinDoc): boolean {
  return typeof after.removalRequestId === 'string'
    && after.removalRequestId !== ''
    && after.removalRequestId !== before?.removalRequestId;
}

/**
 * #1492. True on a write the admin's Archive / Restore made: its stamp is new
 * on this write. A later household write leaves the stamp as it was, so it
 * reads false and the household's own change still notifies.
 */
export function isOfficeStatusWrite(before: KinDoc | undefined, after: KinDoc): boolean {
  return typeof after.officeStatusWriteId === 'string'
    && after.officeStatusWriteId !== ''
    && after.officeStatusWriteId !== before?.officeStatusWriteId;
}
/** #1370: flat-doc fields the admin `Kin` models decode as non-null `String`. */
export const FLAT_NON_NULL_TEXT_FIELDS: readonly string[] = ['name', 'species', 'breed'];

/**
 * Builds the flat `kin/{docId}` payload from a family kin doc. Only the
 * parent-owned fields are projected here, minus `status`, which the paths below
 * translate into the flat vocabulary explicitly. Staff-owned data (AuntieOS
 * `the_411` AI summary, plus AuntieOS-only flat-doc fields like `routine`,
 * `vetInfo`) is NEVER written by this trigger. One writer per field.
 */
export function buildFlatMirrorPayload(after: KinDoc): Record<string, unknown> {
  const out = pickDefined(after as Record<string, unknown>, FLAT_MIRROR_FIELDS);
  // #1370: the portal clears these with null on the family doc (updateKin's
  // zod is `.nullable()`), but the admin Android and desktop `Kin` models
  // declare them non-null `String`, and Firestore's mapper hands a null to the
  // Kotlin setter. The flat doc gets "", the value those models already read
  // as "none". The family doc keeps its null.
  for (const k of FLAT_NON_NULL_TEXT_FIELDS) {
    if (out[k] === null) out[k] = '';
  }
  return out;
}

/**
 * #1291. Every AuntieOS reader of a pet's picture (admin web Directory and
 * KinView, admin Android, the desktop console) reads the flat doc's
 * `profilePictureUrl`, never `photoUrl`. The portal writes `photoUrl`, so a
 * photo a household uploaded reached the flat doc under a name no admin
 * screen looks at. This stamps the admin field too, but ONLY when the
 * household's photo actually changed (or arrives on create): an unrelated
 * parent edit must not overwrite a portrait an Auntie set from the media
 * gallery (`setMediaProfilePhoto`, the other writer of this field). A removed
 * photo clears to `''`, the same "cleared" value `deleteMediaFile` writes.
 */
export function buildAdminPortraitStamp(
  before: KinDoc | undefined,
  after: KinDoc,
): { profilePictureUrl: string } | Record<string, never> {
  const next = typeof after.photoUrl === 'string' ? after.photoUrl : null;
  const prev = typeof before?.photoUrl === 'string' ? before.photoUrl : null;
  if (!before) return next ? { profilePictureUrl: next } : {};
  if (next === prev) return {};
  return { profilePictureUrl: next ?? '' };
}

/**
 * Mirrors a family kin doc to the flat `kin/` collection so AuntieOS staff and
 * the the_411 join see the same pet.
 *
 *   create  -> create-or-find the flat mirror, stamp the symmetric link on BOTH
 *              docs (familyKinPath + legacyKinId), copy parent-owned fields.
 *   update  -> merge parent-owned fields into the existing flat doc.
 *   archive -> flag the flat mirror inactive (status), never hard-delete.
 *
 * Every mirror write carries `_mirrorOrigin = family` so `onFlatKinWrite` can
 * skip the echo it produces.
 */
export async function mirrorFamilyKinToFlat(
  kinfolkId: string,
  kinId: string,
  before: KinDoc | undefined,
  after: KinDoc,
): Promise<{ action: 'created' | 'updated' | 'archived' | 'skipped'; flatDocId: string | null }> {
  const firestore = db();
  const familyKinPath = `families/${kinfolkId}/kin/${kinId}`;
  const flatPayload = { ...buildFlatMirrorPayload(after), ...buildAdminPortraitStamp(before, after) };

  const afterInactive = isInactiveKinStatus(after.status);
  const beforeInactive = isInactiveKinStatus(before?.status);
  const restored = beforeInactive && !afterInactive;

  // Resolve (or create) the flat mirror (#1912, lib/kinLink.ts). A stamped
  // link counts only when the record it names is this Kin's own. A record
  // another Kin holds, or one outside the household, is never written here:
  // this Kin gets its own. Only a Kin with no record at all may take one by
  // name, and only a live record nobody else is tied to.
  let flatDocId: string | null = null;
  const link = await resolveKinLink(kinfolkId, kinId, after as Record<string, unknown>, { restoring: restored });
  if (link.state === 'linked') {
    flatDocId = link.flatId;
    if (link.contested) await healKinLink(kinfolkId, link.flatId);
  } else if (link.state === 'crossed') {
    const healed = await healKinLink(kinfolkId, link.flatId);
    const own = healed.moved.find((m) => m.kinId === kinId);
    if (own) {
      logEvent({
        severity: 'info',
        function: 'onFamilyKinWrite',
        event: 'mirror.flat.created',
        extra: { kinfolkId, kinId, flatDocId: own.flatId, relinkedFrom: link.flatId },
      });
      return { action: 'created', flatDocId: own.flatId };
    }
    if (healed.ownerKinId === kinId) flatDocId = link.flatId;
  } else {
    if (link.state === 'foreign') {
      logEvent({
        severity: 'warn',
        function: 'onFamilyKinWrite',
        event: 'mirror.flat.link-refused',
        extra: { kinfolkId, kinId },
      });
    }
    flatDocId = await adoptUnlinkedFlatKinByName(kinfolkId, kinId, after.name ?? null);
  }

  // CREATE path: no flat mirror exists yet -> create one and stamp both sides.
  if (!flatDocId) {
    // This event may be late. A Kin deleted since it fired, or one given a
    // record since (its stamp is no longer the one this event saw), must not
    // be handed a second record or written back into existence.
    const stored = await firestore.doc(familyKinPath).get();
    const storedStamp = (stored.data() as KinDoc | undefined)?.legacyKinId ?? null;
    if (!stored.exists || storedStamp !== (after.legacyKinId ?? null)) {
      logEvent({
        severity: 'info',
        function: 'onFamilyKinWrite',
        event: 'mirror.flat.skipped.stale-event',
        extra: { kinfolkId, kinId },
      });
      return { action: 'skipped', flatDocId: null };
    }
    const flatRef = firestore.collection('kin').doc();
    flatDocId = flatRef.id;
    await flatRef.set(
      {
        ...flatPayload,
        kinfolkId,
        familyKinPath,
        legacyKinId: flatDocId,
        status: afterInactive ? 'inactive' : 'active',
        _mirrorOrigin: MIRROR_ORIGIN_FAMILY,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    // Stamp the symmetric link back onto the family doc. This write re-enters
    // onFamilyKinWrite, but the change-diff guard there (link already present)
    // makes the second pass a no-op for the flat side.
    await firestore.doc(familyKinPath).set(
      { legacyKinId: flatDocId, familyKinPath },
      { merge: true },
    );
    logEvent({
      severity: 'info',
      function: 'onFamilyKinWrite',
      event: 'mirror.flat.created',
      extra: { kinfolkId, kinId, flatDocId },
    });
    return { action: 'created', flatDocId };
  }

  const flatRef = firestore.collection('kin').doc(flatDocId);

  // ARCHIVE path: status crossed into an inactive value -> mark the mirror
  // inactive (soft), do not clobber parent-owned descriptive fields.
  if (afterInactive && !beforeInactive) {
    await flatRef.set(
      {
        // #1408: `archived` is the admin's own spelling (setKinArchived), and
        // the office's removal-request archive writes it on both copies. Do
        // not downgrade it to `inactive` here, or the admin profile would stop
        // saying archived the moment this trigger ran.
        status: after.status === 'archived' ? 'archived' : 'inactive',
        familyKinPath,
        legacyKinId: flatDocId,
        _mirrorOrigin: MIRROR_ORIGIN_FAMILY,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    await ensureFamilyLink(familyKinPath, after, flatDocId);
    logEvent({
      severity: 'info',
      function: 'onFamilyKinWrite',
      event: 'mirror.flat.archived',
      extra: { kinfolkId, kinId, flatDocId },
    });
    return { action: 'archived', flatDocId };
  }

  // UPDATE path: skip when no parent-owned field actually changed (loop guard).
  if (!restored && !projectChanged(before as Record<string, unknown> | undefined, after as Record<string, unknown>, FLAT_MIRROR_FIELDS)) {
    return { action: 'skipped', flatDocId };
  }

  await flatRef.set(
    {
      ...flatPayload,
      kinfolkId,
      familyKinPath,
      legacyKinId: flatDocId,
      ...(restored ? { status: 'active' } : {}),
      _mirrorOrigin: MIRROR_ORIGIN_FAMILY,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  await ensureFamilyLink(familyKinPath, after, flatDocId);
  logEvent({
    severity: 'info',
    function: 'onFamilyKinWrite',
    event: 'mirror.flat.updated',
    extra: { kinfolkId, kinId, flatDocId },
  });
  return { action: 'updated', flatDocId };
}

/** Stamps legacyKinId/familyKinPath onto the family doc only when missing. */
async function ensureFamilyLink(
  familyKinPath: string,
  after: KinDoc,
  flatDocId: string,
): Promise<void> {
  if (after.legacyKinId === flatDocId && after.familyKinPath === familyKinPath) return;
  await db().doc(familyKinPath).set(
    { legacyKinId: flatDocId, familyKinPath },
    { merge: true },
  );
}

/**
 * Watches `families/{kinfolkId}/kin/{kinId}`.
 *   - any write              -> `pets.updated` (debounced 30min)
 *   - status -> inactive set -> `pet.marked.inactive` (trigger, business)
 *   - any write              -> mirror parent-owned fields to flat `kin/{docId}`
 */
export const onFamilyKinWrite = onDocumentWritten(
  {
    document: 'families/{kinfolkId}/kin/{kinId}',
    region: 'us-central1',
    secrets: ['SENTRY_DSN'],
  },
  wrapTrigger('onFamilyKinWrite', async (event) => {
    const kinfolkId = event.params.kinfolkId;
    const kinId = event.params.kinId;
    const before = event.data?.before.data() as KinDoc | undefined;
    const after = event.data?.after.data() as KinDoc | undefined;
    if (!after) return;

    // Mirror to the flat AuntieOS kin/ collection. Best-effort: a mirror fault
    // must not block the kinfolk-facing notification below.
    try {
      await mirrorFamilyKinToFlat(kinfolkId, kinId, before, after);
    } catch (err) {
      logEvent({
        severity: 'warn',
        function: 'onFamilyKinWrite',
        event: 'mirror.flat.failed',
        extra: { kinfolkId, kinId, err: (err as Error)?.message },
      });
    }

    const recipientUid = await resolveKinfolkUid(kinfolkId);
    const dispatch = async (key: string, extra: Record<string, unknown> = {}) => {
      try {
        await enqueueNotification({
          key: key as never,
          recipientUid: recipientUid ?? '',
          data: { kinfolkId, kinId, ...extra },
          // #832: one write is one event. The Firestore event id is stable across
          // redeliveries of this write and new for the next one, so a pet marked
          // inactive, restored and marked inactive again is three notifications'
          // worth of events, not one. (pets.updated is debounced and exempt.)
          dedupeKey: `kin:${kinfolkId}:${kinId}:${key}:event:${event.id}`,
        });
      } catch (err) {
        logEvent({
          severity: 'warn',
          function: 'onFamilyKinWrite',
          event: 'notification.dispatch.failed',
          extra: { kinfolkId, kinId, key, err: (err as Error)?.message },
        });
      }
    };

    const beforeStatus = before?.status ?? null;
    const afterStatus = after.status ?? null;
    const transitionedToInactive =
      afterStatus !== beforeStatus &&
      isInactiveKinStatus(afterStatus) &&
      !isInactiveKinStatus(beforeStatus);

    if (transitionedToInactive) {
      if (isRemovalArchiveWrite(before, after)) {
        logEvent({
          severity: 'debug',
          function: 'onFamilyKinWrite',
          event: 'pet.marked.inactive.suppressed.removal-archive',
          extra: { kinfolkId, kinId, removalRequestId: after.removalRequestId },
        });
        return;
      }
      // #1492: the office archived it from the admin; "Kinfolk marked a pet
      // as inactive" would tell the office about its own decision.
      if (isOfficeStatusWrite(before, after)) {
        logEvent({
          severity: 'debug',
          function: 'onFamilyKinWrite',
          event: 'pet.marked.inactive.suppressed.office-archive',
          extra: { kinfolkId, kinId },
        });
        return;
      }
      await dispatch('pet.marked.inactive', { kinName: after.name ?? null, status: afterStatus });
      return;
    }

    // WARNING-27: do NOT spam the kinfolk with `pets.updated` when the write is
    // the echo of a STAFF edit on the flat doc (sex/weight/vetInfo etc. flow
    // flat -> family carrying `_mirrorOrigin = flat`), nor when nothing the
    // parent can actually see changed. Only a real change to a parent-visible
    // field should notify the kinfolk.
    if (after._mirrorOrigin === MIRROR_ORIGIN_FLAT) {
      logEvent({
        severity: 'debug',
        function: 'onFamilyKinWrite',
        event: 'pets.updated.suppressed.flat-echo',
        extra: { kinfolkId, kinId },
      });
      return;
    }
    if (!projectChanged(before as Record<string, unknown> | undefined, after as Record<string, unknown>, FLAT_MIRROR_FIELDS)) {
      logEvent({
        severity: 'debug',
        function: 'onFamilyKinWrite',
        event: 'pets.updated.suppressed.no-visible-change',
        extra: { kinfolkId, kinId },
      });
      return;
    }

    await dispatch('pets.updated');
  }),
);
