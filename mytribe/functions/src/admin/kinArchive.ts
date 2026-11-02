import { randomUUID } from 'crypto';
import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import { validateResponse } from '../lib/callableResponse';
import {
  OFFICE_STATUS_WRITE_ID,
  STATUS_BEFORE_ARCHIVE,
  archiveStash,
  flatStatusFor,
  isFamilyKinPath,
  restoredFamilyStatus,
} from '../lib/kinArchive';

/**
 * #1492. The admin's Archive / Restore control on a Kin (web `KinEdit.tsx`,
 * Android `EditKinScreen`), moved off a direct client write of `status` on the
 * flat `kin/{id}` doc.
 *
 * That direct write never reached the household: `status` does not travel flat
 * to family (`triggers/kinMirror.ts`), and the portal roster reads the family
 * copy. An office archive left the Kin on the household's roster, and a
 * Restore of a Kin the office archived through a removal request (#1408, which
 * writes both copies) left it hidden from them for good.
 *
 * So this writes both copies in one transaction, the way
 * `resolveKinRemovalRequest` does:
 *
 *   archive  flat `archived`; family `archived`, a memorial stashed in
 *            `statusBeforeArchive` (`lib/kinArchive.ts`).
 *   restore  family back to `active`, or to `noLongerWithUs` when that was
 *            stashed, and only when the family copy is hidden from the portal:
 *            a status the household set is never overwritten. Flat goes to
 *            `active` (`inactive` for a memorial, the flat spelling).
 *            `removalRequestId` is cleared, so a later removal-request archive
 *            of the same Kin (its request id is deterministic) is again a new
 *            stamp to `onFamilyKinWrite`.
 *
 * Every family write carries a fresh `officeStatusWriteId`, which tells
 * `onFamilyKinWrite` the office made this change itself, so it sends the office
 * no `pet.marked.inactive` notice ("Kinfolk marked a pet as inactive") about
 * its own archive.
 *
 * A Kin with no household copy (an admin-only pet, or a link to a doc the
 * portal never wrote) is archived on the flat doc alone, as before.
 *
 * Owner-only: archiving is destructive, which `lib/auntieAccess.ts` rule 6
 * keeps from an Auntie.
 *
 * #1493: writes the `ARCHIVE_KIN` / `RESTORE_KIN` Activity Log entry, once,
 * for every client.
 */

export const SetKinArchivedArgs = z.object({
  /** The flat `kin/{id}` doc id, the one every admin screen opens. */
  kinId: z.string().trim().min(1).max(200),
  archived: z.boolean(),
});

export const SetKinArchivedResult = z
  .object({
    ok: z.literal(true),
    archived: z.boolean(),
    /** The status now on the flat doc. */
    flatStatus: z.string(),
    /** The status now on the household's copy, or null when there is none. */
    familyStatus: z.string().nullable(),
    /** True when this call changed the household's copy. */
    familyUpdated: z.boolean(),
  })
  .strict();

function parseArgs(data: unknown): z.infer<typeof SetKinArchivedArgs> {
  try {
    return SetKinArchivedArgs.parse(data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'setKinArchived validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }
}

export async function setKinArchivedHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof SetKinArchivedResult>> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = parseArgs(req.data);

  const firestore = db();
  const flatRef = firestore.doc(`kin/${args.kinId}`);
  const outcome = await firestore.runTransaction(async (tx) => {
    const flatSnap = await tx.get(flatRef);
    if (!flatSnap.exists) throw new HttpsError('not-found', 'That Kin no longer exists.');
    const flat = (flatSnap.data() ?? {}) as Record<string, unknown>;

    const familyPath = isFamilyKinPath(flat['familyKinPath']) ? flat['familyKinPath'] : null;
    const familyRef = familyPath ? firestore.doc(familyPath) : null;
    const familySnap = familyRef ? await tx.get(familyRef) : null;
    const family = familySnap?.exists ? ((familySnap.data() ?? {}) as Record<string, unknown>) : null;
    // A household copy linked to a different flat doc is not this Kin's.
    const linked =
      family !== null &&
      (typeof family['legacyKinId'] !== 'string' || family['legacyKinId'] === '' || family['legacyKinId'] === args.kinId);

    const officeStamp = {
      [OFFICE_STATUS_WRITE_ID]: randomUUID(),
      updatedAt: FieldValue.serverTimestamp(),
      updatedByUid: uid,
    };

    let flatStatus: string;
    let familyStatus: string | null = family && typeof family['status'] === 'string' ? family['status'] : null;
    let familyUpdated = false;

    if (args.archived) {
      flatStatus = 'archived';
      if (familyRef && family && linked && family['status'] !== 'archived') {
        tx.set(familyRef, { status: 'archived', ...archiveStash(family), ...officeStamp }, { merge: true });
        familyStatus = 'archived';
        familyUpdated = true;
      }
    } else {
      const restored = family && linked ? restoredFamilyStatus(family) : null;
      // The flat copy follows what the household's copy now says: a memorial
      // the household set while the flat doc sat archived reads `inactive`.
      const householdSays = restored ?? (family && linked && family['status'] === 'noLongerWithUs' ? 'noLongerWithUs' : 'active');
      flatStatus = flatStatusFor(householdSays);
      if (familyRef && family && linked && (restored || typeof family['removalRequestId'] === 'string')) {
        tx.set(
          familyRef,
          {
            ...(restored ? { status: restored } : {}),
            removalRequestId: FieldValue.delete(),
            [STATUS_BEFORE_ARCHIVE]: FieldValue.delete(),
            ...officeStamp,
          },
          { merge: true },
        );
        if (restored) familyStatus = restored;
        familyUpdated = true;
      }
    }

    tx.set(flatRef, { status: flatStatus, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return {
      flatStatus,
      familyStatus,
      familyUpdated,
      kinfolkId: typeof flat['kinfolkId'] === 'string' ? flat['kinfolkId'] : null,
      kinName: typeof flat['name'] === 'string' ? flat['name'] : null,
      familyPath,
    };
  });

  // #1493: one Activity Log entry per archive or restore, whichever client
  // asked. Admin Android used to write it itself and web wrote nothing; the
  // Android client entry is gone, so there is exactly one. After the commit
  // and wrapped: the archive stands whether or not the entry lands.
  await writeAuditEntry({
    status: 'SUCCESS',
    event: args.archived ? AUDIT_EVENTS.ARCHIVE_KIN : AUDIT_EVENTS.RESTORE_KIN,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetUid: args.kinId,
    targetCollection: 'kin',
    ...(outcome.kinfolkId ? { familyId: outcome.kinfolkId } : {}),
    description: `${args.archived ? 'Archived' : 'Restored'} kin ${outcome.kinName ?? args.kinId}`,
    payload: {
      kinId: args.kinId,
      kinfolkId: outcome.kinfolkId,
      flatStatus: outcome.flatStatus,
      familyStatus: outcome.familyStatus,
      familyUpdated: outcome.familyUpdated,
    },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'setKinArchived',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });
  logEvent({
    severity: 'info',
    function: 'setKinArchived',
    event: args.archived ? 'admin.kin.archived' : 'admin.kin.restored',
    uid,
    extra: { kinId: args.kinId, ...outcome },
  });

  return validateResponse('setKinArchived', SetKinArchivedResult, {
    ok: true,
    archived: args.archived,
    flatStatus: outcome.flatStatus,
    familyStatus: outcome.familyStatus,
    familyUpdated: outcome.familyUpdated,
  });
}

export const setKinArchived = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('setKinArchived', setKinArchivedHandler),
);
