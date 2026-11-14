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
import { materializeKinRoster, resolveKinfolkDisplayName } from '../lib/kinRoster';
import { guardBookingBusyConflict } from '../lib/bookingBusyConflict';
import { guardCompanyHolidayConflict } from '../lib/companyHolidayConflict';
import { guardVisitOverlapConflict } from '../lib/visitOverlapConflict';
import type { HouseholdNotice } from './dispatchVisitNotification';

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
 *
 * ISSUE #1575: A NEW VISIT IS A ONE-VISIT BOOKING RECORD, ALREADY CONFIRMED.
 * This used to `add()` a bare `kin_care_sessions` row and nothing else. The
 * Auntie assignment and both note threads live on the booking record
 * (`families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}`), addressed from
 * the session by `kinCareBatchId` / `kinCareVisitId`, so a New visit could not
 * be staffed or noted on any client: every visit sheet said "This visit is not
 * part of a booking request". It now writes the same three documents an
 * approved request ends up with, in one batch:
 *
 *   families/{kinfolkId}/bookings/{batchId}           envelopeStatus 'confirmed'
 *   .../kinCares/{visitId}                             status 'confirmed', sessionId set
 *   kin_care_sessions/vis_{visitId}                    SCHEDULED, linked both ways
 *
 * `vis_{visitId}` is the session id every server path derives from a visit id
 * (`approveBookingSeriesCore`, `manageBookingSeries`, `batchUpdateBookings`),
 * so the new session is reachable from its visit exactly as an approved one is.
 *
 * WHAT IT DELIBERATELY DOES NOT CHANGE:
 *  - The triggers send nothing. `onBookingEnvelopeCreate` already ignores an
 *    envelope created confirmed; the visit carries `seriesApprovedAt`, which is
 *    how `onBookingsWrite` knows the confirmation was decided by the code that
 *    wrote the whole set (the approve core's stamp, read by nothing else), so
 *    it sends no per-visit "your visit is confirmed".
 *    #1841 (operator ruling 2026-11-12): the household's confirmation is the
 *    admin's choice, made on the New visit form (`notifyHousehold`), and this
 *    call sends it itself, once, so the form can say who was told. Never for a
 *    visit recorded as already completed.
 *  - No default assignee. `writeEnvelope` starts a household's request on the
 *    admin's plate; a New visit starts unassigned, because choosing the Auntie
 *    is the step this issue makes possible, and an assignee on create would
 *    fire `assignment.assigned` from the trigger.
 *  - The staff `notes` stay on the SESSION only. The visit's own `notes` is
 *    what the household's portal shows, and the office's note is not theirs.
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
  /**
   * #1630: the Android admin's own booking (`enhanced_bookings/{id}`) this visit
   * is the approval of. Optional; absent for Schedule > New visit.
   *
   * With it the record ids are DETERMINISTIC (`enh_{id}`), so approving the same
   * booking twice lands on the same three documents instead of two visits: the
   * second call returns the visit the first one wrote and writes nothing. The
   * id is stored on the session as `enhancedBookingId`, which is what Android's
   * linked-session lookup and cancel cascade now read.
   */
  enhancedBookingId: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9_-]+$/, 'enhancedBookingId must be a Firestore document id')
    .optional(),
  /**
   * #1574: the office is writing down a visit that already happened. Required
   * for a window that has ended and refused for one that has not; see
   * `lib/pastVisit.ts` and the handler's note below.
   */
  recordAsCompleted: z.boolean().optional(),
  /**
   * #1841: send the household "KinCare booking confirmed" for this visit. The
   * New visit form's "Send the household a confirmation" control, on by
   * default there. ABSENT MEANS NO SEND, so every other caller (an Android
   * approval, an installed client from before this) sends exactly what it did.
   * Ignored for a visit recorded as completed, which is never announced.
   */
  notifyHousehold: z.boolean().optional(),
});

/**
 * #1581: the stated length when it is a real one, else the window's span in
 * whole minutes, else 0 (nothing readable to go on). Same arithmetic as
 * `approveBookingSeriesCore`'s `durationMinutes`.
 */
export function visitLengthMinutes(stated: number | undefined, startIso: string, endIso: string): number {
  if (typeof stated === 'number' && stated > 0) return stated;
  const s = Date.parse(startIso);
  const e = Date.parse(endIso);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return 0;
  return Math.round((e - s) / 60_000);
}

export interface CreateKinCareSessionResult {
  ok: true;
  sessionId: string;
  /**
   * #1841: what the household was told about the new visit. Present on every
   * new write: `not_requested` when the form's control was off or the visit was
   * recorded as completed. Absent on a replay of an approval already made.
   */
  notice?: HouseholdNotice;
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

  // #1630: an approval already turned into a visit is answered with that visit,
  // BEFORE the guards: the overlap guard would otherwise read the visit this
  // same booking already made and refuse the retry as a clash with itself.
  const enhancedId = args.enhancedBookingId ?? null;
  if (enhancedId !== null) {
    const existing = await db().collection('kin_care_sessions').doc(`vis_enh_${enhancedId}`).get();
    if (existing.exists) {
      logEvent({
        severity: 'info',
        function: 'createKinCareSession',
        event: 'admin.kinCareSession.alreadyCreated',
        uid,
        extra: { sessionId: existing.id, enhancedBookingId: enhancedId },
      });
      return { ok: true, sessionId: existing.id };
    }
  }

  // #1574, operator ruling 2026-11-05: a past-dated visit is "allowed only as
  // already completed ... never Scheduled". Decided before any guard, so a past
  // date reports that rather than a calendar clash. `lib/pastVisit` is loaded
  // here rather than at file scope (#1714): see coldStartImportGraph.test.ts.
  const { businessTimeZoneReader, newVisitStatusFor } = await import('../lib/pastVisit.js');
  const status = await newVisitStatusFor({
    startTime: args.startTime,
    endTime: args.endTime,
    nowMs: Date.now(),
    recordAsCompleted: args.recordAsCompleted === true,
    timeZone: businessTimeZoneReader(),
  });
  const backdated = status === 'COMPLETED';

  // A RECORD OF A VISIT THAT ALREADY HAPPENED SKIPS TWO OF THE THREE GUARDS.
  // The busy import and the closure list answer "may this hour be booked?",
  // which has no meaning for an hour that is over: the visit happened, and the
  // closure guard has no override, so running it would make a real visit on a
  // closed day impossible to write down. The overlap guard still runs (and is
  // still overridable): a second record over the same hour is most often the
  // same visit written down twice.
  if (!backdated) await guardBookingBusyConflict({
    firestore: db(),
    visits: [{ startTimeMs: Date.parse(args.startTime), endTimeMs: Date.parse(args.endTime) }],
    actorUid: uid,
    actorRole: 'AUNTIE',
    override: args.overrideBusyConflict,
    auditContext: { kinfolkId: args.kinfolkId },
  });
  // A closed day always refuses the write -- no override. See
  // companyHolidayConflict.ts's header for why this guard has none.
  if (!backdated) await guardCompanyHolidayConflict({
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
  // #1575: the booking record and its one visit, then the session linked to
  // both, in ONE batch so no reader ever sees a session pointing at a visit that
  // is not there (or the reverse). See the header.
  const firestore = db();
  // #1630: deterministic for an Android booking's approval (see Args), minted otherwise.
  const bookings = firestore.collection('families').doc(args.kinfolkId).collection('bookings');
  const parentRef = enhancedId !== null ? bookings.doc(`enh_${enhancedId}`) : bookings.doc();
  const batchId = parentRef.id;
  const visitRef = enhancedId !== null ? parentRef.collection('kinCares').doc(`enh_${enhancedId}`) : parentRef.collection('kinCares').doc();
  const visitId = visitRef.id;
  const ref = firestore.collection('kin_care_sessions').doc(`vis_${visitId}`);
  const startMs = Date.parse(args.startTime);
  const endMs = Date.parse(args.endTime);
  const startTs = Number.isFinite(startMs) ? Timestamp.fromMillis(startMs) : null;
  const endTs = Number.isFinite(endMs) ? Timestamp.fromMillis(endMs) : null;

  const batch = firestore.batch();
  // #1726: the record's two documents come from `officeBookingRecordDocs`, the
  // shape `transitionBookingStatus` also writes when it approves a session that
  // has no record. #1574: a backdated record is completed from birth there too;
  // neither booking trigger sends anything for it (`onBookingEnvelopeCreate`
  // answers only an envelope created `requested`, and `onBookingsWrite` on a
  // visit created `completed` reaches no dispatch).
  // Loaded here, not at file scope (#1714): see coldStartImportGraph.test.ts.
  const { officeBookingRecordDocs } = await import('../lib/officeBookingRecord.js');
  const record = officeBookingRecordDocs({
    kinfolkId: args.kinfolkId,
    uid,
    batchId,
    visitId,
    sessionId: ref.id,
    serviceType: args.serviceType,
    startTs,
    endTs,
    kinIds,
    kinNames,
    backdated,
    householdNote: null,
  });
  batch.set(parentRef, record.envelope);
  batch.set(visitRef, record.visit);
  batch.set(ref, {
    kinfolkId: args.kinfolkId,
    kinfolkName,
    kinIds,
    kinNames,
    serviceType: args.serviceType,
    startTime: args.startTime,
    endTime: args.endTime,
    // #1581: the visit's own window when the caller states no length (or 0),
    // never a stored 0 for a visit that plainly has one. Auntie Time read
    // "Visit length 0" for a 20:00 to 20:30 visit.
    serviceDurationMinutes: visitLengthMinutes(args.serviceDurationMinutes, args.startTime, args.endTime),
    notes: args.notes ?? '',
    status,
    // #1574: a backdated record is COMPLETED from birth and never passes
    // through `transitionBookingStatus`, so it starts no live visit (Auntie
    // Time lists only the on-the-books statuses). `completedAt` is when the
    // visit ended, not when it was typed in, and the marker keeps it findable:
    // it also skipped the operator's arrival-and-departure rule, which governs
    // the Complete step only. The booking record above is written completed
    // from birth too; see the note there on why that sends nothing.
    ...(backdated && { completedAt: args.endTime, recordedAfterTheFact: true }),
    sourceBookingId: visitId,
    kinCareBatchId: batchId,
    kinCareVisitId: visitId,
    // #1630: the Android booking this visit approves, or absent.
    ...(enhancedId !== null ? { enhancedBookingId: enhancedId } : {}),
    createdAt: FieldValue.serverTimestamp(),
    createdBy: uid,
    updatedAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.CREATE_KINCARE_SESSION,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    payload: {
      sessionId: ref.id,
      kinfolkId: args.kinfolkId,
      batchId,
      visitId,
      serviceType: args.serviceType,
      startTime: args.startTime,
      enhancedBookingId: enhancedId,
      status,
      recordedAfterTheFact: backdated,
    },
  });

  logEvent({
    severity: 'info',
    function: 'createKinCareSession',
    event: 'admin.kinCareSession.created',
    uid,
    extra: { sessionId: ref.id, kinfolkId: args.kinfolkId, batchId, visitId },
  });

  // #1841: after the write, so a confirmation names a visit that exists.
  const householdNotices = await import('../notifications/householdNotice.js');
  let notice: HouseholdNotice;
  // The visit is written by now: a failed read of the confirmation's payload
  // is "could not be sent", never a refusal the admin would retry into a
  // second visit.
  const confirmData =
    args.notifyHousehold === true && !backdated
      ? await import('./approveBookingSeriesCore.js')
          .then(({ bookingConfirmData }) =>
            bookingConfirmData({
              kinfolkId: args.kinfolkId,
              batchId,
              envelope: record.envelope as Record<string, unknown>,
              householdNote: '',
            }),
          )
          .then(({ data }) => data)
          .catch((err: unknown) => {
            logEvent({
              severity: 'warn',
              function: 'createKinCareSession',
              event: 'household.notice.payload.failed',
              uid,
              extra: { sessionId: ref.id, kinfolkId: args.kinfolkId },
              errorMessage: (err as Error)?.message,
            });
            return null;
          })
      : null;
  if (args.notifyHousehold === true && !backdated && confirmData === null) {
    notice = await householdNotices.householdNoticeNotSent(args.kinfolkId, 'dispatch_failed');
  } else if (confirmData !== null) {
    const data = confirmData;
    notice = await householdNotices.sendHouseholdNotice(
      args.kinfolkId,
      {
        key: 'kincare.booking.confirm',
        data,
        actorUid: uid,
        targetType: 'booking',
        targetId: batchId,
        dedupeKey: `booking:${batchId}:new_visit`,
      },
      'createKinCareSession',
    );
  } else {
    notice = await householdNotices.householdNoticeNotSent(args.kinfolkId, 'not_requested');
  }

  return { ok: true, sessionId: ref.id, notice };
}

export const createKinCareSession = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('createKinCareSession', createKinCareSessionHandler),
);
