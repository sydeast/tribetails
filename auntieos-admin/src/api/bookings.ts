import { type CollectionSpec } from '../lib/firestore';
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
export interface BookingEntry {
  _id: string;
  kinfolkId: string;
  kinfolkName: string;
  serviceType: string;
  status: string;
  startTime: string;
  completedAt: string;
  departedAt: string;
  notes: string;
  kinfolkNotes: string;
  createdAt: Timestamp | null;
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
 * OUT OF SCOPE, flagged rather than silently dropped: the wasm's "Incoming
 * requests" panel (BookingScreen.kt:314-338) reads a SEPARATE
 * collection-GROUP query over
 * `families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}`
 * (`client.incomingKinCaresStream()`) and lets the operator Approve/Cancel a
 * whole MyTribe request series via the `manageBookingSeries` callable.
 * Neither is ported here, for two independent reasons:
 *
 *   1. lib/firestore.ts's `CollectionSpec` wraps a single
 *      `collection(db, spec.path)` query; it has no collection-GROUP variant,
 *      so streaming the nested `kinCares` subcollection across every kinfolk
 *      would need a new capability added to that SHARED helper, not a
 *      screen-local workaround bolted onto this file.
 *   2. Approve/Cancel are WRITE actions that call the `manageBookingSeries`
 *      callable. This port is LIST ONLY per the brief: no BookingDetail
 *      dialog, no create/edit flow, no row actions.
 *
 * A future BookingDetail screen (or a dedicated "Incoming requests" screen) is
 * where both belong, once `CollectionSpec` grows collection-group support.
 */
