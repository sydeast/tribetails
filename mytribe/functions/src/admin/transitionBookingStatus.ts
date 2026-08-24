import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import {
  ARRIVAL_VERIFICATION_CODE,
  arrivalVerificationMessage,
  isArrivalVerificationRequired,
  missingVisitSteps,
} from '../lib/arrivalVerification';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import { validateResponse } from '../lib/callableResponse';
import {
  BOOKING_ACTIONS,
  BOOKING_STATUS_UNKNOWN_CODE,
  BOOKING_TRANSITION_ILLEGAL_CODE,
  appendCancellationNote,
  evaluateTransition,
  illegalTransitionMessage,
  targetStatusFor,
  unknownStatusMessage,
  type BookingAction,
} from '../lib/bookingTransitions';

/**
 * A3: server-bound Approve / Reject / Cancel / Mark-Completed on ONE
 * `kin_care_sessions` document.
 *
 * THE DEFECT THIS CLOSES. `auntieos-admin/src/api/bookingsWrite.ts:84` was a
 * bare `updateDoc(doc(db, 'kin_care_sessions', bookingId), { status, ...extra })`
 * from the browser, authorized by nothing but `firestore.rules`'s `isAuntie()`.
 * All four operator transitions routed through it, so a booking could go from
 * any status to any status, and the `activity_log` chain
 * (`lib/writeAuditEntry.ts`) recorded none of it. Android had the same hole in
 * three places (`KinCareRepository.markSessionComplete`,
 * `EnhancedSchedulingViewModel#bridgeCancellationToSession`, and Auntie Time's
 * "Complete" button). This is the last money-adjacent write on the session doc
 * that was not server-bound: `rescheduleBooking` already was.
 *
 * SHAPE. Deliberately the same shape as `rescheduleBooking.ts` and
 * `createKinCareSession.ts`, the two callables that already own writes to this
 * collection: `wrapAdminCallable` for the admin claim, zod at the boundary,
 * read-before-write so the audit records the real before/after, `writeAuditEntry`
 * bound to the mutation.
 *
 * EVERY PATH IS AUDITED, INCLUDING THE ONES THAT REFUSE. A refused transition
 * is the interesting half of an audit trail: "who tried to complete a cancelled
 * visit" is exactly the question the trail exists to answer, and it is
 * unanswerable if only successes are written. Refusals land as
 * `BOOKING_TRANSITION_REFUSED` at `severity: 'warn'` with
 * `status: 'FAILURE'`; successes as `BOOKING_STATUS_TRANSITION` at `'info'`.
 *
 * The audit write is best-effort on every path (`.catch` to a warn log), the
 * same treatment `batchUpdateBookings.ts` gives it. A failed audit must not
 * turn a committed status change into a reported failure that the operator
 * then retries, and on the refusal paths it must not swallow the refusal.
 */
export const Args = z.object({
  sessionId: z.string().min(1).max(120),
  action: z.enum(BOOKING_ACTIONS),
  /**
   * Only meaningful for COMPLETE. The CALLER's "now", kept because that is what
   * the previous client writes stored on `completedAt` and what every reader of
   * this collection already parses (`lib/bookingDetailFormat.ts`,
   * `DashboardInsights.kt`). Omitted, the server stamps its own ISO string, so
   * the field is never absent on a completed visit.
   */
  completedAt: z.string().min(1).max(40).optional(),
  /**
   * Only meaningful for CANCEL and REJECT: why the visit was called off. Appended
   * to the session's `notes` and recorded in the audit payload. Free text, so it
   * is length-capped rather than parsed.
   */
  reason: z.string().min(1).max(500).optional(),
});

export const Result = z
  .object({
    ok: z.literal(true),
    sessionId: z.string(),
    action: z.enum(BOOKING_ACTIONS),
    /** The status the row held before this call. Equal to `status` on a no-op. */
    from: z.string(),
    /** The status the row holds now. */
    status: z.string(),
    /** False when the row was already in the target status and nothing was written. */
    changed: z.boolean(),
  })
  .strict();

export type TransitionBookingStatusResult = z.infer<typeof Result>;

/** Audit a refusal, then let the caller throw. Never swallows the throw. */
async function auditRefusal(args: {
  uid: string;
  sessionId: string;
  action: BookingAction;
  code: string;
  from: string;
  description: string;
}): Promise<void> {
  await writeAuditEntry({
    event: AUDIT_EVENTS.BOOKING_TRANSITION_REFUSED,
    severity: 'warn',
    status: 'FAILURE',
    actorRole: 'AUNTIE',
    actorUid: args.uid,
    targetUid: args.sessionId,
    targetCollection: 'kin_care_sessions',
    description: args.description,
    payload: {
      sessionId: args.sessionId,
      action: args.action,
      refusalCode: args.code,
      from: args.from,
      attempted: targetStatusFor(args.action),
    },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'transitionBookingStatus',
      event: 'audit.write.failed',
      uid: args.uid,
      errorMessage: (err as Error)?.message,
    });
  });
}

export async function transitionBookingStatusHandler(
  req: CallableRequest<unknown>,
): Promise<TransitionBookingStatusResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'transitionBookingStatus validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const ref = db().doc(`kin_care_sessions/${args.sessionId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    await auditRefusal({
      uid,
      sessionId: args.sessionId,
      action: args.action,
      code: 'not_found',
      from: '',
      description: `${args.action} refused: session '${args.sessionId}' not found`,
    });
    throw new HttpsError('not-found', `Session '${args.sessionId}' not found.`);
  }

  const prev = snap.data() as
    | { status?: unknown; notes?: unknown; arrivedAt?: unknown; departedAt?: unknown }
    | undefined;
  const decision = evaluateTransition({ currentStatus: prev?.status, action: args.action });

  if (decision.kind === 'unknown-status') {
    await auditRefusal({
      uid,
      sessionId: args.sessionId,
      action: args.action,
      code: BOOKING_STATUS_UNKNOWN_CODE,
      from: decision.raw,
      description: `${args.action} refused: unreadable status on session '${args.sessionId}'`,
    });
    throw new HttpsError('failed-precondition', unknownStatusMessage(decision.raw), {
      code: BOOKING_STATUS_UNKNOWN_CODE,
      sessionId: args.sessionId,
    });
  }

  if (decision.kind === 'illegal') {
    await auditRefusal({
      uid,
      sessionId: args.sessionId,
      action: args.action,
      code: BOOKING_TRANSITION_ILLEGAL_CODE,
      from: decision.from,
      description: `${args.action} refused: illegal from ${decision.from}`,
    });
    throw new HttpsError(
      'failed-precondition',
      illegalTransitionMessage(args.action, decision.from, decision.allowedFrom),
      {
        code: BOOKING_TRANSITION_ILLEGAL_CODE,
        sessionId: args.sessionId,
        from: decision.from,
        allowedFrom: decision.allowedFrom,
      },
    );
  }

  if (decision.kind === 'noop') {
    // Already there. Audited anyway (at 'info', changed:false) so the trail
    // shows the operator pressed the button, not a silent gap between two
    // identical states.
    await writeAuditEntry({
      event: AUDIT_EVENTS.BOOKING_STATUS_TRANSITION,
      severity: 'info',
      // A no-op is a satisfied request, not a failure. `changed: false` in the
      // payload is what separates it from a write. Required since A4 removed
      // the severity-to-status guess.
      status: 'SUCCESS',
      actorRole: 'AUNTIE',
      actorUid: uid,
      targetUid: args.sessionId,
      targetCollection: 'kin_care_sessions',
      description: `${args.action} on session ${args.sessionId}: already ${decision.at}, no write`,
      payload: {
        sessionId: args.sessionId,
        action: args.action,
        from: decision.at,
        to: decision.at,
        changed: false,
      },
    }).catch((err) => {
      logEvent({
        severity: 'warn',
        function: 'transitionBookingStatus',
        event: 'audit.write.failed',
        uid,
        errorMessage: (err as Error)?.message,
      });
    });

    return validateResponse('transitionBookingStatus', Result, {
      ok: true as const,
      sessionId: args.sessionId,
      action: args.action,
      from: decision.at,
      status: decision.at,
      changed: false,
    });
  }

  // ISSUE #519: the operator's "Verify arrival and departure" switch. Checked
  // AFTER the transition machine has ruled the move legal, so an illegal
  // COMPLETE still reports the illegal transition rather than this, and only for
  // COMPLETE, which is the one transition the server owns and the one that
  // decides whether a visit happened. Absent reads as OFF; see
  // `lib/arrivalVerification.ts` for why this gate reads that way round.
  if (args.action === 'COMPLETE' && (await isArrivalVerificationRequired(db()))) {
    const missing = missingVisitSteps(prev ?? {});
    if (missing.length > 0) {
      await auditRefusal({
        uid,
        sessionId: args.sessionId,
        action: args.action,
        code: ARRIVAL_VERIFICATION_CODE,
        from: decision.from,
        description: `COMPLETE refused: session '${args.sessionId}' has no ${missing.join(' or ')} recorded`,
      });
      throw new HttpsError('failed-precondition', arrivalVerificationMessage(missing), {
        code: ARRIVAL_VERIFICATION_CODE,
        sessionId: args.sessionId,
        missing,
      });
    }
  }
  const patch: Record<string, unknown> = {
    status: decision.to,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: uid,
  };
  if (args.action === 'COMPLETE') {
    patch.completedAt = args.completedAt ?? new Date().toISOString();
  }
  const reason = args.reason?.trim() ?? '';
  const notesAppended = reason !== '' && (args.action === 'CANCEL' || args.action === 'REJECT');
  if (notesAppended) {
    patch.notes = appendCancellationNote(prev?.notes, reason);
  }

  await ref.set(patch, { merge: true });

  await writeAuditEntry({
    event: AUDIT_EVENTS.BOOKING_STATUS_TRANSITION,
    severity: 'info',
    // The write above landed. Required since A4 removed the severity-to-status
    // guess that would have inferred this.
    status: 'SUCCESS',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetUid: args.sessionId,
    targetCollection: 'kin_care_sessions',
    description: `${args.action} on session ${args.sessionId}: ${decision.from} -> ${decision.to}`,
    payload: {
      sessionId: args.sessionId,
      action: args.action,
      from: decision.from,
      to: decision.to,
      changed: true,
      // The reason TEXT is stored on the session's own notes; the audit records
      // only that one was supplied, so the trail carries no free-text the
      // operator may have put a household detail into.
      reasonSupplied: notesAppended,
    },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'transitionBookingStatus',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  logEvent({
    severity: 'info',
    function: 'transitionBookingStatus',
    event: 'admin.booking.statusTransitioned',
    uid,
    extra: { sessionId: args.sessionId, action: args.action, from: decision.from, to: decision.to },
  });

  return validateResponse('transitionBookingStatus', Result, {
    ok: true as const,
    sessionId: args.sessionId,
    action: args.action,
    from: decision.from,
    status: decision.to,
    changed: true,
  });
}

export const transitionBookingStatus = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('transitionBookingStatus', transitionBookingStatusHandler),
);
