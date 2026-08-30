import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { materializeKinRoster } from '../lib/kinRoster';
import { guardBookingBusyConflict } from '../lib/bookingBusyConflict';
import { guardCompanyHolidayConflict } from '../lib/companyHolidayConflict';
import { enqueueNotification } from '../notifications/dispatcher';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';

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
 * #536: IT ALSO OWNS THE "your request is booked" NOTIFICATIONS, one per
 * ENVELOPE. `onBookingsWrite` is registered per VISIT, so a four-day request
 * approved here used to dispatch `kincare.booking.confirm` four times to the
 * household AND, through `secondaryResolver: 'businessAdmins'`, four times to
 * the office. Same defect #532 fixed on the request side and #533 on the
 * decline side. See the dispatch block at the bottom of this file for why the
 * dispatch lives in this core rather than in a trigger on the envelope.
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
  /** 'confirmed' when every visit succeeded; 'requested' on partial failure. */
  envelopeStatus: 'confirmed' | 'requested';
  /** false when the parent envelope does not exist (nothing approved). */
  found: boolean;
  /**
   * #536: visits this call actually moved INTO `confirmed`. A re-approve of an
   * already-confirmed envelope reports 0 here even though `affectedVisits` is
   * the full count, which is what stops a second household notification.
   */
  newlyConfirmed: number;
  /**
   * #536: true when this call dispatched the one per-envelope
   * `kincare.booking.confirm`. The admin surfaces read it so their success
   * copy can say whether the household actually heard anything, rather than
   * claiming it on every outcome.
   */
  householdNotified: boolean;
}

/** One confirmed visit, as the envelope-level dispatches below need it. */
interface ConfirmedVisit {
  visitId: string;
  startTimeMs: number | null;
  assignedAuntieUid: string | null;
}

export async function approveBookingSeriesCore(opts: {
  kinfolkId: string;
  batchId: string;
  actorUid: string;
  actorRole: 'AUNTIE' | 'SYSTEM';
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

  const childSnap = await parentRef.collection('kinCares').get();
  const childIds = childSnap.docs.map((d) => d.id);

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
  /**
   * #536: every visit this call left `confirmed`, which is what the envelope
   * dispatch NAMES. It is the whole booking, not the delta.
   *
   * The delta below decides WHETHER to send; this decides WHAT it says, and the
   * two must not be the same list. A partial failure commits the visits that
   * worked, so on the operator's retry those children read `confirmed` already
   * and only the repaired one is new. Building the message from the delta would
   * hand a household whose four-day request finally went through a single
   * confirmation naming one date.
   */
  const confirmedVisits: ConfirmedVisit[] = [];
  /** How many of them this call actually MOVED into `confirmed`. */
  let newlyConfirmedCount = 0;

  for (const doc of childSnap.docs) {
    const id = doc.id;
    const data = doc.data() as Record<string, unknown>;
    const wasConfirmed = data.status === 'confirmed';
    const childRef = parentRef.collection('kinCares').doc(id);
    const sessionRef = db().collection('kin_care_sessions').doc(`vis_${id}`);

    try {
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
          // #536: the stamp that tells `onBookingsWrite` this particular
          // `-> confirmed` write is part of a WHOLE-ENVELOPE approval, whose
          // notification is dispatched once at the bottom of this function.
          //
          // A STAMP, NOT THE `requested -> confirmed` TRANSITION, for the same
          // reason #533 stamped the decline: that transition has a second,
          // opposite meaning. `admin/batchUpdateBookings` APPROVE writes
          // `status: 'confirmed'` straight onto individual `kinCares` docs --
          // it is what the React admin's Bookings bulk bar and Android's
          // Notifications quick-approve send -- and those confirmations are
          // genuinely per-visit and have no envelope dispatch behind them.
          // Gating on the bare transition would silence them.
          //
          // Rewritten on every approve (including a re-approve), which is what
          // lets the trigger tell a NEW envelope approval from an unrelated
          // later edit: it compares the value, not its presence. Deliberately
          // NOT in CHANGE_WATCH_FIELDS -- a watched stamp would fire
          // `kincare.changed` on every re-approve.
          requestApprovedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      const startMs = Date.parse(toIso(data.startTime));
      confirmedVisits.push({
        visitId: id,
        startTimeMs: Number.isFinite(startMs) ? startMs : null,
        assignedAuntieUid:
          typeof data.assignedAuntieUid === 'string' && data.assignedAuntieUid
            ? data.assignedAuntieUid
            : null,
      });
      if (!wasConfirmed) newlyConfirmedCount += 1;
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

  const succeeded = childIds.length - failedVisits;
  const envelopeStatus: 'confirmed' | 'requested' = failedVisits === 0 ? 'confirmed' : 'requested';
  await parentRef.set(
    {
      // Only mark the whole envelope confirmed when every visit succeeded; a partial
      // failure leaves it 'requested' so the admin retries (no false 'done').
      envelopeStatus,
      confirmedCount: succeeded,
      cancelledCount: 0,
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

  // ── #536: the answer to the request, told ONCE ───────────────────────────
  //
  // WHY HERE AND NOT IN A TRIGGER. `envelopeStatus` reaching `confirmed` is
  // written by this core AND by `onKinCareRollup`, so a trigger on the parent
  // envelope would either double-fire or need a flag to tell the two writers
  // apart. That is the reasoning already recorded in `manageBookingSeries.ts`
  // for the decline dispatch, and it holds identically here. This core also
  // already knows the whole child set and the counts, which a trigger would
  // have to re-read.
  //
  // BOTH APPROVE PATHS COME THROUGH HERE: the `manageBookingSeries` callable
  // that both admin clients call, and `requestBooking`'s `maybeAutoConfirm`.
  // An auto-confirmed multi-visit request has always sent N confirmations, and
  // this is the one line that fixes both.
  //
  // THE GATE, and it is #533's, deliberately. `failedVisits === 0` because a
  // partial failure leaves the envelope `requested` on purpose so the operator
  // retries (see the parent write above); dispatching now would send one
  // notification per ATTEMPT, which is #532's defect wearing a different hat.
  // `newlyConfirmedCount > 0` because a re-approve of an envelope that is
  // already confirmed changed nothing and owes nobody news. The admin copy on
  // both clients says which of these happened rather than claiming the
  // household was told either way.
  //
  // THE GATE IS THE DELTA; THE MESSAGE IS THE WHOLE BOOKING. Those are two
  // different lists and mixing them was a real bug. A partial failure commits
  // the visits that worked, so on the retry those children already read
  // `confirmed` and only the repaired one is new. Sending the delta would have
  // given a household whose four-day request finally went through one
  // confirmation naming one date. `confirmedVisits` is every child the loop
  // left confirmed, which under `failedVisits === 0` is the whole envelope.
  const shouldNotify = failedVisits === 0 && newlyConfirmedCount > 0;
  // Reports what actually went out, not what was attempted: the dispatch is
  // caught below so a notification failure cannot roll back the approval, and
  // an admin toast that says "the household has been told" on the back of a
  // swallowed error is exactly the kind of claim this issue is about.
  let householdNotified = false;
  const startTimeMsList = confirmedVisits
    .map((v) => v.startTimeMs)
    .filter((ms): ms is number => ms != null)
    .sort((a, b) => a - b);

  if (shouldNotify) {
    // The household (and, via secondaryResolver: 'businessAdmins', the office).
    // `bookingId` is the ENVELOPE, not a visit: this message is about the whole
    // request, and `manageBookingSeries` rules on a batchId. The enricher turns
    // `startTimeMsList` into `{{bookingDates}}` (#532), so one message names
    // every date.
    try {
      const recipientUid = await resolveKinfolkUid(kinfolkId);
      await enqueueNotification({
        key: 'kincare.booking.confirm',
        recipientUid: recipientUid ?? '',
        data: {
          kinfolkId,
          batchId,
          bookingId: batchId,
          serviceName: (parentSnap.data()?.serviceName as string | undefined) ?? null,
          startTimeMs: startTimeMsList[0] ?? null,
          startTimeMsList,
          visitCount: confirmedVisits.length,
        },
        targetType: 'booking',
        targetId: batchId,
      });
      householdNotified = true;
    } catch (err) {
      // The approval itself succeeded and is audited. A failed notification
      // must not roll that back, but it must not be silent either: a household
      // whose booking was confirmed and who never heard is the defect.
      logEvent({
        severity: 'warn',
        function: 'approveBookingSeriesCore',
        event: 'notification.dispatch.failed',
        uid: actorUid,
        extra: { kinfolkId, batchId, key: 'kincare.booking.confirm', err: (err as Error)?.message },
      });
    }

    // The assigned Auntie. OPERATOR RULING 2026-08-23: she gets ONE summary
    // message per envelope, while the per-visit SCHEDULE records stay
    // individual -- every visit still lands separately on her schedule surface
    // (its own `kin_care_sessions/vis_{visitId}` doc, written above). Message
    // noise goes down; schedule fidelity is kept.
    //
    // Grouped by uid rather than assumed to be one Auntie: `writeEnvelope`
    // stamps the SAME default assignee on every child, but `admin/assignAuntie`
    // is per-visit, so a half-reassigned envelope really does owe two people
    // their own dates. Each still hears once.
    // Over `confirmedVisits`, not the delta, for the same reason the household's
    // list is: on a retry her summary must still cover the whole booking she is
    // about to work, not the one visit that had failed.
    const byAuntie = new Map<string, number[]>();
    for (const v of confirmedVisits) {
      if (!v.assignedAuntieUid || v.startTimeMs == null) continue;
      const list = byAuntie.get(v.assignedAuntieUid) ?? [];
      list.push(v.startTimeMs);
      byAuntie.set(v.assignedAuntieUid, list);
    }
    for (const [auntieUid, msList] of byAuntie) {
      try {
        await enqueueNotification({
          key: 'assignment.assigned',
          recipientUid: auntieUid,
          data: {
            kinfolkId,
            batchId,
            bookingId: batchId,
            assignedAuntieUid: auntieUid,
            serviceName: (parentSnap.data()?.serviceName as string | undefined) ?? null,
            startTimeMs: msList[0] ?? null,
            startTimeMsList: [...msList].sort((a, b) => a - b),
            visitCount: msList.length,
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
          extra: { kinfolkId, batchId, key: 'assignment.assigned', auntieUid, err: (err as Error)?.message },
        });
      }
    }
  }

  return {
    affectedVisits: succeeded,
    sessionsCreated,
    failedVisits,
    envelopeStatus,
    found: true,
    newlyConfirmed: newlyConfirmedCount,
    householdNotified,
  };
}
