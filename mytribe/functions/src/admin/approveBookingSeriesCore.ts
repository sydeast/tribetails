import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { resolveKinNames } from '../lib/resolveKinNames';
import { guardBookingBusyConflict } from '../lib/bookingBusyConflict';

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
 * (`lib/bookingBusyConflict.ts`) immediately before its session is created,
 * same isolation: a conflict fails that one visit rather than the batch.
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
    return { affectedVisits: 0, sessionsCreated: 0, failedVisits: 0, envelopeStatus: 'requested', found: false };
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

  for (const doc of childSnap.docs) {
    const id = doc.id;
    const data = doc.data() as Record<string, unknown>;
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
        const kinIds = Array.isArray(data.kinIds)
          ? (data.kinIds as unknown[]).filter((k): k is string => typeof k === 'string')
          : [];
        // Same resolve requestBooking's writeEnvelope uses: this is the session
        // doc the auntie actually runs, and Android's Schedule Pets line reads
        // straight off of it, so a hardcoded [] here is the same bug even
        // though this write never wrote the literal `kinNames: []`.
        const kinNames = await resolveKinNames(kinfolkId, kinIds);
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
        { status: 'confirmed', sessionId: sessionRef.id, sourceBookingId: id, updatedAt: FieldValue.serverTimestamp() },
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

  return { affectedVisits: succeeded, sessionsCreated, failedVisits, envelopeStatus, found: true };
}
