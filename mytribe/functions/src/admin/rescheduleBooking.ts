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
import { guardCompanyHolidayConflict } from '../lib/companyHolidayConflict';
import { guardBookingBusyConflict } from '../lib/bookingBusyConflict';
import { guardVisitOverlapConflict } from '../lib/visitOverlapConflict';
import { validateResponse } from '../lib/callableResponse';

/**
 * 1E §A.9: server-bound reschedule of a kin_care_sessions doc. Shared by Schedule
 * drag-to-reschedule and Bookings bulk/per-card Reschedule. Reads the doc first
 * (404 if absent) so the audit records the actual before→after window. Gated by
 * wrapAdminCallable (admin custom claim).
 *
 * C1: a reschedule is a fresh slot request onto the NEW window just as much as
 * a create is, so it is guarded the same way (`guardCompanyHolidayConflict`,
 * no override) before the write lands.
 *
 * THE GAP C1 DOCUMENTED IS CLOSED, AND SO IS THE ONE IT DID NOT NAME (#397
 * M13). This header used to say `guardBookingBusyConflict` was "a separate
 * decision from this task's scope" — a hole left open by PR #183, which did not
 * count drag-to-reschedule among the write paths it closed. Making the drag
 * real on the admin Schedule grid is what turned that hole from a form nobody
 * used into a gesture, so it is closed here. With it goes a second one nobody
 * had written down: NOTHING compared the new window against the visits already
 * on the books, so a visit could be dropped straight on top of another.
 *
 * A reschedule is now guarded exactly as `createKinCareSession` is, plus the
 * one thing only a move needs: `excludeSessionId`, so a visit is never found
 * conflicting with the window it is being moved OUT of (without it, any nudge
 * shorter than the visit's own length would refuse itself). Both new guards are
 * overridable and the closure guard still is not; each module's header says why.
 */
export const Args = z.object({
  sessionId: z.string().min(1).max(120),
  startTime: z.string().min(1).max(40),
  endTime: z.string().min(1).max(40),
  /** Admin-only escape hatch for a Google Calendar busy import. Same flag and same meaning as on `createKinCareSession`. */
  overrideBusyConflict: z.boolean().optional(),
  /** Admin-only escape hatch for a visit already on the books. See `lib/visitOverlapConflict.ts`. */
  overrideVisitConflict: z.boolean().optional(),
});

export const Result = z
  .object({
    ok: z.literal(true),
    sessionId: z.string().min(1),
  })
  .strict();

export async function rescheduleBookingHandler(
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
      throw new HttpsError('invalid-argument', 'rescheduleBooking validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const ref = db().doc(`kin_care_sessions/${args.sessionId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', `Session '${args.sessionId}' not found.`);
  const prev = snap.data() as { startTime?: string; endTime?: string } | undefined;

  const candidate = [
    { startTimeMs: Date.parse(args.startTime), endTimeMs: Date.parse(args.endTime) },
  ];
  await guardCompanyHolidayConflict({ firestore: db(), visits: candidate });
  await guardBookingBusyConflict({
    firestore: db(),
    visits: candidate,
    actorUid: uid,
    actorRole: 'AUNTIE',
    override: args.overrideBusyConflict,
    auditContext: { sessionId: args.sessionId, attempt: 'reschedule' },
  });
  await guardVisitOverlapConflict({
    firestore: db(),
    visits: candidate,
    actorUid: uid,
    actorRole: 'AUNTIE',
    // The visit being moved must not collide with where it currently is.
    excludeSessionId: args.sessionId,
    override: args.overrideVisitConflict,
    attempt: 'reschedule',
    auditContext: { sessionId: args.sessionId },
  });

  await ref.set(
    { startTime: args.startTime, endTime: args.endTime, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid },
    { merge: true },
  );

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.RESCHEDULE_BOOKING,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    payload: {
      sessionId: args.sessionId,
      fromStart: prev?.startTime ?? null,
      toStart: args.startTime,
      fromEnd: prev?.endTime ?? null,
      toEnd: args.endTime,
    },
  });

  logEvent({
    severity: 'info',
    function: 'rescheduleBooking',
    event: 'admin.booking.rescheduled',
    uid,
    extra: { sessionId: args.sessionId, toStart: args.startTime },
  });

  return validateResponse('rescheduleBooking', Result, { ok: true, sessionId: args.sessionId });
}

export const rescheduleBooking = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('rescheduleBooking', rescheduleBookingHandler),
);
