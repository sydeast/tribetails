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
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';
import { enqueueNotification } from '../notifications/dispatcher';
import {
  KIN_REMOVAL_REQUESTS,
  kinRemovalRequestDto,
  type KinRemovalRequestDto,
} from '../lib/kinRemovalRequest';
import { archiveStash } from '../lib/kinArchive';
import { ensureOwnFlatKinId } from '../lib/kinLink';

/**
 * #1408. The office's half of a household's request to remove a Kin with
 * history (`portal/kinWrites.ts#requestKinRemovalHandler`).
 *
 * ARCHIVE IS THE EXISTING ARCHIVE. The admin's Archive control on a Kin
 * (`admin/kinArchive.ts#setKinArchived`, #1492) writes `status: 'archived'`
 * on both copies. That spelling is what the portal hides
 * (`lib/kinStatus.ts#isPortalHiddenKinStatus`), but the flat status never
 * travels to the family doc (`kinMirror.ts`, status is parent-owned), so the
 * Kin would stay on the household's roster after the office said yes. So this
 * writes the same `archived` on BOTH copies, in the same transaction that
 * closes the request. Nothing is deleted: visits, invoices, KinTales, photos
 * and records all stay where they are, which is the whole point of archiving.
 * `removalRequestId` on the family doc tells `onFamilyKinWrite` this was the
 * office's own decision, so it keeps the `archived` spelling on the mirror and
 * does not send the office a `pet.marked.inactive` notice about it.
 *
 * DECLINE changes no Kin. The household hears `kin.removal.declined` with the
 * optional note, and may ask again.
 *
 * Owner-only: archiving is destructive, which `lib/auntieAccess.ts` rule 6
 * keeps from an Auntie. The queue read is hers too (rule 5, a kin record).
 */

const DECISION = z.enum(['archive', 'decline']);

export const ResolveArgs = z.object({
  requestId: z.string().min(1).max(300),
  decision: DECISION,
  /** Optional words for the household. Blank is the same as none. */
  note: z.string().trim().max(500).optional(),
});

const RequestDto = z
  .object({
    id: z.string().min(1),
    kinfolkId: z.string(),
    kinId: z.string(),
    flatKinId: z.string().nullable(),
    kinName: z.string().nullable(),
    reason: z.string().nullable(),
    status: z.enum(['pending', 'archived', 'declined']),
    requestedAtMs: z.number().nullable(),
    resolvedAtMs: z.number().nullable(),
    resolutionNote: z.string().nullable(),
  })
  .strict();

export const ResolveResult = z
  .object({
    ok: z.literal(true),
    decision: DECISION,
    request: RequestDto,
    /** True when the flat `kin/{id}` doc was set to archived. */
    flatArchived: z.boolean(),
    /** True when the household's own copy was set to archived. */
    familyArchived: z.boolean(),
    /** False when the household's notice could not be queued (the decision still stands). */
    householdNotified: z.boolean(),
  })
  .strict();

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown, fn: string): z.infer<T> {
  try {
    return schema.parse(data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', `${fn} validation failed`, {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }
}

export async function resolveKinRemovalRequestHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof ResolveResult>> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = parse(ResolveArgs, req.data, 'resolveKinRemovalRequest');
  const note = args.note && args.note.length > 0 ? args.note : null;

  const firestore = db();
  const ref = firestore.doc(`${KIN_REMOVAL_REQUESTS}/${args.requestId}`);

  // #1912: the admin record to archive is the one that is this Kin's own NOW
  // (lib/kinLink.ts), not the id the request was stamped with when it was
  // sent. A request sent while the Kin was tied to another Kin's record
  // carries that other record's id; the link is repaired first, so the answer
  // lands on the right Kin and the request names the right record after it.
  const pending = await ref.get();
  const asked = (pending.data() ?? {}) as Record<string, unknown>;
  let ownFlatId: string | null = null;
  if (pending.exists && asked['status'] === 'pending' && typeof asked['kinfolkId'] === 'string' && typeof asked['kinId'] === 'string') {
    const familySnap = await firestore.doc(`families/${asked['kinfolkId']}/kin/${asked['kinId']}`).get();
    if (familySnap.exists) {
      ownFlatId = await ensureOwnFlatKinId(asked['kinfolkId'], asked['kinId'], (familySnap.data() ?? {}) as Record<string, unknown>);
    }
  }

  const outcome = await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'That removal request no longer exists.');
    const data = (snap.data() ?? {}) as Record<string, unknown>;
    if (data['status'] !== 'pending') {
      throw new HttpsError('failed-precondition', 'This removal request has already been answered.');
    }
    const kinfolkId = typeof data['kinfolkId'] === 'string' ? data['kinfolkId'] : '';
    const kinId = typeof data['kinId'] === 'string' ? data['kinId'] : '';

    let flatArchived = false;
    let familyArchived = false;
    if (args.decision === 'archive') {
      const familyRef = kinfolkId && kinId ? firestore.doc(`families/${kinfolkId}/kin/${kinId}`) : null;
      const familySnap = familyRef ? await tx.get(familyRef) : null;
      const family = (familySnap?.data() ?? {}) as Record<string, unknown>;
      const flatRef = ownFlatId ? firestore.doc(`kin/${ownFlatId}`) : null;
      const flatSnap = flatRef ? await tx.get(flatRef) : null;

      if (flatRef && flatSnap?.exists) {
        tx.set(flatRef, { status: 'archived', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        flatArchived = true;
      }
      if (familyRef && familySnap?.exists) {
        tx.set(
          familyRef,
          {
            status: 'archived',
            // #1492: a memorial is remembered, so the admin's Restore can put it back.
            ...archiveStash(family),
            removalRequestId: args.requestId,
            updatedAt: FieldValue.serverTimestamp(),
            updatedByUid: uid,
          },
          { merge: true },
        );
        familyArchived = true;
      }
    }

    tx.set(
      ref,
      {
        status: args.decision === 'archive' ? 'archived' : 'declined',
        ...(ownFlatId ? { flatKinId: ownFlatId } : {}),
        resolvedByUid: uid,
        resolvedAt: FieldValue.serverTimestamp(),
        resolutionNote: note,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return { kinfolkId, kinId, kinName: typeof data['kinName'] === 'string' ? data['kinName'] : null, flatArchived, familyArchived };
  });

  const saved = await ref.get();
  const request = kinRemovalRequestDto(args.requestId, (saved.data() ?? {}) as Record<string, unknown>);

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.KIN_REMOVAL_REQUEST_RESOLVED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetCollection: KIN_REMOVAL_REQUESTS,
    familyId: outcome.kinfolkId,
    description: `Operator ${args.decision === 'archive' ? 'archived' : 'declined to remove'} ${outcome.kinName ?? 'a Kin'} at the household's request`,
    payload: {
      requestId: args.requestId,
      kinfolkId: outcome.kinfolkId,
      kinId: outcome.kinId,
      flatKinId: request.flatKinId,
      decision: args.decision,
      note,
      flatArchived: outcome.flatArchived,
      familyArchived: outcome.familyArchived,
    },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'resolveKinRemovalRequest',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  // After the commit and wrapped: the decision stands whether or not the
  // notice can be queued, and the result says which.
  const key = args.decision === 'archive' ? 'kin.removal.archived' : 'kin.removal.declined';
  let householdNotified = false;
  try {
    const recipientUid = await resolveKinfolkUid(outcome.kinfolkId);
    await enqueueNotification({
      key,
      recipientUid: recipientUid ?? '',
      data: {
        kinfolkId: outcome.kinfolkId,
        kinId: outcome.kinId,
        kinName: outcome.kinName,
        note,
        requestId: args.requestId,
      },
      actorUid: uid,
      targetType: 'kinfolk',
      targetId: outcome.kinfolkId,
      dedupeKey: `kinRemoval:${args.requestId}:${key}:${request.resolvedAtMs ?? 'unstamped'}`,
    });
    householdNotified = true;
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'resolveKinRemovalRequest',
      event: 'notification.dispatch.failed',
      uid,
      extra: { requestId: args.requestId, key, err: (err as Error)?.message },
    });
  }

  logEvent({
    severity: 'info',
    function: 'resolveKinRemovalRequest',
    event: 'admin.kin.removal_resolved',
    uid,
    extra: { requestId: args.requestId, decision: args.decision, ...outcome, householdNotified },
  });

  return validateResponse('resolveKinRemovalRequest', ResolveResult, {
    ok: true,
    decision: args.decision,
    request,
    flatArchived: outcome.flatArchived,
    familyArchived: outcome.familyArchived,
    householdNotified,
  });
}

// ── The queue ────────────────────────────────────────────────────────────────

export const ListArgs = z.object({
  /** One Kin's pending request (the admin Kin profile), by its flat `kin/{id}` id. */
  flatKinId: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const ListResult = z
  .object({
    requests: z.array(RequestDto),
  })
  .strict();

/**
 * Every removal request still waiting on the office, oldest first: the
 * household that has waited longest is the one to answer. With `flatKinId`,
 * only that Kin's (the band on the Kin's admin profile). Both reads are
 * single-field equality queries, so no composite index is needed.
 */
export async function listKinRemovalRequestsHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof ListResult>> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = parse(ListArgs, req.data ?? {}, 'listKinRemovalRequests');

  const collection = db().collection(KIN_REMOVAL_REQUESTS);
  const snap = args.flatKinId
    ? await collection.where('flatKinId', '==', args.flatKinId).get()
    : await collection.where('status', '==', 'pending').get();

  const requests: KinRemovalRequestDto[] = snap.docs
    .map((d) => kinRemovalRequestDto(d.id, (d.data() ?? {}) as Record<string, unknown>))
    .filter((r) => r.status === 'pending')
    .sort((a, b) => (a.requestedAtMs ?? 0) - (b.requestedAtMs ?? 0))
    .slice(0, args.limit ?? 50);

  return validateResponse('listKinRemovalRequests', ListResult, { requests });
}

export const resolveKinRemovalRequest = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('resolveKinRemovalRequest', resolveKinRemovalRequestHandler),
);

export const listKinRemovalRequests = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('listKinRemovalRequests', listKinRemovalRequestsHandler),
);
