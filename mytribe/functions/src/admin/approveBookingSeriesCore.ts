import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { materializeKinRoster } from '../lib/kinRoster';
import { guardBookingBusyConflict } from '../lib/bookingBusyConflict';
import { guardCompanyHolidayConflict } from '../lib/companyHolidayConflict';
import { guardVisitOverlapConflict } from '../lib/visitOverlapConflict';
import { businessCalendarDate, businessTimeZone } from '../lib/bookingTimeBlocks';
import { kinCareLengthMinutes } from '../portal/getServiceCatalog';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';
import { enqueueNotification } from '../notifications/dispatcher';
import {
  AUNTIE_SCHEDULE_URL,
  buildVisitDateData,
  formatBookingDate,
  formatBookingTime,
  formatRequestedDate,
  isNotHappeningStatus,
  loadBusinessTimeZone,
  loadEnvelopeVisits,
} from '../notifications/visitDates';

/**
 * Shared APPROVE core for a booking series (parent envelope
 * `families/{kinfolkId}/bookings/{batchId}` + its `kinCares/{visitId}` children).
 *
 * Extracted from manageBookingSeries so it can be reused by:
 *   1. the admin manageBookingSeries callable (action=APPROVE), and
 *   2. requestBooking's auto-confirm path for repeat kinfolk (#9, 2026-06-08).
 *
 * Flips every child to `confirmed`, creates the linked kin_care_sessions doc the
 * auntie actually runs (deterministic id `vis_{visitId}` so a double-approve
 * collapses to ONE doc), rolls the envelope status + counts, and writes the
 * audit entry. Each visit is isolated so one bad visit cannot abort the series.
 *
 * Each visit is also checked against Google Calendar busy imports
 * (`lib/bookingBusyConflict.ts`) AND company holidays
 * (`lib/companyHolidayConflict.ts`) immediately before its session is
 * created, same isolation: a conflict fails that one visit rather than the
 * batch. The holiday re-check matters here specifically: an operator can add
 * a closure AFTER a request was submitted but BEFORE it is approved, and this
 * is the moment a real `kin_care_sessions` doc -- the thing Auntie Time and
 * billing actually read -- gets created.
 *
 * #536: IT ALSO SENDS THE ANSWER, once for the whole request.
 *
 * `kincare.booking.confirm` used to come from `onBookingsWrite`, which is
 * registered one level down on `.../kinCares/{visitId}`. A household asking for
 * a long weekend writes four visits, so approving it sent four "your visit is
 * confirmed" messages per channel -- and four more to every business admin, via
 * the key's `secondaryResolver` -- for what the household experiences as one
 * answer to one question. That is #532's defect on the approve side, and it
 * predates the admin queue: `requestBooking`'s `maybeAutoConfirm` has always
 * taken this path, so an auto-confirmed multi-visit request sent N copies too.
 *
 * AND THE ASSIGNED AUNTIE'S SUMMARY, also once. `writeEnvelope` stamps the same
 * default assignee on every child, so the per-visit trigger sent her four "a
 * visit is yours" messages for the same long weekend, before anyone had approved
 * it. She hears here instead, when the work is real, and only about her own days.
 *
 * The dispatch lives HERE rather than on a trigger over the envelope's
 * `envelopeStatus`, for the reason `manageBookingSeries` records for the decline
 * dispatch: envelope-status writes come from this function AND from
 * `onKinCareRollup`, so a trigger would either double-fire or need a flag to
 * tell them apart. Both admin clients and the portal's auto-confirm reach this
 * one function, so all three surfaces are fixed by the one line.
 */

/** kinCares stores start/end as Firestore Timestamps; kin_care_sessions stores
 *  them as ISO-8601 strings. Convert defensively (Timestamp | string | null). */
export function toIso(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  const ts = v as { toDate?: () => Date };
  if (typeof ts.toDate === 'function') return ts.toDate().toISOString();
  return '';
}

export function durationMinutes(startIso: string, endIso: string): number {
  if (!startIso || !endIso) return 0;
  const s = Date.parse(startIso);
  const e = Date.parse(endIso);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return 0;
  return Math.round((e - s) / 60000);
}

export interface ApproveBookingSeriesResult {
  affectedVisits: number;
  sessionsCreated: number;
  failedVisits: number;
  /**
   * 'confirmed' when every live visit succeeded; 'requested' on partial failure;
   * 'cancelled' (#1101) when every visit was already cancelled, as CANCEL labels it.
   */
  envelopeStatus: 'confirmed' | 'requested' | 'cancelled';
  /** false when the parent envelope does not exist (nothing approved). */
  found: boolean;
  /**
   * Visits that were NOT already confirmed when this ran (#536).
   *
   * Zero means the operator approved something that was already booked, which is
   * a real thing to do -- a stale queue row, a second click -- and the admin
   * surfaces must not report it as "booked, and the household has been told".
   * Nothing changed and nobody was told.
   */
  newlyConfirmed: number;
  /**
   * Whether the household's ONE confirmation actually went out (#536).
   *
   * The admin toast used to assert this rather than read it, and there are three
   * ways it is false: a partial failure (deliberately silent, so the retry is not
   * a second message), an approval whose confirmation another caller had already
   * claimed, and a dispatch that threw. A request that is on the schedule while
   * the household does not know about it is precisely the state an operator has
   * to be told about, because the fix is to phone them.
   */
  householdNotified: boolean;
}

/** A visit awaiting its start (#1098), with the window the operator just gave it. */
interface ResolvedStartTime {
  startMs: number;
  endMs: number;
}

/**
 * #1098 / #1101: a visit nobody wants any more (the household cancelled it, or
 * the office marked it unavailable). It gets no session, no flip to confirmed,
 * no place in the confirmation and no count, and it must not block the rest of
 * the request. A night awaiting a start time needs no time either.
 *
 * The rule is the one the confirmation message already applies
 * (`visitDates.loadEnvelopeVisits`): `cancelled` and `unavailable` are not
 * happening. It applies to every visit, timed or not.
 */
function isCalledOff(data: Record<string, unknown>): boolean {
  return isNotHappeningStatus(data['status']);
}
/** What to call a visit in a refusal: its KinCare's name, as the household saw it. */
function kinCareNameOf(data: Record<string, unknown>): string {
  for (const key of ['serviceName', 'serviceType', 'serviceId', 'title']) {
    const v = data[key];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return 'visit';
}

/**
 * #1098: THE START-TIME STEP, run before anything is written.
 *
 * An Overnight is requested as a NIGHT (`startTimePending: true`, a
 * `requestedDate`, no `startTime`), because the operator decides when it starts
 * after finishing the evening's other visits. Approving it IS setting that
 * time, so every visit awaiting one needs a time from `startTimes`, on its own
 * night in the business zone, and then gets the checks a timed request gets at
 * request time: the closed-day guard (no override), the Google busy guard and
 * the visit-overlap guard (both overridable, the same two flags
 * `rescheduleBooking` takes).
 *
 * EVERY REFUSAL HERE THROWS, deliberately unlike the per-visit isolation below.
 * A missing time must not half-approve a request (the timed visits next to the
 * night would otherwise be booked and the household told), and a busy or
 * overlap conflict has to reach the operator as the coded refusal their client
 * offers the override on, not as `failedVisits: 1`.
 *
 * Returns the window for each visit awaiting a time, keyed by visit id. Empty,
 * with no settings read, when no visit is awaiting one: every request written
 * before #1098 and every request with no Overnight in it.
 */
async function resolvePendingStartTimes(opts: {
  docs: FirebaseFirestore.QueryDocumentSnapshot[];
  startTimes: Record<string, number> | undefined;
  actorUid: string;
  actorRole: 'AUNTIE' | 'SYSTEM';
  kinfolkId: string;
  batchId: string;
  overrideBusyConflict?: boolean;
  overrideVisitConflict?: boolean;
}): Promise<Map<string, ResolvedStartTime>> {
  const resolved = new Map<string, ResolvedStartTime>();
  const pending = opts.docs.filter((d) => {
    const data = d.data() as Record<string, unknown>;
    return data['startTimePending'] === true && !isCalledOff(data);
  });
  if (pending.length === 0) return resolved;

  // Refuse the whole approval, naming every night still without a time.
  const missing = pending.filter((d) => {
    const ms = opts.startTimes?.[d.id];
    return typeof ms !== 'number' || !Number.isFinite(ms);
  });
  if (missing.length > 0) {
    const named = missing.map((d) => {
      const data = d.data() as Record<string, unknown>;
      const night = formatRequestedDate(data['requestedDate']);
      return night ? `the ${kinCareNameOf(data)} on ${night}` : `the ${kinCareNameOf(data)}`;
    });
    throw new HttpsError(
      'failed-precondition',
      `Set a start time for ${named.join(' and ')} before approving.`,
      { code: 'start_time_required', visitIds: missing.map((d) => d.id) },
    );
  }

  // The SAME zone reader `requestBooking` derived the night with, over the same
  // settings document, so the night and the check against it cannot disagree.
  const settingsSnap = await db().collection('business_settings').doc('business_settings').get();
  const settings = (settingsSnap.data() ?? {}) as Record<string, unknown>;
  const timeZone = businessTimeZone(settings);

  const windows: Array<{ visitId: string; startTimeMs: number; endTimeMs: number }> = [];
  for (const d of pending) {
    const data = d.data() as Record<string, unknown>;
    const name = kinCareNameOf(data);
    const startMs = opts.startTimes![d.id]!;
    const night = typeof data['requestedDate'] === 'string' ? (data['requestedDate'] as string) : null;
    if (night !== null && businessCalendarDate(startMs, timeZone) !== night) {
      throw new HttpsError(
        'invalid-argument',
        `The start time for the ${name} has to be on ${formatRequestedDate(night) ?? night}, the night the household asked for.`,
      );
    }

    const serviceId = typeof data['serviceId'] === 'string' ? (data['serviceId'] as string) : '';
    const minutes = serviceId ? kinCareLengthMinutes(serviceId, settings['serviceDurations']) : null;
    if (minutes == null) {
      throw new HttpsError(
        'invalid-argument',
        `The ${name} has no length set, so its end time cannot be worked out. Set its length in Settings, then approve again.`,
      );
    }

    const endMs = startMs + minutes * 60_000;
    resolved.set(d.id, { startMs, endMs });
    windows.push({ visitId: d.id, startTimeMs: startMs, endTimeMs: endMs });
  }

  const visits = windows.map((w) => ({ startTimeMs: w.startTimeMs, endTimeMs: w.endTimeMs }));
  const auditContext = {
    kinfolkId: opts.kinfolkId,
    batchId: opts.batchId,
    visitIds: windows.map((w) => w.visitId),
    attempt: 'approve_start_time',
  };

  // A closed day refuses for everybody, with no override; see companyHolidayConflict.ts.
  await guardCompanyHolidayConflict({ firestore: db(), visits });
  await guardBookingBusyConflict({
    firestore: db(),
    visits,
    actorUid: opts.actorUid,
    actorRole: opts.actorRole,
    override: opts.overrideBusyConflict,
    auditContext,
  });
  await guardVisitOverlapConflict({
    firestore: db(),
    visits,
    actorUid: opts.actorUid,
    actorRole: opts.actorRole,
    override: opts.overrideVisitConflict,
    attempt: 'approve_start_time',
    auditContext: { kinfolkId: opts.kinfolkId, batchId: opts.batchId, visitIds: auditContext.visitIds },
  });
  return resolved;
}

export async function approveBookingSeriesCore(opts: {
  kinfolkId: string;
  batchId: string;
  actorUid: string;
  actorRole: 'AUNTIE' | 'SYSTEM';
  /**
   * #1098: the operator's chosen start for each visit awaiting one, by visit id,
   * epoch ms. Required for every such visit; see {@link resolvePendingStartTimes}.
   */
  startTimes?: Record<string, number>;
  /** #1098: same meaning as on `rescheduleBooking`, applied to the visits whose start is set here. */
  overrideBusyConflict?: boolean;
  /** #1098: same meaning as on `rescheduleBooking`, applied to the visits whose start is set here. */
  overrideVisitConflict?: boolean;
}): Promise<ApproveBookingSeriesResult> {
  const { kinfolkId, batchId, actorUid, actorRole } = opts;
  const parentRef = db().doc(`families/${kinfolkId}/bookings/${batchId}`);
  const parentSnap = await parentRef.get();
  if (!parentSnap.exists) {
    return {
      affectedVisits: 0,
      sessionsCreated: 0,
      failedVisits: 0,
      envelopeStatus: 'requested',
      found: false,
      newlyConfirmed: 0,
      householdNotified: false,
    };
  }

  const envelope = parentSnap.data() as Record<string, unknown> | undefined;
  // Read BEFORE the loop flips anything: afterwards a re-approve of an already
  // confirmed envelope is indistinguishable from a first approval. An envelope
  // that was ALREADY confirmed is not a new answer to anybody, so it owes no
  // notification even though re-running the core is otherwise harmless (the
  // deterministic `vis_{visitId}` session id makes the writes idempotent).
  const wasAlreadyConfirmed = envelope?.['envelopeStatus'] === 'confirmed';

  const childSnap = await parentRef.collection('kinCares').get();
  const childIds = childSnap.docs.map((d) => d.id);

  // #1098: throws, before any write, unless every visit awaiting a start time
  // has a usable one. Visits that already have a time are not touched by it.
  const startTimeSet = await resolvePendingStartTimes({
    docs: childSnap.docs,
    startTimes: opts.startTimes,
    actorUid,
    actorRole,
    kinfolkId,
    batchId,
    overrideBusyConflict: opts.overrideBusyConflict,
    overrideVisitConflict: opts.overrideVisitConflict,
  });
  // Counted from the PRE-FLIP snapshot, for the same reason `wasAlreadyConfirmed`
  // is read before the loop: afterwards every child says `confirmed` and the
  // question "did this approval change anything" can no longer be answered.
  const newlyConfirmed = childSnap.docs.filter((d) => {
    const data = d.data() as Record<string, unknown>;
    return data['status'] !== 'confirmed' && !isCalledOff(data);
  }).length;

  // Household display name for the created sessions (read once; sessions render it
  // on Auntie Time / Home). Best-effort: fall back to the id if absent.
  let kinfolkName = (parentSnap.data()?.kinfolkName as string | undefined) ?? '';
  if (!kinfolkName) {
    const kinSnap = await db().collection('kinfolk').doc(kinfolkId).get();
    const kd = kinSnap.data() as Record<string, unknown> | undefined;
    const first = typeof kd?.firstName === 'string' ? kd.firstName : '';
    const last = typeof kd?.lastName === 'string' ? kd.lastName : '';
    kinfolkName = `${first} ${last}`.trim() || kinfolkId;
  }

  let sessionsCreated = 0;
  let failedVisits = 0;
  // #1098 / #1101: cancelled visits left alone; neither approved nor failed.
  let calledOff = 0;

  for (const doc of childSnap.docs) {
    const id = doc.id;
    let data = doc.data() as Record<string, unknown>;
    const childRef = parentRef.collection('kinCares').doc(id);
    const sessionRef = db().collection('kin_care_sessions').doc(`vis_${id}`);
    const setNow = startTimeSet.get(id);
    if (isCalledOff(data)) {
      calledOff += 1;
      continue;
    }

    try {
      if (setNow) {
        // #1098: THE HOUSEHOLD'S COPY GETS ITS TIME FIRST, the order
        // `rescheduleBooking` uses: if the session write below fails, the visit
        // already says when it is and a retry sees a timed visit. Written while
        // the status is still `requested`, so `onBookingsWrite` sends nothing
        // for it, and the confirmation below reads these live times.
        const startTime = Timestamp.fromMillis(setNow.startMs);
        const endTime = Timestamp.fromMillis(setNow.endMs);
        await childRef.set(
          { startTime, endTime, startTimePending: false, updatedAt: FieldValue.serverTimestamp() },
          { merge: true },
        );
        data = { ...data, startTime, endTime, startTimePending: false };
      }
      const existing = await sessionRef.get();
      if (!existing.exists) {
        const startIso = toIso(data.startTime);
        const endIso = toIso(data.endTime);
        // A session with no usable startTime is UNBILLABLE and silently so.
        // `toIso` degrades anything it cannot read to '', and every window over
        // this collection is a lexical range on the ISO string, so '' sorts
        // before any real date and the visit never appears in
        // listUninvoicedSessions, optimizeRoute, or the calendar push. The
        // household is never billed for work that was really done, and nothing
        // raises. Refuse instead: this throw lands in the per-visit catch
        // below, so the visit counts as failed, the envelope stays 'requested'
        // rather than claiming confirmed, and the operator sees it and retries.
        if (!startIso) {
          throw new Error(
            `kinCares/${id} has no readable startTime (${typeof data.startTime}); refusing to create an unbillable session`,
          );
        }
        // Re-checked here, not just at request time: this is the moment a
        // REAL kin_care_sessions doc is created, possibly long after the
        // request was submitted, and a new Google busy import can have landed
        // in between. A conflict throws into the catch below like any other
        // unusable visit (isolated per-visit; no override surface here).
        //
        // #1098: NOT for a visit whose start this approval set. It was checked
        // moments ago in `resolvePendingStartTimes`, where the operator CAN
        // override, and re-running the busy guard here without that override
        // would fail the very visit they chose to book over.
        if (!setNow) {
          await guardBookingBusyConflict({
            firestore: db(),
            visits: [{ startTimeMs: Date.parse(startIso), endTimeMs: endIso ? Date.parse(endIso) : null }],
            actorUid,
            actorRole,
          });

          // Same re-check, no override: a closure added after the request was
          // submitted must still stop the session from being created.
          await guardCompanyHolidayConflict({
            firestore: db(),
            visits: [{ startTimeMs: Date.parse(startIso), endTimeMs: endIso ? Date.parse(endIso) : null }],
          });
        }
        const statedKinIds = Array.isArray(data.kinIds)
          ? (data.kinIds as unknown[]).filter((k): k is string => typeof k === 'string')
          : [];
        // Same resolve requestBooking's writeEnvelope uses: this is the session
        // doc the auntie actually runs, and Android's Schedule Pets line reads
        // straight off of it, so a hardcoded [] here is the same bug even
        // though this write never wrote the literal `kinNames: []`.
        //
        // R1 applies at approve time too, and this is the one path that repairs
        // history in flight: an envelope written BEFORE the roster was
        // materialized still carries `kinIds: []`, and approving it would
        // otherwise mint a session covering nobody. Materializing here stamps
        // the roster as it stands the day the visit is confirmed, which is the
        // roster the Auntie will actually meet.
        const { kinIds, kinNames } = await materializeKinRoster(kinfolkId, statedKinIds);
        await sessionRef.set({
          kinfolkId,
          kinfolkName,
          kinIds,
          kinNames,
          serviceType:
            typeof data.serviceType === 'string'
              ? data.serviceType
              : typeof data.serviceName === 'string'
                ? data.serviceName
                : '',
          startTime: startIso,
          endTime: endIso,
          serviceDurationMinutes: durationMinutes(startIso, endIso),
          notes: typeof data.notes === 'string' ? data.notes : '',
          status: 'SCHEDULED',
          sourceBookingId: id,
          kinCareBatchId: batchId,
          kinCareVisitId: id,
          createdAt: FieldValue.serverTimestamp(),
          createdBy: actorUid,
          updatedAt: FieldValue.serverTimestamp(),
        });
        sessionsCreated += 1;
      }
      await childRef.set(
        {
          status: 'confirmed',
          sessionId: sessionRef.id,
          sourceBookingId: id,
          updatedAt: FieldValue.serverTimestamp(),
          // #536: mark WHY this visit became confirmed, so `onBookingsWrite` can
          // tell a series approval -- which is answered once, below -- from any
          // other write that confirms a single visit. `batchUpdateBookings` and
          // the Android write-back both flip `requested -> confirmed` on their
          // own and still owe the household their per-visit message, so the test
          // over there has to be this stamp and NOT the bare status transition.
          // Same trap #533 found on the decline side, where `requested ->
          // cancelled` had two opposite meanings.
          seriesApprovedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    } catch (err) {
      failedVisits += 1;
      logEvent({
        severity: 'error',
        function: 'approveBookingSeriesCore',
        event: 'visit.failed',
        uid: actorUid,
        extra: { batchId, visitId: id, err: (err as Error)?.message },
      });
    }
  }

  const succeeded = childIds.length - failedVisits - calledOff;
  // #1101: a request whose every visit was called off has nothing to confirm.
  // Label it the way CANCEL labels a fully cancelled envelope.
  const envelopeStatus: 'confirmed' | 'requested' | 'cancelled' =
    failedVisits > 0 ? 'requested' : succeeded === 0 && calledOff > 0 ? 'cancelled' : 'confirmed';
  await parentRef.set(
    {
      // Only mark the whole envelope confirmed when every visit succeeded; a partial
      // failure leaves it 'requested' so the admin retries (no false 'done').
      envelopeStatus,
      // #1098: `writeEnvelope` rolled these up from the visits that HAD an
      // instant, so a request of nights alone carries null. This approval has
      // just set times, so roll them again over every visit's start.
      ...(startTimeSet.size > 0 ? envelopeStartRollup(childSnap.docs, startTimeSet) : {}),
      confirmedCount: succeeded,
      cancelledCount: calledOff,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: actorUid,
    },
    { merge: true },
  );

  await writeAuditEntry({
    // Same shape as batchUpdateBookings (A4 audit follow-up): a series with
    // any failed visit did not fully do what it was asked, so it's audited
    // as FAILURE, not SUCCESS, even though counts also live in the payload.
    status: failedVisits === 0 ? 'SUCCESS' : 'FAILURE',
    event: AUDIT_EVENTS.APPROVE_BOOKING_SERIES,
    severity: failedVisits > 0 ? 'warn' : 'info',
    actorRole,
    actorUid,
    payload: { kinfolkId, batchId, affectedVisits: succeeded, failedVisits, sessionsCreated },
  });

  logEvent({
    severity: failedVisits > 0 ? 'warn' : 'info',
    function: 'approveBookingSeriesCore',
    event: 'bookingSeries.approved',
    uid: actorUid,
    extra: { batchId, affectedVisits: succeeded, failedVisits, sessionsCreated, actorRole },
  });

  const householdNotified =
    failedVisits === 0 && !wasAlreadyConfirmed && succeeded > 0
      ? await dispatchSeriesConfirmation({ kinfolkId, batchId, parentRef, envelope, actorUid })
      : false;

  return {
    affectedVisits: succeeded,
    sessionsCreated,
    failedVisits,
    envelopeStatus,
    found: true,
    newlyConfirmed,
    householdNotified,
  };
}

/**
 * #1098: the envelope's `firstStartTime` / `lastStartTime` over every visit
 * that now has a start: the ones this approval set and the ones that already had
 * one. A visit whose start will not read is left out, as `writeEnvelope` leaves
 * it out.
 */
function envelopeStartRollup(
  docs: FirebaseFirestore.QueryDocumentSnapshot[],
  setNow: Map<string, ResolvedStartTime>,
): { firstStartTime?: Timestamp; lastStartTime?: Timestamp } {
  const starts: number[] = [];
  for (const d of docs) {
    const set = setNow.get(d.id);
    if (set) {
      starts.push(set.startMs);
      continue;
    }

    const iso = toIso((d.data() as Record<string, unknown>)['startTime']);
    const ms = iso ? Date.parse(iso) : NaN;
    if (Number.isFinite(ms)) starts.push(ms);
  }
  if (starts.length === 0) return {};
  return {
    firstStartTime: Timestamp.fromMillis(Math.min(...starts)),
    lastStartTime: Timestamp.fromMillis(Math.max(...starts)),
  };
}

/**
 * The household's ONE answer to their request (#536), plus the office's copy via
 * the key's `businessAdmins` secondary resolver, plus ONE summary for each Auntie
 * the approved visits belong to.
 *
 * THE AUNTIE'S COPY, and why it is here rather than on the per-visit trigger.
 * `writeEnvelope` stamps the same default assignee on every child of a request,
 * so `onBookingsWrite` used to send her `assignment.assigned` once per child --
 * four "a visit is yours" messages for a long weekend, for work nobody had
 * approved yet. That trigger no longer dispatches anything on a request create;
 * she hears here instead, when the work is real, naming her own days. Her
 * per-visit SCHEDULE records are untouched: the loop above still writes one
 * `kin_care_sessions/vis_{visitId}` doc per visit, so every day still lands
 * separately on her schedule surface. Message noise went down; schedule fidelity
 * did not.
 *
 * GROUPED BY UID, not assumed to be one Auntie. `admin/assignAuntie` is per
 * visit, so a half-reassigned envelope genuinely owes two people two different
 * lists. Each still hears exactly once, about her own dates. An envelope with
 * nobody on it tells the household and nobody else.
 *
 * Both dispatches ride the SAME claim below, so a double-clicked approve cannot
 * double-send her either. Each is caught on its own: a household dispatch that
 * throws must not cost the Auntie her copy, and vice versa.
 *
 * IDEMPOTENCY. `confirmNotifiedAtMs` is CLAIMED in a transaction on the envelope
 * before anything is enqueued, and the claim is what decides who sends. Firestore
 * serialises transactions on a document, so two concurrent approvals of the same
 * batch -- a double-clicked button, a retried callable, an operator on web while
 * another is on Android -- contend on that one write and exactly one of them
 * wins. The loser sends nothing. A `wasAlreadyConfirmed` envelope never gets
 * this far, which covers envelopes confirmed before this shipped and therefore
 * carrying no claim field at all.
 *
 * A PARTIAL FAILURE SENDS NOTHING, deliberately, and the caller enforces that
 * before calling. The envelope is left `requested` so the operator can retry,
 * and the retry would otherwise be a second "your visits are confirmed" for the
 * same request -- #532's defect one step later. It also stops us telling a
 * household their request is booked while some of it is still sitting in the
 * queue: the decision has not been fully carried out yet. Same reasoning
 * `manageBookingSeries` records for the decline dispatch.
 *
 * A FAILED NOTIFICATION NEVER ROLLS BACK THE APPROVAL. The visits are booked and
 * audited by the time this runs. It is not silent either: the failure is logged
 * at `warn` with the key, because a household left unanswered is the defect this
 * whole path exists to fix.
 */
async function dispatchSeriesConfirmation(args: {
  kinfolkId: string;
  batchId: string;
  parentRef: FirebaseFirestore.DocumentReference;
  envelope: Record<string, unknown> | undefined;
  actorUid: string;
}): Promise<boolean> {
  const { kinfolkId, batchId, parentRef, envelope, actorUid } = args;
  try {
    // #832: the claim's time is also the approval's notification identity. The
    // claim already stops a second send for one approval; a cancel deletes the
    // claim, and a re-approval inside the dispatcher window is a new approval
    // with a new claim time, so it must not collide with the first one's ledger.
    const claimMs = Date.now();
    const claimed = await db().runTransaction(async (tx) => {
      const snap = await tx.get(parentRef);
      const already = (snap.data() as Record<string, unknown> | undefined)?.['confirmNotifiedAtMs'];
      if (typeof already === 'number') return false;
      tx.set(parentRef, { confirmNotifiedAtMs: claimMs }, { merge: true });
      return true;
    });
    if (!claimed) {
      logEvent({
        severity: 'info',
        function: 'approveBookingSeriesCore',
        event: 'bookingSeries.confirm.alreadyNotified',
        uid: actorUid,
        extra: { kinfolkId, batchId },
      });
      return false;
    }

    // Read the live child set rather than reusing the pre-flip snapshot: the
    // message names the days, and a visit cancelled between the request and the
    // approval must not appear in it. See notifications/visitDates.ts.
    const visits = await loadEnvelopeVisits(kinfolkId, batchId);
    const tz = await loadBusinessTimeZone();
    const dateData = buildVisitDateData(visits, tz);
    const firstMs = visits[0]?.startTimeMs ?? null;
    const recipientUid = await resolveKinfolkUid(kinfolkId);

    let householdNotified = false;
    try {
      await enqueueNotification({
        key: 'kincare.booking.confirm',
        recipientUid: recipientUid ?? '',
        data: {
          kinfolkId,
          batchId,
          // `bookingId` is the ENVELOPE here, not a visit: this message is about
          // the whole request, the same grain `kincare.requested` moved to in #532.
          bookingId: batchId,
          serviceName: envelope?.['serviceName'] ?? null,
          startTimeMs: firstMs,
          ...dateData,
          // Template back-compat, and the one reason these two are still sent.
          // The seeds no longer reference them, but the Firestore documents in
          // production do until the operator re-imports `kincare.booking.confirm`
          // with it named in `overwriteIds`. Emitter-supplied values always win in
          // `enrichTemplateData`, so the old template keeps naming the first day
          // instead of rendering blanks in the gap between deploy and re-import.
          bookingDate: firstMs == null ? null : formatBookingDate(firstMs, tz),
          bookingTime: firstMs == null ? null : formatBookingTime(firstMs, tz),
        },
        targetType: 'booking',
        targetId: batchId,
        dedupeKey: `booking:${batchId}:approve:${claimMs}`,
      });
      householdNotified = true;
    } catch (err) {
      logEvent({
        severity: 'warn',
        function: 'approveBookingSeriesCore',
        event: 'notification.dispatch.failed',
        uid: actorUid,
        extra: { kinfolkId, batchId, key: 'kincare.booking.confirm', err: (err as Error)?.message },
      });
    }

    await dispatchAuntieSummaries({ kinfolkId, batchId, visits, tz, envelope, actorUid, claimMs });
    return householdNotified;
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'approveBookingSeriesCore',
      event: 'notification.dispatch.failed',
      uid: actorUid,
      extra: {
        kinfolkId,
        batchId,
        key: 'kincare.booking.confirm',
        err: (err as Error)?.message,
      },
    });
    return false;
  }
}

/**
 * ONE `assignment.assigned` per Auntie the approved envelope belongs to (#536).
 *
 * Runs off the live child set the household's message was built from, so a visit
 * cancelled between the request and the approval is never on anyone's list, and
 * the days she is told about are the days the household was told about.
 *
 * NOT gated on `householdNotified`. Her copy is about her schedule, not about
 * whether the household heard; a failed kinfolk dispatch does not make her
 * assignment less real. Each dispatch is caught on its own for the same reason:
 * one Auntie's failure must not cost the other hers.
 *
 * `newlyConfirmed` is deliberately NOT the list. On a retry after a partial
 * failure, only the repaired visit is new, but the booking she is about to work
 * is the whole envelope. Telling her about one day of four would be worse than
 * the fan-out this replaced.
 */
async function dispatchAuntieSummaries(args: {
  kinfolkId: string;
  batchId: string;
  visits: Array<{ visitId: string; startTimeMs: number; assignedAuntieUid?: string | null }>;
  tz: string;
  envelope: Record<string, unknown> | undefined;
  actorUid: string;
  /** The approval claim's time: this approval's notification identity (#832). */
  claimMs: number;
}): Promise<void> {
  const { kinfolkId, batchId, visits, tz, envelope, actorUid, claimMs } = args;

  const byAuntie = new Map<string, typeof visits>();
  for (const v of visits) {
    if (!v.assignedAuntieUid) continue;
    const list = byAuntie.get(v.assignedAuntieUid) ?? [];
    list.push(v);
    byAuntie.set(v.assignedAuntieUid, list);
  }

  for (const [auntieUid, hers] of byAuntie) {
    const dateData = buildVisitDateData(hers, tz, AUNTIE_SCHEDULE_URL);
    // `hers` is never empty here -- an Auntie only appears in the map because a
    // visit named her -- so this is her first day, not a guess.
    const firstMs = hers.length > 0 ? Math.min(...hers.map((v) => v.startTimeMs)) : null;
    try {
      await enqueueNotification({
        key: 'assignment.assigned',
        recipientUid: auntieUid,
        // #832: the same approval identity as the household's copy, per Auntie
        // (the ledger is keyed per recipient), so a re-approval after a cancel
        // reaches her again and a retry of this approval does not.
        dedupeKey: `booking:${batchId}:approve:${claimMs}`,
        data: {
          kinfolkId,
          batchId,
          // The ENVELOPE, like the household's copy: this message answers a whole
          // request. `visitId` is deliberately absent, because there is no one
          // visit this is about.
          //
          // KNOWN GAP, inherited rather than introduced, and NOT widened here.
          // `Navigation.kt:notificationTargetRoute` and the React admin's
          // `sessionIdForVisit` both turn a `booking` targetId into `vis_{id}`
          // and open that session, which resolves for a VISIT id and not for a
          // batch id. `kincare.booking.confirm` has shipped envelope-grained
          // since #565 and has the same gap, so the "open linked item" quick
          // action no-ops on both. Picking one of her days to point at instead
          // would be a lie about what the message is about; the right fix is a
          // route that opens an envelope, which is its own piece of work and
          // needs an operator ruling on what that screen shows.
          bookingId: batchId,
          assignedAuntieUid: auntieUid,
          serviceName: envelope?.['serviceName'] ?? null,
          startTimeMs: firstMs,
          ...dateData,
          // Same back-compat reason as the household's copy: the Firestore
          // template in production still names `{{bookingDate}}` until the
          // operator re-imports `assignment.assigned`.
          bookingDate: firstMs == null ? null : formatBookingDate(firstMs, tz),
          bookingTime: firstMs == null ? null : formatBookingTime(firstMs, tz),
        },
        targetType: 'booking',
        targetId: batchId,
      });
    } catch (err) {
      logEvent({
        severity: 'warn',
        function: 'approveBookingSeriesCore',
        event: 'notification.dispatch.failed',
        uid: actorUid,
        extra: {
          kinfolkId,
          batchId,
          key: 'assignment.assigned',
          auntieUid,
          err: (err as Error)?.message,
        },
      });
    }
  }
}
