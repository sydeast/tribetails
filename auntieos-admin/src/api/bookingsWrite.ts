import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { call } from '../lib/fns';

/**
 * The write half of the `kin_care_sessions` surface Bookings.tsx / api/bookings.ts
 * only reads. Two DIFFERENT transports, both confirmed against the live wasm
 * bridge and the MyTribe backend, never invented:
 *
 *   1. DIRECT CLIENT WRITE (this file's setBookingStatus + wrappers). Confirmed
 *      by firestore.rules:203-209, `match /kin_care_sessions/{sessionId}`:
 *      `allow create/update/delete: if isAuntie() || ...`, unmediated, the same
 *      grant api/bookings.ts's doc comment already cites for the read side. The
 *      wasm reference writes this collection the SAME way, never through a
 *      callable, for exactly the four status transitions ported below:
 *        - FirestoreInterop.wasmJs.kt:968 `platformApproveBooking`  -> bare
 *          `{"status":"SCHEDULED"}` via `jsUpdateDoc`.
 *        - FirestoreInterop.wasmJs.kt:977 `platformRejectBooking`   -> bare
 *          `{"status":"CANCELLED"}` via `jsUpdateDoc`.
 *        - KinCareSessionsScreen.kt:724 "Cancel KinCare" (an already-SCHEDULED
 *          visit, not a pending request) -> the SAME bare
 *          `{"status":"CANCELLED"}` patch, routed through `patchKinCare` /
 *          `jsUpdateDoc` rather than a distinct callable. There is no separate
 *          backend verb for "reject" vs "cancel": both are one Firestore write.
 *        - KinCareSessionsScreen.kt:716 "Mark Completed" ->
 *          `{"status":"COMPLETED","completedAt":<nowIso>}`, same transport.
 *      Every patch here is intentionally BARE, matching the reference exactly:
 *      no `updatedAt` stamp is added, because the wasm's own direct writes to
 *      this collection never add one either. That is a faithful port, not an
 *      oversight; flagged here so a later pass does not "fix" it into a
 *      mismatch with the reference it is supposed to mirror.
 *
 *   2. CALLABLE (rescheduleBooking below). Confirmed against
 *      MyTribe/functions/src/admin/rescheduleBooking.ts: a server-bound onCall
 *      that reads `kin_care_sessions/{sessionId}` first (404 if absent), writes
 *      `{startTime, endTime, updatedAt, updatedBy}`, and audits the before/after
 *      window (AUDIT_EVENTS.RESCHEDULE_BOOKING). Reschedule goes through the
 *      callable (not a direct client patch) because it is the one write on this
 *      doc the backend wraps with its own audited before/after read, shared by
 *      both Schedule's drag-to-reschedule and this screen's Reschedule action.
 *
 *   3. CALLABLE, ON THE ENVELOPE VISIT DOC (assignAuntie / addBookingNote /
 *      addInternalBookingNote at the foot of this file, added for the Schedule
 *      booking detail sheet). These act on
 *      `families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}`, NOT on the
 *      flat `kin_care_sessions` row, because that is where the assignment and
 *      both note subcollections actually live. A session only reaches them when
 *      it carries the `kinCareBatchId`/`kinCareVisitId` back-references
 *      `approveBookingSeriesCore.ts` stamps; see `getVisitAssignment`.
 *
 * STILL OUT OF SCOPE for the Bookings LIST: `manageBookingSeries`
 * (MyTribe/functions/src/admin/manageBookingSeries.ts). It acts on the SEPARATE
 * nested booking-envelope model (`families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}`),
 * the wasm's "Incoming requests" panel, not the flat `kin_care_sessions` rows this
 * screen lists, so it would not act on the row BookingActions.tsx is showing.
 *
 * `batchUpdateBookings` (added below) carried that same note until the
 * Notifications feed gained quick actions. It still targets the envelope model,
 * NOT `kin_care_sessions`, and it still must not be wired into this screen's row
 * actions for exactly the reason above. It lives here because this is the
 * bookings write module and a second copy elsewhere would be worse; its one
 * caller is the Notifications row's Approve/Deny, whose `targetId` comes from a
 * booking-request notification and IS an envelope visit id.
 */

/** The three states a direct client patch ever sets on this collection. */
export type BookingWriteStatus = 'SCHEDULED' | 'CANCELLED' | 'COMPLETED';

/**
 * The shared low-level primitive every direct-write action below is built from:
 * one merge-patch on `kin_care_sessions/{bookingId}`. `extra` carries the one
 * additional field "Mark Completed" sets alongside status (`completedAt`); every
 * other caller omits it, matching the reference's bare `{"status": ...}` patches.
 *
 * Throws (never swallows) on any Firestore failure, permission-denied included:
 * per the fail-loud policy, the caller surfaces `err.message` rather than this
 * module deciding what the operator gets to see.
 */
export async function setBookingStatus(
  bookingId: string,
  status: BookingWriteStatus,
  extra?: Record<string, string>,
): Promise<void> {
  await updateDoc(doc(db, 'kin_care_sessions', bookingId), { status, ...(extra ?? {}) });
}

/** Approves a DRAFT/PENDING request. Ports `platformApproveBooking` verbatim. */
export async function approveBooking(bookingId: string): Promise<void> {
  await setBookingStatus(bookingId, 'SCHEDULED');
}

/** Rejects a DRAFT/PENDING request. Ports `platformRejectBooking` verbatim. */
export async function rejectBooking(bookingId: string): Promise<void> {
  await setBookingStatus(bookingId, 'CANCELLED');
}

/**
 * Cancels an already-SCHEDULED visit. Ports KinCareSessionsScreen.kt's "Cancel
 * KinCare" patch. Same primitive as `rejectBooking` (the backend has no distinct
 * status for "rejected a request" vs "cancelled a scheduled visit", the same
 * asymmetry `batchUpdateBookings.ts`'s own comment documents for its sibling
 * model); kept as a separate export so callers name the action they mean and
 * BookingActions.tsx can give each its own confirm copy.
 */
export async function cancelBooking(bookingId: string): Promise<void> {
  await setBookingStatus(bookingId, 'CANCELLED');
}

/**
 * Marks a SCHEDULED visit COMPLETED. Ports KinCareSessionsScreen.kt's "Mark
 * Completed" patch, `completedAt` included exactly as the reference sends it
 * (the caller's own "now", not a server timestamp, matching the reference so a
 * clock skew between this and a future server-stamped field never gets
 * confused for a real value on this collection).
 */
export async function markBookingCompleted(bookingId: string, completedAtIso: string): Promise<void> {
  await setBookingStatus(bookingId, 'COMPLETED', { completedAt: completedAtIso });
}

/** One visit in a multi-date/recurring booking request. `startTimeMs` is epoch
 *  ms; the caller derives it from a LOCAL date+time (AO-18), so no UTC skew. */
export interface NewBookingVisit {
  startTimeMs: number;
  endTimeMs?: number | null;
  /** Optional catalog id; when set the server resolves the canonical name+price. */
  serviceId?: string | null;
  serviceName: string;
}

export interface CreateMultiDateBookingArgs {
  kinfolkId: string;
  kinIds?: string[];
  notes?: string;
  pattern?: 'individual' | 'weekly';
  weeklyDays?: number[];
  visits: NewBookingVisit[];
}

export interface CreateMultiDateBookingResult {
  batchId: string;
  visitIds: string[];
  visitCount: number;
}

/**
 * createMultiDateBookingRequest (admin callable, AO-25): create a booking
 * request of one or more visits (non-consecutive dates, or a weekly recurrence
 * the caller expands into concrete visits) for a chosen household.
 *
 * IMPORTANT (disclosed, not silent): this writes the ENVELOPE model
 * (`families/{kinfolkId}/bookings/{batchId}`), the wasm "Incoming requests"
 * queue, as `envelopeStatus:'requested'`. It is a DIFFERENT collection from the
 * flat `kin_care_sessions` the Bookings LIST streams, so a created request does
 * NOT appear in that list until it is approved (approveBookingSeriesCore turns
 * an approved envelope into scheduled sessions). The create UI's success copy
 * says so. Throws (via lib/fns.call) on `not-found` (bad household) /
 * `invalid-argument` (past time, bad window) / auth errors; the caller surfaces
 * the message fail-loud.
 */
export async function createMultiDateBookingRequest(
  args: CreateMultiDateBookingArgs,
): Promise<CreateMultiDateBookingResult> {
  return call<CreateMultiDateBookingArgs, CreateMultiDateBookingResult>(
    'createMultiDateBookingRequest',
    args,
  );
}

/** The three transitions `batchUpdateBookings` accepts. */
export type BatchBookingAction = 'APPROVE' | 'REJECT' | 'CANCEL';

export interface BatchUpdateBookingsResult {
  ok: true;
  action: BatchBookingAction;
  /** How many visits actually reached the target status. */
  updated: number;
  /** Per-id failures; the handler collects these instead of aborting the batch. */
  failed: Array<{ id: string; error: string }>;
}

/**
 * batchUpdateBookings (admin callable): apply ONE transition to many envelope
 * visits at once. APPROVE confirms; REJECT and CANCEL both terminate (the
 * backend has no distinct 'rejected' status, as batchUpdateBookings.ts's own
 * comment documents), and REJECT is still audited as a REJECT so the intent
 * survives in the trail.
 *
 * PARTIAL SUCCESS IS NORMAL, and the caller must read it. The handler resolves
 * each id through `collectionGroup('kinCares')` and pushes unresolvable ones
 * into `failed` rather than throwing, so a resolved promise with
 * `updated: 0, failed: [...]` is a FAILURE the operator has to see. Idempotent
 * per id: a visit already in the target status counts as updated with no write.
 */
export async function batchUpdateBookings(
  ids: string[],
  action: BatchBookingAction,
): Promise<BatchUpdateBookingsResult> {
  return call<{ ids: string[]; action: BatchBookingAction }, BatchUpdateBookingsResult>(
    'batchUpdateBookings',
    { ids, action },
  );
}

export interface RescheduleBookingResult {
  ok: true;
  sessionId: string;
}

/**
 * rescheduleBooking (admin callable): server-bound reschedule of a
 * `kin_care_sessions` doc. Matches the backend's Zod contract exactly,
 * `{ sessionId, startTime, endTime }`, both times free-text (min 1 / max 40
 * chars server-side, the same opaque-string convention `BookingEntry.startTime`
 * already documents), not a Timestamp. Throws (via lib/fns.call) on `not-found`
 * / `invalid-argument` / auth errors; the caller surfaces the message fail-loud.
 */
export async function rescheduleBooking(
  sessionId: string,
  startTime: string,
  endTime: string,
): Promise<RescheduleBookingResult> {
  return call<{ sessionId: string; startTime: string; endTime: string }, RescheduleBookingResult>(
    'rescheduleBooking',
    { sessionId, startTime, endTime },
  );
}

// ── Envelope visit doc: assignment + notes ───────────────────────────────────

export interface VisitAssignment {
  assignedAuntieUid: string | null;
  auntieDisplayName: string | null;
}

/**
 * Read the CANONICAL assignment straight off
 * `families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}`.
 *
 * A direct client read, not a callable, and deliberately: `firestore.rules`
 * grants `allow read: if activeMember(fid) || isAuntie()` on that doc, and no
 * `getKinCareAssignment` callable exists. Android does the same thing
 * (`AuntieRepository#getKinCareAssignment`).
 *
 * It lives next to `assignAuntie` below on purpose. The write is optimistic in
 * the UI, so this read is what the optimistic value SETTLES against; splitting
 * them across modules is how the two drift into disagreeing about which field
 * carries the name.
 *
 * NOT read off the `kin_care_sessions` row: assignment is never mirrored onto
 * that collection, so the session doc the Schedule agenda already holds cannot
 * answer this question.
 */
export async function getVisitAssignment(
  kinfolkId: string,
  batchId: string,
  visitId: string,
): Promise<VisitAssignment> {
  const snap = await getDoc(
    doc(db, 'families', kinfolkId, 'bookings', batchId, 'kinCares', visitId),
  );
  const data = (snap.data() ?? {}) as Record<string, unknown>;
  return {
    assignedAuntieUid: typeof data.assignedAuntieUid === 'string' ? data.assignedAuntieUid : null,
    auntieDisplayName: typeof data.auntieDisplayName === 'string' ? data.auntieDisplayName : null,
  };
}

export interface AssignAuntieResult {
  ok: true;
  visitId: string;
  auntieUid: string | null;
}

/**
 * assignAuntie (admin callable): set or clear the Auntie on one KinCare visit.
 *
 * Matches the backend's Zod contract exactly:
 * `{ kinfolkId, batchId, visitId, auntieUid }` where `auntieUid` is NULLABLE,
 * not optional, so unassigning sends an explicit `null` (the server turns that
 * into a `FieldValue.delete()` on `assignedAuntieUid`). Omitting the key would
 * fail validation rather than unassign.
 *
 * The server resolves the display name from `staff/{uid}` itself and rejects an
 * unknown uid with `failed-precondition`, which is why the UI treats its own
 * optimistic name as provisional until `getVisitAssignment` confirms it.
 *
 * Throws (via lib/fns.call) on `not-found` / `failed-precondition` /
 * `invalid-argument` / auth errors; the caller reverts and surfaces the message.
 */
export async function assignAuntie(
  kinfolkId: string,
  batchId: string,
  visitId: string,
  auntieUid: string | null,
): Promise<AssignAuntieResult> {
  return call<
    { kinfolkId: string; batchId: string; visitId: string; auntieUid: string | null },
    AssignAuntieResult
  >('assignAuntie', { kinfolkId, batchId, visitId, auntieUid });
}

export interface AddNoteResult {
  noteId: string;
}

/**
 * addBookingNote (portal callable, staff-or-member gated): append a
 * KINFOLK-FACING note to `.../kinCares/{visitId}/notes`.
 *
 * NOTE the codebase this lives in: it is the one note verb that is NOT under
 * `functions/src/admin/`, because the household writes it too
 * (`functions/src/portal/addBookingNote.ts`). Consequences that matter here:
 *  - the SERVER enforces the 3-hour cutoff (`CUTOFF_MS`), rejecting with
 *    `failed-precondition` + `{ code: 'booking_note_cutoff' }`. The client lock
 *    in `lib/bookingDetailFormat.ts` is a courtesy so the operator is not
 *    surprised; this rejection is the real gate and is surfaced verbatim.
 *  - `authorRole` is stamped from the CALLER, never sent, so an admin's note
 *    lands as `'admin'` and a household's as `'kinfolk'`.
 *
 * `batchId`+`visitId` are sent (not the legacy flat `bookingId`) so the server
 * writes under the nested visit, which is the only path the client can read
 * back; see `api/bookingNotes.ts` for the archive bug this avoids.
 */
export async function addBookingNote(
  kinfolkId: string,
  batchId: string,
  visitId: string,
  body: string,
): Promise<AddNoteResult> {
  return call<
    { kinfolkId: string; batchId: string; visitId: string; body: string },
    AddNoteResult
  >('addBookingNote', { kinfolkId, batchId, visitId, body: body.trim() });
}

/**
 * addInternalBookingNote (admin callable): append a STAFF-ONLY note to
 * `.../kinCares/{visitId}/internalNotes`, a separate subcollection whose read
 * rule is `isAuntie()` alone.
 *
 * DISCLOSED ASYMMETRY: this callable has NO cutoff check. The sheet still locks
 * its composer at the same 3-hour mark as the kinfolk-facing one, per the
 * operator's ruling that both threads freeze before a visit, so the lock here is
 * a CLIENT policy rather than a server-enforced one. If that ruling should bind
 * everywhere, the cutoff belongs in `addInternalBookingNote.ts` too; it is
 * flagged here rather than left to look server-backed when it is not.
 */
export async function addInternalBookingNote(
  kinfolkId: string,
  batchId: string,
  visitId: string,
  body: string,
): Promise<AddNoteResult> {
  return call<
    { kinfolkId: string; batchId: string; visitId: string; body: string },
    AddNoteResult
  >('addInternalBookingNote', { kinfolkId, batchId, visitId, body: body.trim() });
}
