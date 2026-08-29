import { doc, getDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { call } from '../lib/fns';
import type {
  AddBookingNoteArgs,
  AddBookingNoteResult,
  AddInternalBookingNoteArgs,
  AddInternalBookingNoteResult,
  BatchUpdateBookingsArgs,
  BatchUpdateBookingsResult,
  CreateMultiDateBookingRequestArgs,
  CreateMultiDateBookingRequestResult,
  RescheduleBookingArgs,
  RescheduleBookingResult,
} from '../contracts/bookingContracts.generated';

/**
 * `createMultiDateBookingRequest`, `batchUpdateBookings`, `rescheduleBooking`,
 * `addBookingNote` and `addInternalBookingNote` are typed against
 * `contracts/bookingContracts.generated.ts` (ADR-0001), not against a hand
 * transcription of their Zod schemas. `transitionBookingStatus` and
 * `assignAuntie` are not in that registry yet, so they keep their own local
 * types below.
 *
 * The write half of the `kin_care_sessions` surface Bookings.tsx / api/bookings.ts
 * only reads. Every write below is now a CALLABLE. The one direct client patch
 * this module used to make is gone (see 1), and `firestore.rules` no longer
 * permits it, so nothing here can drift back into an unaudited write by
 * accident. The three groups differ by what they act on, not by transport:
 *
 *   1. CALLABLE, STATUS TRANSITIONS (transitionBookingStatus, and the four
 *      named wrappers below). AS OF A3 THIS IS A CALLABLE AND NOT A DIRECT
 *      WRITE, and the change is the point of that PR.
 *
 *      It used to be `updateDoc(doc(db, 'kin_care_sessions', id), { status })`
 *      straight from the browser, authorized by nothing but
 *      `firestore.rules`'s `isAuntie()` grant on this collection, and ported
 *      that way because the wasm reference wrote it that way
 *      (`FirestoreInterop.wasmJs.kt:968/977`, `KinCareSessionsScreen.kt:716/724`).
 *      A faithful port of an unaudited write is still an unaudited write: any
 *      status could be set from any status, and `activity_log` recorded none
 *      of it, on the one surface that decides whether a visit happened and
 *      therefore whether it is billable.
 *
 *      `MyTribe/functions/src/admin/transitionBookingStatus.ts` now owns it:
 *      admin-claim gated, zod-validated, a real state machine over the allowed
 *      transitions (`functions/src/lib/bookingTransitions.ts`), and
 *      `writeAuditEntry` on every path INCLUDING the refusals. The server also
 *      stamps `updatedAt`/`updatedBy`, which the bare client patches never did.
 *
 *   2. CALLABLE, RESCHEDULE (rescheduleBooking below). Confirmed against
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

/**
 * The four transitions `transitionBookingStatus` accepts. Mirrors the server's
 * `BOOKING_ACTIONS` (`functions/src/lib/bookingTransitions.ts`), frozen against
 * drift by `functions/test/callableContract.test.ts`.
 */
export type BookingTransitionAction = 'APPROVE' | 'REJECT' | 'CANCEL' | 'COMPLETE';

export interface TransitionBookingStatusResult {
  ok: true;
  sessionId: string;
  action: BookingTransitionAction;
  /** The status the row held before the call. Equal to `status` on a no-op. */
  from: string;
  /** The status the row holds now. */
  status: string;
  /** False when the row was already in the target status and nothing was written. */
  changed: boolean;
}

interface TransitionBookingStatusArgs {
  sessionId: string;
  action: BookingTransitionAction;
  completedAt?: string;
  reason?: string;
}

/**
 * The shared primitive every named action below is built from: one call to the
 * `transitionBookingStatus` admin callable.
 *
 * THE STATE MACHINE IS SERVER-SIDE AND THIS FUNCTION DOES NOT SECOND-GUESS IT.
 * `BookingActions.tsx` only OFFERS the actions that apply to the state it is
 * rendering (its `actionsFor` map), which is a courtesy so the operator is not
 * shown a button that will fail; it is not the enforcement. A stale row, a
 * second operator, or a direct invocation all reach the server, which refuses
 * with `failed-precondition` and a `details.code` of `booking_transition_illegal`
 * (or `booking_status_unknown` for a row whose status it cannot read) and audits
 * the attempt either way.
 *
 * Throws (never swallows) on any callable failure, permission-denied and the
 * refusals included: per the fail-loud policy, the caller surfaces
 * `err.message` rather than this module deciding what the operator gets to see.
 */
export async function transitionBookingStatus(
  args: TransitionBookingStatusArgs,
): Promise<TransitionBookingStatusResult> {
  return call<TransitionBookingStatusArgs, TransitionBookingStatusResult>(
    'transitionBookingStatus',
    args,
  );
}

/** Approves a DRAFT/PENDING request: the server moves it to SCHEDULED. */
export async function approveBooking(bookingId: string): Promise<void> {
  await transitionBookingStatus({ sessionId: bookingId, action: 'APPROVE' });
}

/**
 * Rejects a DRAFT/PENDING request: one that was NEVER approved, so no visit was
 * ever promised to the household and nothing is billable.
 *
 * Lands on the same stored `CANCELLED` as `cancelBooking` because this
 * collection has no distinct "rejected" value (the same asymmetry
 * `batchUpdateBookings.ts`'s own comment documents for its sibling model). The
 * two stay separate exports, and separate server ACTIONS, because the audit
 * entry records which one the operator chose and which status it came from, so
 * "declined a request" and "called off a promised visit" remain two different
 * events after the fact.
 */
export async function rejectBooking(bookingId: string): Promise<void> {
  await transitionBookingStatus({ sessionId: bookingId, action: 'REJECT' });
}

/**
 * Cancels an already-approved visit: SCHEDULED, or one already in flight
 * (ON_MY_WAY / ARRIVED / DEPARTED). The household was told this was happening,
 * and a partly-performed visit may still be billable. See `rejectBooking` for
 * why both land on `CANCELLED` and are still different actions.
 *
 * `reason` is optional free text; the server appends it to the session's own
 * notes as `[Booking cancelled] <reason>` and records only that one was given,
 * never the text, in the audit payload.
 */
export async function cancelBooking(bookingId: string, reason?: string): Promise<void> {
  await transitionBookingStatus({
    sessionId: bookingId,
    action: 'CANCEL',
    ...(reason !== undefined && reason.trim() !== '' ? { reason: reason.trim() } : {}),
  });
}

/**
 * Marks a visit COMPLETED. `completedAtIso` is still the CALLER's "now", not a
 * server timestamp, because every reader of this collection already parses that
 * (`lib/bookingDetailFormat.ts`, Android's `DashboardInsights.kt`) and a
 * server-stamped value would be a second, differently-skewed kind of instant on
 * one field. The server stamps its own ISO string when the caller omits it, so
 * a completed visit is never missing the field.
 */
export async function markBookingCompleted(bookingId: string, completedAtIso: string): Promise<void> {
  await transitionBookingStatus({
    sessionId: bookingId,
    action: 'COMPLETE',
    completedAt: completedAtIso,
  });
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
  args: CreateMultiDateBookingRequestArgs,
): Promise<CreateMultiDateBookingRequestResult> {
  if (!args.idempotencyKey) {
    // #644: refused rather than silently sent unkeyed. The call below opts into
    // a retry on `functions/internal`, and the ONE thing that makes that safe is
    // the server deduping on this key. A caller that forgot it would get a
    // silent double booking -- the exact outcome #630 refused to risk. The key
    // is optional on `bookingSubmission` so the wizard's unit tests need not
    // invent one, which is precisely why the guard belongs HERE, on the seam
    // that turns the retry on. Same refusal as the portal's `requestBooking`.
    throw new Error(
      'createMultiDateBookingRequest needs an idempotencyKey. See lib/bookingIdempotency.ts.',
    );
  }
  return call<CreateMultiDateBookingRequestArgs, CreateMultiDateBookingRequestResult>(
    'createMultiDateBookingRequest',
    args,
    { idempotent: true },
  );
}

/**
 * The three transitions `batchUpdateBookings` accepts, aliased off the
 * generated `BatchUpdateBookingsArgs` rather than re-declared (the
 * `InvoiceState` convention in `api/invoices.ts`).
 */
export type BatchBookingAction = BatchUpdateBookingsArgs['action'];

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
  return call<BatchUpdateBookingsArgs, BatchUpdateBookingsResult>('batchUpdateBookings', {
    ids,
    action,
  });
}

/**
 * rescheduleBooking (admin callable): server-bound reschedule of a
 * `kin_care_sessions` doc. Matches the backend's Zod contract exactly,
 * `{ sessionId, startTime, endTime }`, both times free-text (min 1 / max 40
 * chars server-side, the same opaque-string convention `BookingEntry.startTime`
 * already documents), not a Timestamp. Throws (via lib/fns.call) on `not-found`
 * / `invalid-argument` / auth errors; the caller surfaces the message fail-loud.
 *
 * IT NOW REFUSES TWO THINGS IT USED TO ALLOW (#397 M13). The server checks the
 * NEW window against Google Calendar busy imports and against the visits already
 * on the books before it writes — two gaps that only became reachable by a
 * gesture when the Schedule grid gained drag-to-reschedule. Both refuse with
 * `failed-precondition` and a machine `details.code`, and both are overridable
 * by an operator who has been shown the clash; the company-closure refusal
 * beside them is not. `overrides` is omitted entirely on a first attempt, so the
 * wire shape is unchanged for every existing caller.
 */
export async function rescheduleBooking(
  sessionId: string,
  startTime: string,
  endTime: string,
  overrides: { visit?: boolean; busy?: boolean } = {},
): Promise<RescheduleBookingResult> {
  return call<RescheduleBookingArgs, RescheduleBookingResult>('rescheduleBooking', {
    sessionId,
    startTime,
    endTime,
    ...(overrides.visit === true && { overrideVisitConflict: true }),
    ...(overrides.busy === true && { overrideBusyConflict: true }),
  });
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

/**
 * addBookingNote (portal callable, staff-or-member gated): append a
 * KINFOLK-FACING note to `.../kinCares/{visitId}/notes`.
 *
 * NOTE the codebase this lives in: it is the one note verb that is NOT under
 * `functions/src/admin/`, because the household writes it too
 * (`functions/src/portal/addBookingNote.ts`). Consequences that matter here:
 *  - the SERVER enforces the 3-hour cutoff (`lib/bookingNoteCutoff.ts`),
 *    rejecting with `failed-precondition` + `{ code: 'booking_note_cutoff' }`.
 *    The client lock in `lib/bookingDetailFormat.ts` is a courtesy so the
 *    operator is not surprised; this rejection is the real gate and is
 *    surfaced verbatim.
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
): Promise<AddBookingNoteResult> {
  return call<AddBookingNoteArgs, AddBookingNoteResult>('addBookingNote', {
    kinfolkId,
    batchId,
    visitId,
    body: body.trim(),
  });
}

/**
 * addInternalBookingNote (admin callable): append a STAFF-ONLY note to
 * `.../kinCares/{visitId}/internalNotes`, a separate subcollection whose read
 * rule is `isAuntie()` alone.
 *
 * SAME 3-HOUR CUTOFF as `addBookingNote`, enforced SERVER-SIDE since
 * 2026-07-25 through the shared `functions/src/lib/bookingNoteCutoff.ts`. Both
 * threads reject identically: `failed-precondition` with
 * `details.code === 'booking_note_cutoff'`.
 *
 * It did not always: the rule was private to `addBookingNote`, so this thread
 * was guarded by client code alone and any other caller, a stale bundle, or a
 * direct invocation wrote straight past it. The composer lock in the sheet is
 * now a courtesy so the operator is not surprised by a rejection, not the
 * enforcement.
 */
export async function addInternalBookingNote(
  kinfolkId: string,
  batchId: string,
  visitId: string,
  body: string,
): Promise<AddInternalBookingNoteResult> {
  return call<AddInternalBookingNoteArgs, AddInternalBookingNoteResult>('addInternalBookingNote', {
    kinfolkId,
    batchId,
    visitId,
    body: body.trim(),
  });
}
