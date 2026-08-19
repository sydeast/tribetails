import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import { validateResponse } from '../lib/callableResponse';
import { pendingAskOn } from '../portal/requestBookingCancellation';

/**
 * The office's half of the kinfolk cancellation ask (issue #438).
 *
 * `portal/requestBookingCancellation` has stamped `cancelRequestedAt` on the
 * visit since 2026-07-02 and NOTHING has ever read it back: no queue, no badge,
 * no list. The portal told the household their request was sent, the office
 * never saw it, and the visit stayed on the schedule. These two callables are
 * where a human finally rules on one, deliberately shaped like
 * `admin/rescheduleRequests` so the two request types are one queue in the UI
 * rather than two half-features.
 *
 * ACCEPTING CANCELS THE VISIT, and it writes BOTH records. The kinCares doc
 * under `families/{kinfolkId}/bookings/{batchId}/kinCares` is what the portal
 * reads; the flat `kin_care_sessions/{sessionId}` row is what the admin's
 * schedule reads. Writing only one of the pair is the trap PR #436 documents
 * for reschedule -- the household and the office then disagree about a visit
 * that one of them thinks is cancelled -- so the accept path mirrors the status
 * onto the session exactly as `batchUpdateBookings` does for its own CANCEL.
 *
 * THE JULY BACKLOG. Requests written before this issue carry `cancelRequestedAt`
 * and no `cancelRequestStatus`, because the status field arrives with #438.
 * Everything here reads a bare stamp as pending (`pendingAskOn`), so those asks
 * appear in the queue and can be resolved. A status-equality query would have
 * hidden exactly the requests the issue is about.
 */

const DECISION = z.enum(['accept', 'decline']);

export const Args = z.object({
  kinfolkId: z.string().min(1).max(200),
  batchId: z.string().min(1).max(200),
  visitId: z.string().min(1).max(200),
  decision: DECISION,
  /** Shown to the household beside the decision. Required for a decline: "no" with no reason is not an answer. */
  note: z.string().trim().max(500).optional(),
});

export const Result = z
  .object({
    ok: z.literal(true),
    visitId: z.string().min(1),
    decision: DECISION,
    /** The visit's status after the decision: `cancelled` on an accept, unchanged on a decline. */
    status: z.string().nullable(),
    /** True when the flat kin_care_sessions row was cancelled alongside the visit. */
    sessionUpdated: z.boolean(),
    /**
     * True when accepting also closed a reschedule request that was still
     * waiting on this same visit. A cancelled visit has no time left to argue
     * about, and leaving the ask open would strand it in the reschedule queue.
     */
    rescheduleRequestClosed: z.boolean(),
  })
  .strict();

export async function resolveBookingCancellationRequestHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof Result>> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'resolveBookingCancellationRequest validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }
  if (args.decision === 'decline' && !args.note) {
    throw new HttpsError(
      'invalid-argument',
      'Say why the visit is staying on the schedule, so the household knows where they stand.',
    );
  }

  const visitRef = db().doc(
    `families/${args.kinfolkId}/bookings/${args.batchId}/kinCares/${args.visitId}`,
  );
  const snap = await visitRef.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Visit not found.');
  const data = snap.data() as {
    status?: string;
    cancelRequestedAt?: unknown;
    cancelRequestStatus?: unknown;
    rescheduleRequestStatus?: string | null;
    sessionId?: string | null;
  };

  if (!pendingAskOn(data)) {
    throw new HttpsError(
      'failed-precondition',
      'There is no cancellation request waiting on this visit.',
    );
  }

  const resolution: Record<string, unknown> = {
    cancelRequestStatus: args.decision === 'accept' ? 'accepted' : 'declined',
    cancelResolvedAt: FieldValue.serverTimestamp(),
    cancelResolvedByUid: uid,
    cancelResponseNote: args.note ?? null,
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (args.decision === 'decline') {
    await visitRef.set(resolution, { merge: true });
    await recordDecision(uid, args, data.status ?? null, false, false);
    return validateResponse('resolveBookingCancellationRequest', Result, {
      ok: true,
      visitId: args.visitId,
      decision: args.decision,
      status: data.status ?? null,
      sessionUpdated: false,
      rescheduleRequestClosed: false,
    });
  }

  // A cancelled visit cannot also be waiting on a new time. Closing the
  // reschedule ask here is what keeps it out of the shared queue: that list
  // filters on `rescheduleRequestStatus === 'pending'` and knows nothing about
  // visit status, so an untouched ask would sit there forever asking an
  // operator to move a visit that no longer happens.
  const rescheduleRequestClosed = data.rescheduleRequestStatus === 'pending';
  if (rescheduleRequestClosed) {
    resolution['rescheduleRequestStatus'] = 'declined';
    resolution['rescheduleResolvedAt'] = FieldValue.serverTimestamp();
    resolution['rescheduleResolvedByUid'] = uid;
    resolution['rescheduleResponseNote'] = 'This visit was cancelled, so the new time was not booked.';
  }

  await visitRef.set({ ...resolution, status: 'cancelled', updatedBy: uid }, { merge: true });

  // The flat session row the admin schedule renders, mirrored the same way
  // batchUpdateBookings mirrors its own CANCEL: ONLY when the paired doc
  // exists. A visit still in the request stage was never approved and has no
  // session at all, and the id is deterministic, `vis_{visitId}`, minted by
  // approveBookingSeriesCore. The doc's own `sessionId` wins when it carries
  // one, because a visit created the other way round has a session id that is
  // not derived from the visit id.
  //
  // `CANCELLED`, uppercase, because `kin_care_sessions` has its own status
  // vocabulary (see batchUpdateBookings's sessionMirrorStatus). Writing the
  // lowercase kinCares value here would leave the row unreadable to the
  // schedule.
  let sessionUpdated = false;
  const sessionId =
    typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : `vis_${args.visitId}`;
  const sessionRef = db().doc(`kin_care_sessions/${sessionId}`);
  const sessionSnap = await sessionRef.get();
  if (sessionSnap.exists) {
    await sessionRef.set(
      { status: 'CANCELLED', updatedAt: FieldValue.serverTimestamp(), updatedBy: uid },
      { merge: true },
    );
    sessionUpdated = true;
  } else {
    // Expected for a visit still in the request stage, and reported anyway:
    // the visit IS cancelled for the household, so an operator whose schedule
    // still shows it needs the reason findable rather than mysterious.
    // `sessionUpdated: false` says the same thing on the wire.
    logEvent({
      severity: 'info',
      function: 'resolveBookingCancellationRequest',
      event: 'admin.cancel.noMirrorSession',
      uid,
      extra: { kinfolkId: args.kinfolkId, visitId: args.visitId, sessionId },
    });
  }

  await recordDecision(uid, args, 'cancelled', sessionUpdated, rescheduleRequestClosed);
  return validateResponse('resolveBookingCancellationRequest', Result, {
    ok: true,
    visitId: args.visitId,
    decision: args.decision,
    status: 'cancelled',
    sessionUpdated,
    rescheduleRequestClosed,
  });
}

async function recordDecision(
  uid: string,
  args: z.infer<typeof Args>,
  status: string | null,
  sessionUpdated: boolean,
  rescheduleRequestClosed: boolean,
): Promise<void> {
  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.CANCEL_REQUEST_RESOLVED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetCollection: `families/${args.kinfolkId}/bookings/${args.batchId}/kinCares`,
    description: `Operator ${args.decision === 'accept' ? 'accepted' : 'declined'} a kinfolk cancellation request`,
    payload: {
      kinfolkId: args.kinfolkId,
      batchId: args.batchId,
      visitId: args.visitId,
      decision: args.decision,
      note: args.note ?? null,
      status,
      sessionUpdated,
      rescheduleRequestClosed,
    },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'resolveBookingCancellationRequest',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  logEvent({
    severity: 'info',
    function: 'resolveBookingCancellationRequest',
    event: 'admin.booking.cancel_resolved',
    uid,
    extra: { kinfolkId: args.kinfolkId, visitId: args.visitId, decision: args.decision },
  });
}

// ── The queue ────────────────────────────────────────────────────────────────

export const ListArgs = z.object({
  /** Cap on rows returned. The queue is a to-do list, not a report. */
  limit: z.number().int().min(1).max(100).optional(),
});

export const CancelRequestDto = z
  .object({
    kinfolkId: z.string().min(1),
    batchId: z.string().min(1),
    visitId: z.string().min(1),
    title: z.string().nullable(),
    serviceType: z.string().nullable(),
    kinNames: z.array(z.string()),
    status: z.string().nullable(),
    startTimeMs: z.number().int().nullable(),
    endTimeMs: z.number().int().nullable(),
    reason: z.string().nullable(),
    requestedAtMs: z.number().int().nullable(),
  })
  .strict();

export const ListResult = z
  .object({
    requests: z.array(CancelRequestDto),
  })
  .strict();

/**
 * How many kinCares docs the queue query reads before filtering.
 *
 * The query cannot filter to unresolved asks in Firestore: a pre-#438 request
 * has no `cancelRequestStatus` field at all, and Firestore has no "field is
 * missing" predicate, so an equality filter would silently drop the July
 * backlog. So the read is ordered oldest-first and the resolved rows are
 * dropped here. Resolved asks accumulate at the front of that order over time,
 * which at this business's volume is a rounding error for years; the cap is
 * logged when it is hit so the day it stops being one is findable.
 */
const SCAN_CAP = 200;

/**
 * Every visit with a cancellation ask still waiting on a decision.
 *
 * A collection-group query, because the requests live one per household under
 * `families/{kinfolkId}/bookings/{batchId}/kinCares` and the office needs them
 * in one list. Ordered oldest first: the household that has been waiting
 * longest is the one to answer, and after #438 some of them have been waiting
 * since July.
 */
export async function listCancelRequestsHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof ListResult>> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  let args: z.infer<typeof ListArgs>;
  try {
    args = ListArgs.parse(req.data ?? {});
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'listCancelRequests validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const limit = args.limit ?? 50;
  const snap = await db()
    .collectionGroup('kinCares')
    .orderBy('cancelRequestedAt', 'asc')
    .limit(SCAN_CAP)
    .get();

  const requests = snap.docs
    .map((doc) => {
      const d = doc.data() as Record<string, unknown>;
      if (!pendingAskOn(d)) return null;
      const path = doc.ref.path.split('/');
      // families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}
      const kinfolkId = path[1] ?? '';
      const batchId = path[3] ?? '';
      if (!kinfolkId || !batchId) return null;
      return {
        kinfolkId,
        batchId,
        visitId: doc.id,
        title: stringOrNull(d['title']),
        serviceType: stringOrNull(d['serviceType']),
        kinNames: Array.isArray(d['kinNames']) ? (d['kinNames'] as string[]) : [],
        status: stringOrNull(d['status']),
        startTimeMs: millisOf(d['startTime'] as Timestamp | null | undefined),
        endTimeMs: millisOf(d['endTime'] as Timestamp | null | undefined),
        reason: stringOrNull(d['cancelRequestReason']),
        requestedAtMs: millisOf(d['cancelRequestedAt'] as Timestamp | null | undefined),
      };
    })
    .filter((r): r is z.infer<typeof CancelRequestDto> => r !== null)
    .slice(0, limit);

  if (snap.size >= SCAN_CAP) {
    logEvent({
      severity: 'warn',
      function: 'listCancelRequests',
      event: 'admin.cancel.queue.scanCapped',
      uid,
      extra: { scanCap: SCAN_CAP, pendingFound: requests.length },
    });
  }
  logEvent({
    severity: 'info',
    function: 'listCancelRequests',
    event: 'admin.cancel.queue.read',
    uid,
    extra: { count: requests.length },
  });
  return validateResponse('listCancelRequests', ListResult, { requests });
}

function millisOf(v: { toMillis?: () => number } | null | undefined): number | null {
  const ms = v?.toMillis?.();
  return typeof ms === 'number' ? ms : null;
}

function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export const resolveBookingCancellationRequest = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('resolveBookingCancellationRequest', resolveBookingCancellationRequestHandler),
);

export const listCancelRequests = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('listCancelRequests', listCancelRequestsHandler),
);
