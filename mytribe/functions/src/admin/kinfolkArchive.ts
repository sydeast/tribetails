import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { auditActorPayload, resolveAuditActor } from '../lib/auditActor';
import { TRIBETAILS_CORS } from '../lib/cors';
import { validateResponse } from '../lib/callableResponse';

/**
 * #2161. Archive or restore a Kinfolk household: the one way any client does
 * either. Operator ruling 2026-11-13: only the owner archives or restores a
 * household.
 *
 * Owner-only. The name is not on `lib/auntieAccess.ts`'s list, so
 * `wrapAdminCallable` refuses an Auntie, a household and a sandbox test admin
 * before the handler runs. `firestore.rules` refuses every client a direct
 * change to the archive fields (`status` into or out of `archived`, and
 * `archivedAt` / `archivedReason` / `archivedBy`), so this callable is the only
 * writer and its Activity Log line cannot be skipped.
 *
 * The fields are the ones the admin clients wrote directly before:
 *
 *   archive  status `archived`, `archivedAt` (ISO instant, the type the
 *            Kotlin clients have always stored), `archivedReason` (optional,
 *            trimmed), `archivedBy` (the caller's uid), and
 *            `statusBeforeArchive`: the status the household held (#1958).
 *   restore  the status in `statusBeforeArchive` when it is one a household
 *            can be set to (active, prospect, inactive), otherwise `active`,
 *            and the four archive fields cleared to "" so the readers that
 *            expect them keep the same shape. A household archived before
 *            #1958 has no stored status and restores to `active`, as it did.
 *
 * Archiving an archived household, or restoring one that is not archived,
 * changes nothing and writes no Activity Log line (`changed: false`).
 *
 * Writes the `ARCHIVE_KINFOLK` / `RESTORE_KINFOLK` Activity Log entry, once,
 * for every client. The clients no longer write their own.
 */

export const SetKinfolkArchivedArgs = z.object({
  kinfolkId: z.string().trim().min(1).max(200),
  archived: z.boolean(),
  /** Why, on an archive. Optional; ignored on a restore. */
  reason: z.string().max(500).optional(),
});

export const SetKinfolkArchivedResult = z
  .object({
    ok: z.literal(true),
    archived: z.boolean(),
    /** The status now on `kinfolk/{id}`. */
    status: z.string(),
    /** False when the household was already in the asked-for state. */
    changed: z.boolean(),
  })
  .strict();

export const KINFOLK_ARCHIVED_STATUS = 'archived';
/** The status a restore falls back to when no usable prior status is stored. */
export const KINFOLK_RESTORED_STATUS = 'active';
/** #1958: where an archive keeps the status the household held. */
export const KINFOLK_STATUS_BEFORE_ARCHIVE = 'statusBeforeArchive';
/** The statuses a household can be set to, and so restored to (the clients' picker). */
export const KINFOLK_RESTORABLE_STATUSES: readonly string[] = ['active', 'prospect', 'inactive'];

/** #1958: the status an archive keeps, lower-cased. Blank or unknown keeps `active`. */
export function kinfolkStatusToKeep(current: string): string {
  const s = current.trim().toLowerCase();
  return KINFOLK_RESTORABLE_STATUSES.includes(s) ? s : KINFOLK_RESTORED_STATUS;
}

/**
 * #1958: the status a restore gives back. The kept prior status when it is one
 * a household can be set to (any case, any surrounding spaces), otherwise
 * `active`: a household archived before the prior status was kept has none.
 */
export function restoredKinfolkStatus(doc: Record<string, unknown>): string {
  const raw = doc[KINFOLK_STATUS_BEFORE_ARCHIVE];
  return kinfolkStatusToKeep(typeof raw === 'string' ? raw : '');
}

function parseArgs(data: unknown): z.infer<typeof SetKinfolkArchivedArgs> {
  try {
    return SetKinfolkArchivedArgs.parse(data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'setKinfolkArchived validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }
}

function householdName(doc: Record<string, unknown>): string {
  const part = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  return [part(doc['firstName']), part(doc['lastName'])].filter((s) => s !== '').join(' ');
}

export async function setKinfolkArchivedHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof SetKinfolkArchivedResult>> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = parseArgs(req.data);
  const reason = (args.reason ?? '').trim();

  const ref = db().doc(`kinfolk/${args.kinfolkId}`);

  const outcome = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'That Kinfolk household no longer exists.');
    const data = (snap.data() ?? {}) as Record<string, unknown>;
    const current = typeof data['status'] === 'string' ? data['status'] : '';
    // Any spelling of archived counts, as it does in the rules and the clients.
    const isArchived = current.trim().toLowerCase() === KINFOLK_ARCHIVED_STATUS;
    const name = householdName(data);

    if (args.archived === isArchived) {
      return { changed: false, status: current, name };
    }

    if (args.archived) {
      tx.set(
        ref,
        {
          status: KINFOLK_ARCHIVED_STATUS,
          archivedAt: new Date().toISOString(),
          archivedReason: reason,
          archivedBy: uid,
          [KINFOLK_STATUS_BEFORE_ARCHIVE]: kinfolkStatusToKeep(current),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return { changed: true, status: KINFOLK_ARCHIVED_STATUS, name };
    }

    const restored = restoredKinfolkStatus(data);
    tx.set(
      ref,
      {
        status: restored,
        archivedAt: '',
        archivedReason: '',
        archivedBy: '',
        [KINFOLK_STATUS_BEFORE_ARCHIVE]: '',
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return { changed: true, status: restored, name };
  });

  if (outcome.changed) {
    // After the commit and wrapped: the archive stands whether or not the entry
    // lands, the same order `setKinArchived` uses.
    try {
      const actor = await resolveAuditActor(req.auth, 'setKinfolkArchived', args.kinfolkId);
      await writeAuditEntry({
        status: 'SUCCESS',
        event: args.archived ? AUDIT_EVENTS.ARCHIVE_KINFOLK : AUDIT_EVENTS.RESTORE_KINFOLK,
        severity: 'info',
        actorRole: actor.actorRole,
        actorUid: uid,
        targetUid: args.kinfolkId,
        targetCollection: 'kinfolk',
        familyId: args.kinfolkId,
        // Loaded here, like `setKinArchived` does, so the words module stays out
        // of every function's cold start.
        description: (await import('../lib/activityWords.js')).kinfolkArchivedWords(
          args.archived,
          outcome.name,
          args.archived ? reason : '',
        ),
        payload: {
          kinfolkId: args.kinfolkId,
          status: outcome.status,
          ...(args.archived && reason !== '' ? { reason } : {}),
          ...auditActorPayload(actor),
        },
      });
    } catch (err) {
      logEvent({
        severity: 'warn',
        function: 'setKinfolkArchived',
        event: 'audit.write.failed',
        uid,
        errorMessage: (err as Error)?.message,
      });
    }
  }

  logEvent({
    severity: 'info',
    function: 'setKinfolkArchived',
    event: args.archived ? 'admin.kinfolk.archived' : 'admin.kinfolk.restored',
    uid,
    extra: { kinfolkId: args.kinfolkId, changed: outcome.changed },
  });

  return validateResponse('setKinfolkArchived', SetKinfolkArchivedResult, {
    ok: true,
    archived: args.archived,
    status: outcome.status,
    changed: outcome.changed,
  });
}

export const setKinfolkArchived = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('setKinfolkArchived', setKinfolkArchivedHandler),
);
