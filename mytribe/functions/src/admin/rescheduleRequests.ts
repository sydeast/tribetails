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
import { guardCompanyHolidayConflict } from '../lib/companyHolidayConflict';
import { validateResponse } from '../lib/callableResponse';

/**
 * The office's half of the kinfolk reschedule ask (issue #399, item 2).
 *
 * `portal/requestBookingReschedule` records a PROPOSAL on the kinCares doc and
 * changes nothing about the visit. These two callables are where a human turns
 * that proposal into a decision: `listRescheduleRequests` is the queue, and
 * `resolveBookingRescheduleRequest` accepts or declines one.
 *
 * ACCEPTING IS WHAT MOVES THE VISIT, and it moves BOTH records. The kinCares
 * doc under `families/{kinfolkId}/bookings/{batchId}` is what the portal reads;
 * the flat `kin_care_sessions/{sessionId}` row is what the admin's schedule
 * reads, and `admin/rescheduleBooking` only ever wrote the second. A visit
 * moved through that callable alone therefore still reads at its old time in
 * the portal. Accepting here writes the pair, so the household and the office
 * are looking at the same visit.
 *
 * The company-holiday guard runs on the NEW window before anything is written,
 * exactly as `admin/rescheduleBooking` guards its own. A proposal that lands on
 * a closure is refused with the guard's own message rather than accepted and
 * then discovered.
 */

const DECISION = z.enum(['accept', 'decline']);

export const Args = z.object({
  kinfolkId: z.string().min(1).max(200),
  batchId: z.string().min(1).max(200),
  visitId: z.string().min(1).max(200),
  decision: DECISION,
  /**
   * #700: optional on every decision, including a decline. The office does not
   * owe the household a reason; this is only the extra, custom text an
   * operator can choose to add on top of the decline the household already
   * sees.
   */
  note: z.string().trim().max(500).optional(),
});

export const Result = z
  .object({
    ok: z.literal(true),
    visitId: z.string().min(1),
    decision: DECISION,
    /** The visit's start after the decision. Unchanged on a decline. */
    startTimeMs: z.number().int().nullable(),
    /** True when the flat kin_care_sessions row was moved alongside the visit. */
    sessionUpdated: z.boolean(),
  })
  .strict();

export async function resolveBookingRescheduleRequestHandler(
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
      throw new HttpsError('invalid-argument', 'resolveBookingRescheduleRequest validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const visitRef = db().doc(
    `families/${args.kinfolkId}/bookings/${args.batchId}/kinCares/${args.visitId}`,
  );
  const snap = await visitRef.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Visit not found.');
  const data = snap.data() as {
    rescheduleRequestStatus?: string;
    rescheduleRequestedStartTime?: Timestamp | null;
    rescheduleRequestedEndTime?: Timestamp | null;
    startTime?: Timestamp | null;
    sessionId?: string | null;
  };

  if (data.rescheduleRequestStatus !== 'pending') {
    throw new HttpsError(
      'failed-precondition',
      'There is no reschedule request waiting on this visit.',
    );
  }

  const resolution: Record<string, unknown> = {
    rescheduleRequestStatus: args.decision === 'accept' ? 'accepted' : 'declined',
    rescheduleResolvedAt: FieldValue.serverTimestamp(),
    rescheduleResolvedByUid: uid,
    rescheduleResponseNote: args.note ?? null,
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (args.decision === 'decline') {
    await visitRef.set(resolution, { merge: true });
    await recordDecision(uid, args, null, false);
    return validateResponse('resolveBookingRescheduleRequest', Result, {
      ok: true,
      visitId: args.visitId,
      decision: args.decision,
      startTimeMs: millisOf(data.startTime),
      sessionUpdated: false,
    });
  }

  const newStart = data.rescheduleRequestedStartTime ?? null;
  if (!newStart) {
    throw new HttpsError(
      'failed-precondition',
      'This request carries no proposed start time, so there is nothing to move the visit to.',
    );
  }
  const newEnd = data.rescheduleRequestedEndTime ?? null;

  await guardCompanyHolidayConflict({
    firestore: db(),
    visits: [{ startTimeMs: newStart.toMillis(), endTimeMs: newEnd ? newEnd.toMillis() : newStart.toMillis() }],
  });

  await visitRef.set(
    {
      ...resolution,
      startTime: newStart,
      ...(newEnd ? { endTime: newEnd } : {}),
    },
    { merge: true },
  );

  // The flat session row the admin schedule renders, mirrored the same way
  // batchUpdateBookings and manageBookingSeries mirror status: ONLY when the
  // paired doc exists. A still-pending request that was never approved has no
  // session at all, and the id is deterministic, `vis_{visitId}`, minted by
  // approveBookingSeriesCore. The doc's own `sessionId` is preferred when it
  // carries one, because a visit created the other way round has a session id
  // that is not derived from the visit id.
  //
  // ISO strings here, Timestamps above. That is not an inconsistency to tidy:
  // `kin_care_sessions` stores ISO (see getMyBookings's isoMillis path and
  // admin/rescheduleBooking's own write) and the kinCares subcollection stores
  // Timestamps (tsMillis). Writing either shape into the other silently breaks
  // both readers.
  let sessionUpdated = false;
  const sessionId =
    typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : `vis_${args.visitId}`;
  const sessionRef = db().doc(`kin_care_sessions/${sessionId}`);
  const sessionSnap = await sessionRef.get();
  if (sessionSnap.exists) {
    await sessionRef.set(
      {
        startTime: newStart.toDate().toISOString(),
        ...(newEnd ? { endTime: newEnd.toDate().toISOString() } : {}),
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: uid,
      },
      { merge: true },
    );
    sessionUpdated = true;
  } else {
    // Expected for a visit still in the request stage, and reported anyway:
    // the visit HAS moved for the household, so an operator whose schedule
    // still shows the old slot needs the reason findable rather than
    // mysterious. `sessionUpdated: false` says the same thing on the wire.
    logEvent({
      severity: 'info',
      function: 'resolveBookingRescheduleRequest',
      event: 'admin.reschedule.noMirrorSession',
      uid,
      extra: { kinfolkId: args.kinfolkId, visitId: args.visitId, sessionId },
    });
  }

  await recordDecision(uid, args, newStart.toMillis(), sessionUpdated);
  return validateResponse('resolveBookingRescheduleRequest', Result, {
    ok: true,
    visitId: args.visitId,
    decision: args.decision,
    startTimeMs: newStart.toMillis(),
    sessionUpdated,
  });
}

async function recordDecision(
  uid: string,
  args: z.infer<typeof Args>,
  startTimeMs: number | null,
  sessionUpdated: boolean,
): Promise<void> {
  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.RESCHEDULE_BOOKING,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetCollection: `families/${args.kinfolkId}/bookings/${args.batchId}/kinCares`,
    description: `Operator ${args.decision === 'accept' ? 'accepted' : 'declined'} a kinfolk reschedule request`,
    payload: {
      kinfolkId: args.kinfolkId,
      batchId: args.batchId,
      visitId: args.visitId,
      decision: args.decision,
      note: args.note ?? null,
      startTimeMs,
      sessionUpdated,
    },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'resolveBookingRescheduleRequest',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  logEvent({
    severity: 'info',
    function: 'resolveBookingRescheduleRequest',
    event: 'admin.booking.reschedule_resolved',
    uid,
    extra: { kinfolkId: args.kinfolkId, visitId: args.visitId, decision: args.decision },
  });
}

// ── The queue ────────────────────────────────────────────────────────────────

export const ListArgs = z.object({
  /** Cap on rows returned. The queue is a to-do list, not a report. */
  limit: z.number().int().min(1).max(100).optional(),
});

export const RescheduleRequestDto = z
  .object({
    kinfolkId: z.string().min(1),
    batchId: z.string().min(1),
    visitId: z.string().min(1),
    title: z.string().nullable(),
    serviceType: z.string().nullable(),
    kinNames: z.array(z.string()),
    status: z.string().nullable(),
    currentStartTimeMs: z.number().int().nullable(),
    currentEndTimeMs: z.number().int().nullable(),
    proposedStartTimeMs: z.number().int().nullable(),
    proposedEndTimeMs: z.number().int().nullable(),
    reason: z.string().nullable(),
    requestedAtMs: z.number().int().nullable(),
  })
  .strict();

export const ListResult = z
  .object({
    requests: z.array(RescheduleRequestDto),
  })
  .strict();

/**
 * Every visit with a reschedule ask still waiting on a decision.
 *
 * A collection-group query, because the requests live one per household under
 * `families/{kinfolkId}/bookings/{batchId}/kinCares` and the office needs them
 * in one list. Ordered oldest first: the household that has been waiting
 * longest is the one to answer.
 */
export async function listRescheduleRequestsHandler(
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
      throw new HttpsError('invalid-argument', 'listRescheduleRequests validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const snap = await db()
    .collectionGroup('kinCares')
    .where('rescheduleRequestStatus', '==', 'pending')
    .orderBy('rescheduleRequestedAt', 'asc')
    .limit(args.limit ?? 50)
    .get();

  const requests = snap.docs
    .map((doc) => {
      const path = doc.ref.path.split('/');
      // families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}
      const kinfolkId = path[1] ?? '';
      const batchId = path[3] ?? '';
      if (!kinfolkId || !batchId) return null;
      const d = doc.data() as Record<string, unknown>;
      return {
        kinfolkId,
        batchId,
        visitId: doc.id,
        title: stringOrNull(d['title']),
        serviceType: stringOrNull(d['serviceType']),
        kinNames: Array.isArray(d['kinNames']) ? (d['kinNames'] as string[]) : [],
        status: stringOrNull(d['status']),
        currentStartTimeMs: millisOf(d['startTime'] as Timestamp | null | undefined),
        currentEndTimeMs: millisOf(d['endTime'] as Timestamp | null | undefined),
        proposedStartTimeMs: millisOf(d['rescheduleRequestedStartTime'] as Timestamp | null | undefined),
        proposedEndTimeMs: millisOf(d['rescheduleRequestedEndTime'] as Timestamp | null | undefined),
        reason: stringOrNull(d['rescheduleRequestReason']),
        requestedAtMs: millisOf(d['rescheduleRequestedAt'] as Timestamp | null | undefined),
      };
    })
    .filter((r): r is z.infer<typeof RescheduleRequestDto> => r !== null);

  logEvent({
    severity: 'info',
    function: 'listRescheduleRequests',
    event: 'admin.reschedule.queue.read',
    uid,
    extra: { count: requests.length },
  });
  return validateResponse('listRescheduleRequests', ListResult, { requests });
}

function millisOf(v: { toMillis?: () => number } | null | undefined): number | null {
  const ms = v?.toMillis?.();
  return typeof ms === 'number' ? ms : null;
}

function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export const resolveBookingRescheduleRequest = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('resolveBookingRescheduleRequest', resolveBookingRescheduleRequestHandler),
);

export const listRescheduleRequests = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('listRescheduleRequests', listRescheduleRequestsHandler),
);
