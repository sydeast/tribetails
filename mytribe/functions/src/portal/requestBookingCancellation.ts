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

/**
 * Vendor-parity (2026-07-02): a kinfolk asks the business to cancel a visit.
 *
 * Deliberately NOT a status change: the visit keeps its requested/confirmed
 * status (only the business cancels for real, via batchUpdateBookings), and
 * the ask is recorded as `cancelRequestedAt` + `cancelRequestReason` +
 * `cancelRequestedByUid` on the kinCares doc. onBookingsWrite watches the
 * flag's first appearance and fires `kincare.cancel.requested` to the office.
 * A second request on the same visit is a no-op (already pending).
 */
const Args = z.object({
  kinfolkId: z.string().min(1).max(200).optional(),
  batchId: z.string().min(1).max(200),
  visitId: z.string().min(1).max(200),
  reason: z.string().trim().max(500).optional(),
});

const CANCELABLE = new Set(['requested', 'confirmed']);

export async function requestBookingCancellationHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; visitId: string; alreadyPending: boolean }> {
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
    startTime?: { toMillis?: () => number } | null;
  };

  if (!CANCELABLE.has(data.status ?? '')) {
    throw new HttpsError(
      'failed-precondition',
      'Only an upcoming requested or confirmed visit can ask for a cancellation.',
    );
  }
  if (data.cancelRequestedAt) {
    return { ok: true, visitId: args.visitId, alreadyPending: true };
  }

  await visitRef.set(
    {
      cancelRequestedAt: FieldValue.serverTimestamp(),
      cancelRequestedByUid: uid,
      cancelRequestReason: args.reason?.trim() || null,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  await writeAuditEntry({
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
  return { ok: true, visitId: args.visitId, alreadyPending: false };
}

export const requestBookingCancellation = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('requestBookingCancellation', requestBookingCancellationHandler),
);
