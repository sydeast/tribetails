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
};

/**
 * Builds the flat `kin/{docId}` payload from a family kin doc. Only the
 * parent-owned fields are projected here, minus `status`, which the paths below
 * translate into the flat vocabulary explicitly. Staff-owned data (AuntieOS
 * `the_411` AI summary, plus AuntieOS-only flat-doc fields like `routine`,
 * `vetInfo`) is NEVER written by this trigger. One writer per field.
 */
export function buildFlatMirrorPayload(after: KinDoc): Record<string, unknown> {
  return pickDefined(after as Record<string, unknown>, FLAT_MIRROR_FIELDS);
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
  const flatPayload = buildFlatMirrorPayload(after);

  // Resolve (or create) the flat mirror. Prefer the stamped link; fall back to
  // a kinfolkId + name lookup so a pet AuntieOS already created flat is reused
  // instead of duplicated.
  let flatDocId = typeof after.legacyKinId === 'string' ? after.legacyKinId : null;
  if (!flatDocId) {
    const found = await findFlatMirror(kinfolkId, familyKinPath, after.name ?? null);
    flatDocId = found;
  }

  const afterInactive = isInactiveKinStatus(after.status);

  // CREATE path: no flat mirror exists yet -> create one and stamp both sides.
  if (!flatDocId) {
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
  const beforeInactive = isInactiveKinStatus(before?.status);
  if (afterInactive && !beforeInactive) {
    await flatRef.set(
      {
        status: 'inactive',
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
  const restored = beforeInactive && !afterInactive;
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
 * Finds an existing flat mirror for this family pet without a stamped link.
 * Matches on familyKinPath first (idempotent re-runs), then falls back to a
 * kinfolkId + name match so an AuntieOS-created flat doc is adopted rather than
 * duplicated. Returns null if no candidate is found.
 */
async function findFlatMirror(
  kinfolkId: string,
  familyKinPath: string,
  name: string | null,
): Promise<string | null> {
  const firestore = db();
  const byPath = await firestore
    .collection('kin')
    .where('familyKinPath', '==', familyKinPath)
    .limit(1)
    .get();
  if (byPath.docs.length > 0) return byPath.docs[0].id;

  if (name && name.length > 0) {
    const byName = await firestore
      .collection('kin')
      .where('kinfolkId', '==', kinfolkId)
      .where('name', '==', name)
      .limit(1)
      .get();
    if (byName.docs.length > 0) return byName.docs[0].id;
  }
  return null;
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
      await dispatch('pet.marked.inactive', { kinName: after.name ?? null, status: afterStatus });
      return;
    }

    // WARNING-27: do NOT spam the kinfolk with `pets.updated` when the write is
    // the echo of a STAFF edit on the flat doc (officeNotes/vetInfo etc. flow
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
