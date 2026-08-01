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

/**
 * 1E §A.9: server-bound reschedule of a kin_care_sessions doc. Shared by Schedule
 * drag-to-reschedule and Bookings bulk/per-card Reschedule. Reads the doc first
 * (404 if absent) so the audit records the actual before→after window. Gated by
 * wrapAdminCallable (admin custom claim).
 *
 * C1: a reschedule is a fresh slot request onto the NEW window just as much as
 * a create is, so it is guarded the same way (`guardCompanyHolidayConflict`,
 * no override) before the write lands. Not guarded against
 * `guardBookingBusyConflict` here -- that was a pre-existing gap left open by
 * PR #183 (drag-to-reschedule was not one of the write paths it closed) and is
 * a separate decision from this task's scope; the company-holiday guard is
 * new with this task and closing it for reschedule from the start avoids
 * introducing a matching gap on day one.
 */
const Args = z.object({
  sessionId: z.string().min(1).max(120),
  startTime: z.string().min(1).max(40),
  endTime: z.string().min(1).max(40),
});

export interface RescheduleBookingResult {
  ok: true;
  sessionId: string;
}

export async function rescheduleBookingHandler(
  req: CallableRequest<unknown>,
): Promise<RescheduleBookingResult> {
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

  await guardCompanyHolidayConflict({
    firestore: db(),
    visits: [{ startTimeMs: Date.parse(args.startTime), endTimeMs: Date.parse(args.endTime) }],
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

  return { ok: true, sessionId: args.sessionId };
}

export const rescheduleBooking = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('rescheduleBooking', rescheduleBookingHandler),
);
