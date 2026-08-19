import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { resolveKinfolkAccess } from '../lib/resolveKinfolkAccess';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { validateResponse } from '../lib/callableResponse';

/**
 * Vendor-parity (2026-07-02): a kinfolk asks the business to cancel a visit.
 *
 * Deliberately NOT a status change: the visit keeps its requested/confirmed
 * status (only the business cancels for real, via batchUpdateBookings), and
 * the ask is recorded as `cancelRequestedAt` + `cancelRequestReason` +
 * `cancelRequestedByUid` on the kinCares doc. onBookingsWrite watches the
 * flag's first appearance and fires `kincare.cancel.requested` to the office.
 * A second request while one is still pending is a no-op.
 *
 * #438 adds `cancelRequestStatus`, which is what an operator rules on through
 * `admin/cancelRequests`. Every request written before #438 carries the stamp
 * and no status; those read as pending everywhere (see `pendingAskOn` below),
 * because they are exactly the asks that have been waiting since July. A
 * DECLINED ask is not pending, so the household may ask again, and the
 * previous answer is cleared off the doc when they do.
 */
export const Args = z.object({
  kinfolkId: z.string().min(1).max(200).optional(),
  batchId: z.string().min(1).max(200),
  visitId: z.string().min(1).max(200),
  reason: z.string().trim().max(500).optional(),
});

export const Result = z
  .object({
    ok: z.literal(true),
    visitId: z.string().min(1),
    /** True when a request was already pending (this call was a no-op). */
    alreadyPending: z.boolean(),
  })
  .strict();

const CANCELABLE = new Set(['requested', 'confirmed']);

/**
 * True when this visit already carries a cancellation ask nobody has ruled on.
 *
 * The status field is authoritative when it is there. When it is not, a bare
 * `cancelRequestedAt` is a pre-#438 request no operator has ever seen, so it
 * counts as pending rather than as something already answered.
 */
export function pendingAskOn(data: {
  cancelRequestedAt?: unknown;
  cancelRequestStatus?: unknown;
}): boolean {
  const status = data.cancelRequestStatus;
  if (status === 'pending') return true;
  if (status === 'accepted' || status === 'declined') return false;
  return Boolean(data.cancelRequestedAt);
}

export async function requestBookingCancellationHandler(
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
      throw new HttpsError('invalid-argument', 'requestBookingCancellation validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const { kinfolkId } = await resolveKinfolkAccess(uid, args.kinfolkId, req.auth?.token?.admin === true, 'requestBookingCancellation');
  const visitRef = db().doc(
    `families/${kinfolkId}/bookings/${args.batchId}/kinCares/${args.visitId}`,
  );
  const snap = await visitRef.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Visit not found.');
  const data = snap.data() as {
    status?: string;
    cancelRequestedAt?: unknown;
    cancelRequestStatus?: unknown;
    startTime?: { toMillis?: () => number } | null;
  };

  if (!CANCELABLE.has(data.status ?? '')) {
    throw new HttpsError(
      'failed-precondition',
      'Only an upcoming requested or confirmed visit can ask for a cancellation.',
    );
  }
  if (pendingAskOn(data)) {
    return validateResponse('requestBookingCancellation', Result, {
      ok: true,
      visitId: args.visitId,
      alreadyPending: true,
    });
  }

  await visitRef.set(
    {
      cancelRequestedAt: FieldValue.serverTimestamp(),
      cancelRequestedByUid: uid,
      cancelRequestReason: args.reason?.trim() || null,
      cancelRequestStatus: 'pending',
      // Cleared so a decline followed by a fresh ask does not still show the
      // previous answer beside the new one, exactly as
      // requestBookingReschedule clears its own.
      cancelResponseNote: null,
      cancelResolvedAt: null,
      cancelResolvedByUid: null,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.BOOKING_BATCH_ACTION,
    severity: 'info',
    actorRole: 'PRIMARY',
    actorUid: uid,
    targetCollection: `families/${kinfolkId}/bookings/${args.batchId}/kinCares`,
    description: 'Kinfolk requested a visit cancellation',
    payload: { kinfolkId, batchId: args.batchId, visitId: args.visitId, reason: args.reason ?? null },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'requestBookingCancellation',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  logEvent({
    severity: 'info',
    function: 'requestBookingCancellation',
    event: 'portal.booking.cancel_requested',
    uid,
    extra: { kinfolkId, batchId: args.batchId, visitId: args.visitId },
  });
  return validateResponse('requestBookingCancellation', Result, {
    ok: true,
    visitId: args.visitId,
    alreadyPending: false,
  });
}

export const requestBookingCancellation = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('requestBookingCancellation', requestBookingCancellationHandler),
);
