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
import { materializeKinRoster, resolveKinfolkDisplayName } from '../lib/kinRoster';
import { guardBookingBusyConflict } from '../lib/bookingBusyConflict';
import { guardCompanyHolidayConflict } from '../lib/companyHolidayConflict';
import { guardVisitOverlapConflict } from '../lib/visitOverlapConflict';

/**
 * 1E §A.9: server-bound creation of a kin_care_sessions doc (scheduleNewVisit).
 * Replaces client-side session writes so the audit entry is issued server-side
 * and structurally bound to the actual mutation (matches the triageOrphanReport
 * pattern). Gated by wrapAdminCallable (admin custom claim).
 *
 * THIS IS THE "ONE-OFF VISIT" WRITER, and it is not the booking wizard. The
 * wizard (`createMultiDateBookingRequest`) mints an ENVELOPE the office then
 * approves; this one puts a `SCHEDULED` visit on the calendar directly, which
 * is what the admin Schedule screen's New visit action needs (#397 M12) and
 * what `approveBookingSeriesCore` invokes when an envelope is approved.
 *
 * PRICING IS BY `serviceType`, WHICH IS A `serviceRates` KEY, NOT FREE TEXT.
 * A session carries no price field at all: the only route from a visit to money
 * is `listUninvoicedSessions` joining this document's `serviceType` against
 * `business_settings.serviceRates` (see its own header, "A SESSION CARRIES NO
 * PRICE"). A `serviceType` the rate card does not carry is reported as
 * `unpriceable` and has to have a number typed in by hand at invoice time. That
 * is the same `serviceRates`-first catalog PR #569 taught `resolveService` to
 * read for the envelope path, reached here by a different route: the flat
 * session model has no `serviceId` to resolve, so the client must pick the
 * canonical NAME (`serviceOptionsFromRates` on web,
 * `EnhancedSchedulingViewModel`'s options on Android) rather than type one.
 */
const Args = z.object({
  kinfolkId: z.string().min(1).max(120),
  kinIds: z.array(z.string().min(1).max(120)).max(50).default([]),
  serviceType: z.string().min(1).max(120),
  startTime: z.string().min(1).max(40),
  endTime: z.string().min(1).max(40),
  serviceDurationMinutes: z.number().int().min(0).max(24 * 60).optional(),
  notes: z.string().max(4000).optional(),
  /** Additive, optional. See `overrideBusyConflict` on `createMultiDateBookingRequest.ts` Args for the full rationale; this is the same admin-only escape hatch. */
  overrideBusyConflict: z.boolean().optional(),
  /**
   * The second escape hatch, and a DIFFERENT one: `overrideBusyConflict` is
   * about the operator's imported Google calendar, this is about a visit
   * already on the books. They are separate flags because they are separate
   * decisions — "I know my calendar says I'm busy" is not "I know this
   * household's hour is already promised" — and the audit trail records which
   * one was taken. See `lib/visitOverlapConflict.ts`.
   */
  overrideVisitConflict: z.boolean().optional(),
});

export interface CreateKinCareSessionResult {
  ok: true;
  sessionId: string;
}

export async function createKinCareSessionHandler(
  req: CallableRequest<unknown>,
): Promise<CreateKinCareSessionResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'createKinCareSession validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  await guardBookingBusyConflict({
    firestore: db(),
    visits: [{ startTimeMs: Date.parse(args.startTime), endTimeMs: Date.parse(args.endTime) }],
    actorUid: uid,
    actorRole: 'AUNTIE',
    override: args.overrideBusyConflict,
    auditContext: { kinfolkId: args.kinfolkId },
  });
  // A closed day always refuses the write -- no override. See
  // companyHolidayConflict.ts's header for why this guard has none.
  await guardCompanyHolidayConflict({
    firestore: db(),
    visits: [{ startTimeMs: Date.parse(args.startTime), endTimeMs: Date.parse(args.endTime) }],
  });
  // #397 M12: and is the hour already promised to somebody? Neither guard above
  // asks that — one reads the imported calendar, the other reads the closure
  // list, and nothing read `kin_care_sessions` itself, so a second visit could
  // be written straight on top of the first.
  await guardVisitOverlapConflict({
    firestore: db(),
    visits: [{ startTimeMs: Date.parse(args.startTime), endTimeMs: Date.parse(args.endTime) }],
    actorUid: uid,
    actorRole: 'AUNTIE',
    override: args.overrideVisitConflict,
    attempt: 'create_visit',
    auditContext: { kinfolkId: args.kinfolkId, serviceType: args.serviceType },
  });

  // R1: no kinIds stated means the whole household, materialized here rather
  // than stored as the literal `[]` (see lib/kinRoster.ts).
  const { kinIds, kinNames } = await materializeKinRoster(args.kinfolkId, args.kinIds);
  // Stamped from `kinfolk/{kinfolkId}` rather than taken from the caller: every
  // visit list renders this field directly and this writer never set it, so
  // every ad-hoc visit read as "Unnamed Kinfolk". See `resolveKinfolkDisplayName`.
  const kinfolkName = await resolveKinfolkDisplayName(args.kinfolkId);
  const ref = await db().collection('kin_care_sessions').add({
    kinfolkId: args.kinfolkId,
    kinfolkName,
    kinIds,
    kinNames,
    serviceType: args.serviceType,
    startTime: args.startTime,
    endTime: args.endTime,
    serviceDurationMinutes: args.serviceDurationMinutes ?? 0,
    notes: args.notes ?? '',
    status: 'SCHEDULED',
    createdAt: FieldValue.serverTimestamp(),
    createdBy: uid,
    updatedAt: FieldValue.serverTimestamp(),
  });

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.CREATE_KINCARE_SESSION,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    payload: { sessionId: ref.id, kinfolkId: args.kinfolkId, serviceType: args.serviceType, startTime: args.startTime },
  });

  logEvent({
    severity: 'info',
    function: 'createKinCareSession',
    event: 'admin.kinCareSession.created',
    uid,
    extra: { sessionId: ref.id, kinfolkId: args.kinfolkId },
  });

  return { ok: true, sessionId: ref.id };
}

export const createKinCareSession = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('createKinCareSession', createKinCareSessionHandler),
);
