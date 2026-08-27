import { type CollectionSpec } from '../lib/firestore';
import type { SessionEntry } from './sessions';
import type { Timestamp } from 'firebase/firestore';

/**
 * One `kin_care_sessions` row, the flat, top-level collection that is the
 * actual visit the admin schedules, runs, and completes. Confirmed against:
 *   - firestore.rules:203-209 `match /kin_care_sessions/{sessionId}`:
 *     `allow read: if isAuntie() || ...`, the same unmediated whole-collection
 *     admin read INVOICES_QUERY / KINFOLK_QUERY document, and (unlike
 *     `invoices`) `allow create/update/delete: if isAuntie() || ...` too, the
 *     admin app writes this collection directly via the client SDK, not only
 *     through a callable.
 *   - createKinCareSession.ts (`db().collection('kin_care_sessions').add(...)`,
 *     the server-bound manual-create path, `status: 'SCHEDULED'`).
 *   - approveBookingSeriesCore.ts (`db().collection('kin_care_sessions').doc(
 *     'vis_' + id)`, the path that turns an APPROVED MyTribe booking-envelope
 *     visit into one of these, also `status: 'SCHEDULED'`).
 *
 * THIS IS A SEPARATE COLLECTION from the MyTribe booking-envelope model
 * (`families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}`, nested,
 * lowercase status requested/confirmed/cancelled/unavailable), see the
 * OUT-OF-SCOPE note at the bottom of this file. `kin_care_sessions` is what
 * the wasm's BookingScreen.kt calls via `sessionsStream()` /
 * `bookingRequestsStream()`, and is the source for its Scheduled + History
 * sections and for this list.
 *
 * Only the fields this list row actually renders are modeled here (the
 * NotificationEntry / Kinfolk / Kin subset convention), not the ~30-field
 * KinCareSession in the wasm's FirestoreClient.kt (GPS summary, form values,
 * report ids, breadcrumbs, etc. all belong to a future detail/session-day
 * screen, not this list).
 *
 * `startTime` / `completedAt` / `departedAt` are opaque STRINGS, not
 * Timestamps, see lib/bookingFormat.ts's `bookingWhen` doc for why and how
 * they're parsed (approveBookingSeriesCore.ts's own comment: "kinCares stores
 * start/end as Firestore Timestamps; kin_care_sessions stores them as
 * ISO-8601 strings"). `createdAt` IS a real `FieldValue.serverTimestamp()`
 * (createKinCareSession.ts / approveBookingSeriesCore.ts), which is why it is
 * this query's sort key below rather than the free-text `startTime`.
 */
/**
 * OPTIONAL ON PURPOSE (2026-07-20). This interface is a CAST over raw Firestore
 * data, not a validation of it, and the documents genuinely lack these keys:
 * `serviceType` is ABSENT on 76 of the 99 live kin_care_sessions.
 *
 * Declaring them required told TypeScript a lie. `.trim()` compiled fine, threw
 * at runtime, and React's error boundary blanked the whole Schedule and
 * Bookings pages over it. Optional moves that failure from a white screen in
 * front of the operator to a compile error in front of us.
 *
 * Do NOT "fix" a compile error here by restoring the non-null type. Default the
 * READ instead: `?? ''`, or `str()` from lib/coerce.
 *
 * EXTENDS `SessionEntry` (api/sessions.ts) rather than re-declaring its own
 * flat field list, because the two were never two shapes: both are a row of
 * `kin_care_sessions`, the same collection, read by two independent listeners
 * (`api/schedule.ts` makes the same point in the other direction, aliasing
 * `ScheduleSessionEntry = SessionEntry`). Two hand-maintained copies of one
 * document's fields is how a screen ends up unable to open a component that
 * reads the SAME doc: before this, Bookings could not hand a row to
 * `BookingDetailModal` even though every field that sheet reads
 * (`kinCareBatchId`, `kinCareVisitId`, `serviceDurationMinutes`, `reportIds`)
 * is stamped on these very documents by `approveBookingSeriesCore.ts`. They
 * were absent from the TYPE, never from the data.
 *
 * The three fields declared here are the ones `SessionEntry` does not carry:
 * `departedAt` and `kinfolkNotes`, which only this list's `bookingWhen` /
 * note-preview read, and `createdAt`, which is this query's sort key.
 */
export interface BookingEntry extends SessionEntry {
  /** Free-text stamp, same opaque-string caveat as `startTime`; one of the
   *  fallbacks `lib/bookingFormat.ts#bookingWhen` walks for a legacy row whose
   *  `startTime` is blank. */
  departedAt?: string | undefined;
  /** The household's own note on the request, preferred over the staff `notes`
   *  in this list's row preview. */
  kinfolkNotes?: string | undefined;
  /** A real `FieldValue.serverTimestamp()`, unlike every other time on this
   *  doc, which is why BOOKINGS_QUERY sorts by it. Required (nullable), not
   *  optional: `useCollection` hands back `null` while the local write is
   *  pending rather than omitting the key. */
  createdAt: Timestamp | null;
  /**
   * BACK-REFERENCE TO THE ENVELOPE MODEL, stamped by
   * `approveBookingSeriesCore.ts` on every session it creates from an approved
   * booking request (`kinCareVisitId: id`, alongside the deterministic
   * `vis_{id}` session doc id). It names the
   * `families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}` doc this row
   * is the admin-side copy of.
   *
   * ABSENT on a legacy or ad-hoc session, which has no envelope counterpart at
   * all. That is not a data gap to paper over: it is the difference between a
   * row whose household-facing copy must be kept in step and a row that has
   * none. `lib/bookingBulk.ts` is where that distinction is acted on.
   */
  kinCareVisitId?: string | undefined;
}

/**
 * The prefix that turns an envelope VISIT id into the flat SESSION doc id.
 *
 * Not a convention someone hopes holds: three server paths mint the session doc
 * at exactly `vis_{visitId}`, and nothing else ever creates one from a visit:
 * `approveBookingSeriesCore.ts:95` (the only writer that creates the session),
 * `manageBookingSeries.ts:100` and `batchUpdateBookings.ts:184` (both of which
 * re-derive the same id to mirror a status onto it).
 */
const VISIT_SESSION_PREFIX = 'vis_';

/**
 * The flat `kin_care_sessions` doc id for an envelope visit id.
 *
 * This is what bridges the two id spaces a booking notification straddles: its
 * `targetId` is the ENVELOPE visit id
 * (`families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}`), while every
 * admin booking surface reads the flat collection. The bridge is deterministic,
 * so a deep link needs no lookup table and no second query to cross it.
 *
 * An id that ALREADY carries the prefix is returned unchanged, so this is safe
 * to apply to a targetId whose emitter threaded the flat session id instead
 * (`resolveTargetRef` in the dispatcher accepts `data.bookingId` as well as
 * `data.visitId`, and the two are not always the same space). That passthrough
 * is what makes the pair below a genuine round trip rather than a one-way guess.
 */
export function sessionIdForVisit(visitId: string): string {
  const id = visitId.trim();
  if (id === '') return '';
  return id.startsWith(VISIT_SESSION_PREFIX) ? id : `${VISIT_SESSION_PREFIX}${id}`;
}

/**
 * The envelope visit id a flat session doc id was minted from, or the id
 * unchanged when it carries no prefix. A manually-created or legacy session has
 * no envelope counterpart at all, as `kinCareVisitId` above records, so there is
 * no visit id to recover and inventing one would be worse than saying so.
 */
export function visitIdForSession(sessionId: string): string {
  const id = sessionId.trim();
  return id.startsWith(VISIT_SESSION_PREFIX) ? id.slice(VISIT_SESSION_PREFIX.length) : id;
}

/**
 * The bounded, server-ordered `kin_care_sessions` listener. Ordered by
 * `createdAt` descending, capped at 200, the same INVOICES_QUERY convention:
 * `createdAt` is a real server timestamp on every doc, where `startTime` is an
 * opaque, sometimes-blank string (see BookingEntry's doc above), so ordering
 * by it can't silently drop or misplace an undated draft the way sorting by
 * `startTime` could.
 *
 * DELIBERATE IMPROVEMENT over the wasm reference, not a faithfully-ported
 * behavior: the wasm's `sessionsStream()` platform implementation is a plain
 * `collectionStream("kin_care_sessions")`, an unbounded whole-collection
 * listen, the exact AO-29 pattern `useCollection` exists to close off by
 * construction. This spec is what makes that fix apply here too.
 *
 * NO `filters`, a single-field orderBy needs no composite index (same note
 * as INVOICES_QUERY / NOTIFICATIONS_QUERY). All status filtering (the
 * Draft/Pending/Scheduled/Completed/Cancelled tabs) happens client-side over
 * the already-streamed page, same as the wasm's own client-side
 * `.filter { it.status == ... }`.
 */
export const BOOKINGS_QUERY: CollectionSpec = {
  path: 'kin_care_sessions',
  order: ['createdAt', 'desc'],
  max: 200,
};

/**
 * DELIBERATELY DOES NOT CARRY the wasm's "Incoming requests" panel
 * (BookingScreen.kt:314-338), which reads a SEPARATE collection-GROUP query
 * over `families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}`
 * (`client.incomingKinCaresStream()`) and lets the operator Approve/Cancel a
 * whole MyTribe request series via the `manageBookingSeries` callable. This
 * spec stays a flat, single-collection `kin_care_sessions` stream, and an
 * envelope request never becomes a `kin_care_sessions` doc until it is
 * approved, so it never appears in this list. That's fine: the same
 * capability shipped, on the same screen, through `api/bookingRequests.ts`
 * (issue #533) — `VisitRequestsSection` renders it alongside the reschedule
 * and cancellation queues, reaching the nested `kinCares` data through the
 * `listPendingBookingRequests` / `approveBookingRequest` /
 * `declineBookingRequest` callables rather than a `CollectionSpec` listener.
 * `CollectionSpec` still has no collection-group variant, and this is why it
 * no longer needs one: the callable route already reaches that data, the
 * same way `api/cancelRequests.ts` and `api/rescheduleRequests.ts` do for the
 * other two request kinds.
 */
