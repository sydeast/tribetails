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
import { approveBookingSeriesCore } from './approveBookingSeriesCore';
import { validateResponse } from '../lib/callableResponse';
import { enqueueNotification } from '../notifications/dispatcher';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';

/**
 * 1G (Decision 11): series-level approve/cancel on the parent booking envelope.
 *
 * A recurring/grouped request is stored as ONE parent doc
 * `families/{kinfolkId}/bookings/{batchId}` (written by requestBooking) owning N
 * `kinCares/{visitId}` children. This callable approves or cancels the WHOLE
 * series at once: it flips every child visit's status and rolls the envelope
 * status + counts in a single transaction, so an admin never has to act on each
 * visit individually. Audit-bound server-side (matches triageOrphanReport).
 */
export const Args = z.object({
  action: z.enum(['APPROVE', 'CANCEL']),
  kinfolkId: z.string().min(1).max(120),
  batchId: z.string().min(1).max(120),
  /**
   * Why the office could not take a request, shown to the household beside the
   * decision (#533). Only reaches them when CANCEL is DECLINING a request that
   * was never confirmed; cancelling an already-approved series is a different
   * event and carries no note.
   */
  note: z.string().trim().max(500).optional(),
});

export const Result = z
  .object({
    ok: z.literal(true),
    action: z.enum(['APPROVE', 'CANCEL']),
    batchId: z.string().min(1),
    affectedVisits: z.number().int().nonnegative(),
    /** Sessions created on APPROVE (idempotent: a re-approve creates 0). */
    sessionsCreated: z.number().int().nonnegative(),
    /** Visits whose write failed and were skipped (fail-loud; 0 = full success). */
    failedVisits: z.number().int().nonnegative(),
  })
  .strict();

export async function manageBookingSeriesHandler(
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
      throw new HttpsError('invalid-argument', 'manageBookingSeries validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  // APPROVE: delegate to the shared core (also used by requestBooking's
  // auto-confirm path). It creates sessions, rolls the envelope, and audits.
  if (args.action === 'APPROVE') {
    const r = await approveBookingSeriesCore({
      kinfolkId: args.kinfolkId,
      batchId: args.batchId,
      actorUid: uid,
      actorRole: 'AUNTIE',
    });
    if (!r.found) {
      throw new HttpsError('not-found', `Booking series '${args.batchId}' not found.`);
    }
    return validateResponse('manageBookingSeries', Result, {
      ok: true,
      action: 'APPROVE',
      batchId: args.batchId,
      affectedVisits: r.affectedVisits,
      sessionsCreated: r.sessionsCreated,
      failedVisits: r.failedVisits,
    });
  }

  // CANCEL path: flip every child to 'cancelled' and cancel its linked session.
  const parentRef = db().doc(`families/${args.kinfolkId}/bookings/${args.batchId}`);
  const parentSnap = await parentRef.get();
  if (!parentSnap.exists) {
    throw new HttpsError('not-found', `Booking series '${args.batchId}' not found.`);
  }

  // CANCEL is dual-use, and the two uses owe the household DIFFERENT news.
  // Declining a request that was never confirmed is not "your visits were
  // cancelled" -- those visits were never on their schedule. Cancelling an
  // already-approved series is. Read the envelope's status BEFORE the loop
  // flips it, because afterwards both cases look identical.
  const envelope = parentSnap.data() as Record<string, unknown> | undefined;
  const isDecliningRequest = envelope?.['envelopeStatus'] === 'requested';

  const childSnap = await parentRef.collection('kinCares').get();
  const childIds = childSnap.docs.map((d) => d.id);
  const declinedStartMs = childSnap.docs
    .map((d) => (d.data() as Record<string, unknown>)['startTime'] as { toMillis?: () => number } | undefined)
    .map((t) => t?.toMillis?.())
    .filter((ms): ms is number => typeof ms === 'number')
    .sort((a, b) => a - b);

  let failedVisits = 0;
  // Each visit is isolated in try/catch so one bad visit can't abort the series
  // (we still roll the envelope + audit with the actual cancelled count).
  for (const doc of childSnap.docs) {
    const id = doc.id;
    const childRef = parentRef.collection('kinCares').doc(id);
    const sessionRef = db().collection('kin_care_sessions').doc(`vis_${id}`);
    try {
      await childRef.set(
        {
          status: 'cancelled',
          updatedAt: FieldValue.serverTimestamp(),
          // #533: mark WHY this visit was cancelled, so onBookingsWrite can tell
          // a declined request apart from a genuine cancellation. Inferring it
          // from `requested -> cancelled` is not enough: a household may ask to
          // cancel a still-requested visit (portal CANCELABLE admits
          // `requested`), and ACCEPTING that ask makes the same transition while
          // owing them the opposite message.
          ...(isDecliningRequest
            ? {
                requestDeclinedAt: FieldValue.serverTimestamp(),
                requestDeclineNote: args.note ?? null,
              }
            : {}),
        },
        { merge: true },
      );
      const linked = await sessionRef.get();
      if (linked.exists) {
        await sessionRef.set({ status: 'CANCELLED', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      }
    } catch (err) {
      failedVisits += 1;
      logEvent({
        severity: 'error', function: 'manageBookingSeries', event: 'visit.failed',
        uid, extra: { batchId: args.batchId, visitId: id, action: 'CANCEL', err: (err as Error)?.message },
      });
    }
  }

  const succeeded = childIds.length - failedVisits;
  await parentRef.set(
    {
      // Only mark the whole envelope cancelled when every visit succeeded; a partial
      // failure leaves it 'requested' so the admin retries (no false 'done').
      envelopeStatus: failedVisits === 0 ? 'cancelled' : 'requested',
      cancelledCount: succeeded,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: uid,
    },
    { merge: true },
  );

  await writeAuditEntry({
    // Same shape as batchUpdateBookings (A4 audit follow-up): a series with
    // any failed visit did not fully do what it was asked, so it's audited
    // as FAILURE, not SUCCESS, even though counts also live in the payload.
    status: failedVisits === 0 ? 'SUCCESS' : 'FAILURE',
    event: AUDIT_EVENTS.CANCEL_BOOKING_SERIES,
    severity: failedVisits > 0 ? 'warn' : 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    payload: { kinfolkId: args.kinfolkId, batchId: args.batchId, affectedVisits: succeeded, failedVisits, sessionsCreated: 0 },
  });

  logEvent({
    severity: failedVisits > 0 ? 'warn' : 'info',
    function: 'manageBookingSeries',
    event: 'admin.bookingSeries.cancelled',
    uid,
    extra: { batchId: args.batchId, affectedVisits: succeeded, failedVisits },
  });

  // #533: the household hears the answer to their request. ONE dispatch for the
  // whole envelope, on the #532 grain, and only when this CANCEL was a decline.
  // Dispatched here rather than from a trigger because envelope-status writes
  // come from this callable AND from onKinCareRollup, so a trigger would either
  // double-fire or need a flag to tell the two apart. Both admin clients call
  // this callable, so Android's deny path is covered by the same line.
  if (isDecliningRequest) {
    try {
      const recipientUid = await resolveKinfolkUid(args.kinfolkId);
      await enqueueNotification({
        key: 'kincare.request.declined',
        recipientUid: recipientUid ?? '',
        data: {
          kinfolkId: args.kinfolkId,
          batchId: args.batchId,
          bookingId: args.batchId,
          serviceName: envelope?.['serviceName'] ?? null,
          startTimeMs: declinedStartMs[0] ?? null,
          startTimeMsList: declinedStartMs,
          visitCount: declinedStartMs.length,
          note: args.note ?? null,
        },
        targetType: 'booking',
        targetId: args.batchId,
      });
    } catch (err) {
      // The decision itself already succeeded and is audited. A failed
      // notification must not roll that back, but it must not be silent either:
      // a household left unanswered is the defect #533 exists to fix.
      logEvent({
        severity: 'warn',
        function: 'manageBookingSeries',
        event: 'notification.dispatch.failed',
        uid,
        extra: {
          kinfolkId: args.kinfolkId,
          batchId: args.batchId,
          key: 'kincare.request.declined',
          err: (err as Error)?.message,
        },
      });
    }
  }

  return validateResponse('manageBookingSeries', Result, {
    ok: true,
    action: args.action,
    batchId: args.batchId,
    affectedVisits: succeeded,
    sessionsCreated: 0,
    failedVisits,
  });
}

export const manageBookingSeries = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('manageBookingSeries', manageBookingSeriesHandler),
);
