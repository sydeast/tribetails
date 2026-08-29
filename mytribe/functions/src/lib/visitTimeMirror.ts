import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { db } from './firestoreAdmin';
import { logEvent } from './logger';

/**
 * #648: a visit lives in TWO documents, and moving it has to move both.
 *
 * `admin/rescheduleRequests.ts` states the rule in its own header, on the path
 * where an admin accepts a household's ask:
 *
 *   > ACCEPTING IS WHAT MOVES THE VISIT, and it moves BOTH records. The
 *   > kinCares doc [...] is what the portal reads; the flat
 *   > `kin_care_sessions/{sessionId}` row is what the admin's schedule reads,
 *   > and `admin/rescheduleBooking` only ever wrote the second.
 *
 * That last clause was the bug. Every ADMIN-initiated reschedule goes through
 * `admin/rescheduleBooking` -- the Schedule week-grid drag (#397 M13), the
 * per-card Reschedule button, the booking detail modal -- and each one moved
 * the office's copy while the household's app kept showing the old time, with
 * nothing anywhere reporting the divergence. `portal/getMyBookings` serves an
 * envelope-linked visit from the kinCares copy and explicitly skips its linked
 * session, so the stale time was the ONLY time a household could see.
 *
 * This module is the session -> envelope direction of that mirror. The opposite
 * direction lives inline in `rescheduleRequests.ts` and is deliberately NOT
 * routed through here: that path already holds the envelope coordinates, writes
 * the reschedule-resolution fields in the same `set`, and reports its own
 * `sessionUpdated` on the wire. Folding two different write shapes into one
 * helper would have cost more in indirection than the duplication saves.
 */

/**
 * The subset of a `kin_care_sessions` doc that says which envelope visit it
 * mirrors. Stamped by `approveBookingSeriesCore` on every session it creates
 * (`kinfolkId`, `kinCareBatchId`, `kinCareVisitId`), and read the same way by
 * `admin/setVisitLifecycle.ts` when it routes a notification.
 */
export interface SessionEnvelopeCoords {
  kinfolkId?: unknown;
  kinCareBatchId?: unknown;
  kinCareVisitId?: unknown;
}

function nonBlank(v: unknown): string {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : '';
}

/**
 * The envelope visit a session mirrors, or null when it mirrors none.
 *
 * NULL IS A REAL AND ORDINARY ANSWER, not a failure. A session created straight
 * through `admin/createKinCareSession` -- an AuntieOS-native visit the office
 * booked itself, with no household request behind it -- carries no envelope
 * coordinates because no envelope exists. `getMyBookings` reads those sessions
 * DIRECTLY (its second query, over the sessions not already linked to a visit),
 * so for them the single session write was always the whole truth and there is
 * nothing to mirror. `setVisitLifecycle` names the same case when it gives up
 * on routing a notification.
 */
export function envelopeVisitRefForSession(
  session: SessionEnvelopeCoords | undefined,
): { ref: FirebaseFirestore.DocumentReference; kinfolkId: string; batchId: string; visitId: string } | null {
  if (!session) return null;
  const kinfolkId = nonBlank(session.kinfolkId);
  const batchId = nonBlank(session.kinCareBatchId);
  const visitId = nonBlank(session.kinCareVisitId);
  if (kinfolkId === '' || batchId === '' || visitId === '') return null;
  return {
    ref: db().doc(`families/${kinfolkId}/bookings/${batchId}/kinCares/${visitId}`),
    kinfolkId,
    batchId,
    visitId,
  };
}

/** Why a mirror did not happen, when it did not. `null` means it did. */
export type MirrorSkipReason = 'session_has_no_envelope_coords' | 'envelope_visit_missing';

export interface MirrorOutcome {
  mirrored: boolean;
  skipped: MirrorSkipReason | null;
}

/**
 * Writes a session's new window onto the household's copy of the same visit.
 *
 * SHAPES DIFFER BETWEEN THE TWO DOCUMENTS AND THAT IS NOT AN INCONSISTENCY TO
 * TIDY. `kin_care_sessions` stores ISO-8601 strings; the kinCares subcollection
 * stores Firestore `Timestamp`s. `rescheduleRequests.ts:153-165` says the same
 * thing from the other side, and writing either shape into the other silently
 * breaks the reader that expects it -- `getMyBookings` parses the session path
 * with `isoMillis` and the envelope path with `tsMillis`.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It touches only `startTime` and
 * `endTime` on the visit, matching the accept path exactly. It does NOT roll up
 * the envelope parent's `firstStartTime` / `lastStartTime`, because
 * `resolveBookingRescheduleRequest` does not either, and a mirror that widened
 * its blast radius past the behaviour it is copying would be a second, unasked
 * change riding along with a bug fix.
 *
 * NOTIFICATIONS ARE A CONSEQUENCE AND ARE INTENDED. `startTime` and `endTime`
 * are both in `onBookingsWrite`'s `CHANGE_WATCH_FIELDS`, so this write
 * dispatches `assignment.changed` with `changeKind: 'updated'` to the assigned
 * Auntie. The accept path already produces exactly that on exactly this field,
 * which is the point: an admin reschedule and an accepted household ask should
 * be indistinguishable downstream, and before this they were not.
 */
export async function mirrorSessionTimesToEnvelope(args: {
  sessionId: string;
  session: SessionEnvelopeCoords | undefined;
  /** ISO-8601, exactly as written to the session row. */
  startIso: string;
  /** ISO-8601, or null to leave the visit's end untouched. */
  endIso: string | null;
  uid: string;
  /** Names the caller in the log line, so a skip is traceable to a gesture. */
  fn: string;
}): Promise<MirrorOutcome> {
  const target = envelopeVisitRefForSession(args.session);
  if (target === null) {
    logEvent({
      severity: 'info',
      function: args.fn,
      event: 'admin.reschedule.noEnvelopeVisit',
      uid: args.uid,
      extra: { sessionId: args.sessionId, reason: 'session_has_no_envelope_coords' },
    });
    return { mirrored: false, skipped: 'session_has_no_envelope_coords' };
  }

  // Read first: a session can name an envelope visit that has since been
  // deleted, and `set(..., {merge:true})` on a missing doc would CREATE a
  // half-formed visit carrying nothing but two timestamps. The household would
  // then see a visit with no service, no Kin and no status.
  const snap = await target.ref.get();
  if (!snap.exists) {
    logEvent({
      severity: 'warn',
      function: args.fn,
      event: 'admin.reschedule.noEnvelopeVisit',
      uid: args.uid,
      extra: {
        sessionId: args.sessionId,
        reason: 'envelope_visit_missing',
        kinfolkId: target.kinfolkId,
        batchId: target.batchId,
        visitId: target.visitId,
      },
    });
    return { mirrored: false, skipped: 'envelope_visit_missing' };
  }

  const startMs = Date.parse(args.startIso);
  const endMs = args.endIso === null ? null : Date.parse(args.endIso);
  await target.ref.set(
    {
      startTime: Timestamp.fromMillis(startMs),
      ...(endMs !== null && Number.isFinite(endMs) ? { endTime: Timestamp.fromMillis(endMs) } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return { mirrored: true, skipped: null };
}
