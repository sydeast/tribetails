import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
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
 * A kinfolk PROPOSES a new time for a visit (issue #399, item 2).
 *
 * Modelled field for field on `requestBookingCancellation`, and for the same
 * reason: this is an ASK, not a change. The visit keeps its time and its
 * status until the office rules on it. `admin/rescheduleBooking` is the only
 * thing that moves a visit, it is admin-gated, and it stays that way. A
 * household that could move its own visit could move it on top of another
 * household's, past the closure guard, and around the busy check the office
 * relies on.
 *
 * What lands on the kinCares doc is the proposal plus its state:
 * `rescheduleRequestedAt` / `rescheduleRequestedByUid` /
 * `rescheduleRequestReason` / `rescheduleRequestedStartTime` /
 * `rescheduleRequestedEndTime` / `rescheduleRequestStatus: 'pending'`.
 * `onBookingsWrite` watches the flag's first appearance and fires
 * `kincare.reschedule.requested` to the office;
 * `admin/resolveBookingRescheduleRequest` is the other end.
 *
 * A second request while one is pending is refused rather than silently
 * overwriting the first: the office may already be acting on the time it was
 * shown, and a proposal that changes underneath them is worse than a refusal
 * naming the pending one.
 */
export const Args = z.object({
  kinfolkId: z.string().min(1).max(200).optional(),
  batchId: z.string().min(1).max(200),
  visitId: z.string().min(1).max(200),
  /** Proposed start, epoch milliseconds. Must be in the future. */
  proposedStartTimeMs: z.number().int().positive(),
  /**
   * Proposed end, epoch milliseconds. OPTIONAL, and deliberately not also
   * nullable: when omitted the visit keeps its current duration, which is what
   * a household moving a 30-minute drop-in to a different hour means, and is
   * one fewer control on the screen. Kotlin has one nullable type and cannot
   * tell an absent key from a present null, so the contract generator refuses
   * `.nullable().optional()` on a request outright.
   */
  proposedEndTimeMs: z.number().int().positive().optional(),
  reason: z.string().trim().max(500).optional(),
});

export const Result = z
  .object({
    ok: z.literal(true),
    visitId: z.string().min(1),
    /** Echoes what was recorded, so no client has to trust its own arithmetic. */
    proposedStartTimeMs: z.number().int(),
    proposedEndTimeMs: z.number().int().nullable(),
  })
  .strict();

/** Same set `requestBookingCancellation` allows: a visit already underway is not moved by asking. */
const RESCHEDULABLE = new Set(['requested', 'confirmed']);

/** Furthest ahead a household may propose. A year out is a typo, not a plan. */
const MAX_LEAD_MS = 365 * 24 * 60 * 60 * 1000;

export async function requestBookingRescheduleHandler(
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
      throw new HttpsError('invalid-argument', 'requestBookingReschedule validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const now = Date.now();
  if (args.proposedStartTimeMs <= now) {
    throw new HttpsError('invalid-argument', 'Pick a time in the future for the new visit.');
  }
  if (args.proposedStartTimeMs > now + MAX_LEAD_MS) {
    throw new HttpsError('invalid-argument', 'Pick a new time within the next year.');
  }
  if (args.proposedEndTimeMs != null && args.proposedEndTimeMs <= args.proposedStartTimeMs) {
    throw new HttpsError('invalid-argument', 'The new visit has to end after it starts.');
  }

  const { kinfolkId } = await resolveKinfolkAccess(
    uid,
    args.kinfolkId,
    req.auth?.token?.admin === true,
    'requestBookingReschedule',
  );
  const visitRef = db().doc(
    `families/${kinfolkId}/bookings/${args.batchId}/kinCares/${args.visitId}`,
  );
  const snap = await visitRef.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Visit not found.');
  const data = snap.data() as {
    status?: string;
    rescheduleRequestStatus?: string;
    startTime?: { toMillis?: () => number } | null;
    endTime?: { toMillis?: () => number } | null;
  };

  if (!RESCHEDULABLE.has(data.status ?? '')) {
    throw new HttpsError(
      'failed-precondition',
      'Only a requested or confirmed visit can ask for a new time.',
    );
  }
  if (data.rescheduleRequestStatus === 'pending') {
    throw new HttpsError(
      'already-exists',
      'A new time is already waiting on Tribe Tails for this visit.',
    );
  }

  // Omitted end: keep the visit's current length. A visit with no end time on
  // record gets none on the proposal either, rather than a guessed duration.
  const currentStartMs = millisOf(data.startTime);
  const currentEndMs = millisOf(data.endTime);
  const proposedEndMs =
    args.proposedEndTimeMs ??
    (currentStartMs !== null && currentEndMs !== null
      ? args.proposedStartTimeMs + (currentEndMs - currentStartMs)
      : null);

  await visitRef.set(
    {
      rescheduleRequestedAt: FieldValue.serverTimestamp(),
      rescheduleRequestedByUid: uid,
      rescheduleRequestReason: args.reason?.trim() || null,
      rescheduleRequestedStartTime: Timestamp.fromMillis(args.proposedStartTimeMs),
      rescheduleRequestedEndTime: proposedEndMs !== null ? Timestamp.fromMillis(proposedEndMs) : null,
      rescheduleRequestStatus: 'pending',
      // Cleared so a decline followed by a fresh proposal does not still show
      // the previous answer beside the new ask.
      rescheduleResponseNote: null,
      rescheduleResolvedAt: null,
      rescheduleResolvedByUid: null,
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
    description: 'Kinfolk proposed a new time for a visit',
    payload: {
      kinfolkId,
      batchId: args.batchId,
      visitId: args.visitId,
      proposedStartTimeMs: args.proposedStartTimeMs,
      proposedEndTimeMs: proposedEndMs,
      reason: args.reason ?? null,
    },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'requestBookingReschedule',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  logEvent({
    severity: 'info',
    function: 'requestBookingReschedule',
    event: 'portal.booking.reschedule_requested',
    uid,
    extra: { kinfolkId, batchId: args.batchId, visitId: args.visitId },
  });
  return validateResponse('requestBookingReschedule', Result, {
    ok: true,
    visitId: args.visitId,
    proposedStartTimeMs: args.proposedStartTimeMs,
    proposedEndTimeMs: proposedEndMs,
  });
}

/** Epoch millis off a Firestore Timestamp, or null when the field is absent. */
function millisOf(v: { toMillis?: () => number } | null | undefined): number | null {
  const ms = v?.toMillis?.();
  return typeof ms === 'number' ? ms : null;
}

export const requestBookingReschedule = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('requestBookingReschedule', requestBookingRescheduleHandler),
);
