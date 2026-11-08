import { HttpsError } from 'firebase-functions/v2/https';
import { db } from './firestoreAdmin';
import { resolveKinCareRef } from './resolveKinCareRef';

/**
 * #1580: one list of internal notes per visit, of two kinds.
 *
 * Operator ruling, 2026-11-05 docket: "two kinds, shared and admin-only. The
 * writer marks each note. Aunties see only shared notes." Firestore rules gate
 * DOCUMENTS, never fields, so the kind is a PATH, not a flag:
 *
 *   families/{k}/bookings/{b}/kinCares/{v}/internalNotes/{id}   shared      (rules: isStaff)
 *   families/{k}/bookings/{b}/kinCares/{v}/adminNotes/{id}      admin-only  (rules: isOwner)
 *
 * A flag on one collection would still hand an Auntie the admin-only text the
 * moment she listened to it. Both are write-denied to every client; the two
 * callables that use this module are the only writers and the only readers the
 * admin clients go through.
 *
 * The visit's third place notes used to live, the session's own `notes` text
 * (Auntie Time's old "Admin-internal note" box, and the `[Booking cancelled]`
 * reason `transitionBookingStatus` appends), stays readable here as one
 * read-only entry. Every staff member can read `kin_care_sessions`, so that text
 * has always been shared, whatever the old label said. New notes no longer go
 * there, except on an older visit that has no booking record to hold a thread.
 */

export const VISIT_NOTE_KINDS = ['shared', 'adminOnly'] as const;
export type VisitNoteKind = (typeof VISIT_NOTE_KINDS)[number];

export const SHARED_NOTES = 'internalNotes';
export const ADMIN_ONLY_NOTES = 'adminNotes';

/** The machine-readable reason an admin-only note cannot be kept on a visit. */
export const NO_BOOKING_RECORD_CODE = 'visit_has_no_booking_record';

export interface VisitNoteTarget {
  /** The visit's booking record, or null for an older visit that has none. */
  visitRef: FirebaseFirestore.DocumentReference | null;
  kinfolkId: string | null;
  batchId: string | null;
  visitId: string | null;
  /** The visit's `kin_care_sessions` doc, when there is one. */
  sessionRef: FirebaseFirestore.DocumentReference | null;
  /** The session's own `notes` text ('' when none, or no session). */
  sessionNotes: string;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Resolves a visit from either side: the session id (Auntie Time, Schedule) or
 * the booking-record ids (Bookings). Throws not-found when neither exists.
 */
export async function resolveVisitNoteTarget(args: {
  sessionId?: string | undefined;
  kinfolkId?: string | undefined;
  batchId?: string | undefined;
  visitId?: string | undefined;
  bookingId?: string | undefined;
}): Promise<VisitNoteTarget> {
  if (args.sessionId) {
    const sessionRef = db().collection('kin_care_sessions').doc(args.sessionId);
    const snap = await sessionRef.get();
    if (!snap.exists) throw new HttpsError('not-found', 'visit not found');
    const s = (snap.data() ?? {}) as Record<string, unknown>;
    const kinfolkId = str(s['kinfolkId']);
    const batchId = str(s['kinCareBatchId']);
    const visitId = str(s['kinCareVisitId']);
    let visitRef: FirebaseFirestore.DocumentReference | null = null;
    if (kinfolkId !== '' && batchId !== '' && visitId !== '') {
      const ref = db().doc(`families/${kinfolkId}/bookings/${batchId}/kinCares/${visitId}`);
      if ((await ref.get()).exists) visitRef = ref;
    }
    return {
      visitRef,
      kinfolkId: kinfolkId === '' ? null : kinfolkId,
      batchId: visitRef ? batchId : null,
      visitId: visitRef ? visitId : null,
      sessionRef,
      sessionNotes: str(s['notes']),
    };
  }

  if (!args.kinfolkId) throw new HttpsError('invalid-argument', 'Provide sessionId, or kinfolkId with batchId+visitId.');
  const resolved = await resolveKinCareRef({
    familyId: args.kinfolkId,
    batchId: args.batchId,
    visitId: args.visitId,
    bookingId: args.bookingId,
  });
  if (!resolved) throw new HttpsError('not-found', 'booking not found');
  const visitSnap = await resolved.ref.get();
  if (!visitSnap.exists) throw new HttpsError('not-found', 'booking not found');
  // The session this visit booked, if it has been approved: its `notes` text
  // belongs in the same list. `vis_{visitId}` is the id every server path
  // derives, and the visit's own `sessionId` back-link wins when it is set.
  const linked = str((visitSnap.data() as Record<string, unknown> | undefined)?.['sessionId']);
  const sessionId = linked !== '' ? linked : `vis_${resolved.visitId}`;
  const sessionRef = db().collection('kin_care_sessions').doc(sessionId);
  const sessionSnap = await sessionRef.get();
  return {
    visitRef: resolved.ref,
    kinfolkId: args.kinfolkId,
    batchId: resolved.batchId,
    visitId: resolved.visitId,
    sessionRef: sessionSnap.exists ? sessionRef : null,
    sessionNotes: sessionSnap.exists ? str((sessionSnap.data() as Record<string, unknown>)['notes']) : '',
  };
}

/** Epoch ms for a stored `createdAt` (Timestamp, Date, ISO text or ms), or null. */
export function createdAtMsOf(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  }
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.getTime();
  const ts = raw as { toMillis?: () => number };
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  return null;
}

/**
 * The stamp an older visit's `notes` text takes when a shared note is added to
 * it. Same shape the admin web's `appendOfficeNote` has always written, newest
 * first, so the text reads the same whoever wrote it.
 */
export function appendSessionNote(existing: string, body: string, author: 'office' | 'auntie', nowIso: string): string {
  const stamped = `[${nowIso}] (${author}) ${body.trim()}`;
  return existing.trim() === '' ? stamped : `${stamped}\n${existing}`;
}
