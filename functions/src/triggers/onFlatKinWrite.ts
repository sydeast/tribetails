import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapTrigger } from '../lib/wrapTrigger';
import {
  MIRROR_ORIGIN_FAMILY,
  MIRROR_ORIGIN_FLAT,
  STAFF_EDITABLE_FIELDS,
  pickDefined,
  projectChanged,
} from './kinMirror';

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
 * never clobber what the parent just typed in the portal.
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

  const payload = pickDefined(after, STAFF_EDITABLE_FIELDS);
  if (Object.keys(payload).length === 0) {
    return { action: 'skipped', reason: 'empty-projection' };
  }

  await db().doc(familyKinPath).set(
    {
      ...payload,
      _mirrorOrigin: MIRROR_ORIGIN_FLAT,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
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
