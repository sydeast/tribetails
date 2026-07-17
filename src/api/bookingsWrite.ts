import { doc, updateDoc } from 'firebase/firestore';
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
 * OUT OF SCOPE, confirmed and flagged rather than silently added: `manageBookingSeries`
 * (MyTribe/functions/src/admin/manageBookingSeries.ts) and `batchUpdateBookings`
 * (MyTribe/functions/src/admin/batchUpdateBookings.ts) act on the SEPARATE nested
 * booking-envelope model (`families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}`),
 * the wasm's "Incoming requests" panel, not the flat `kin_care_sessions` rows this
 * screen lists. api/bookings.ts's own OUT-OF-SCOPE note already rules that panel
 * out of this port; these two callables stay out of scope for the same reason,
 * they would not act on the row BookingActions.tsx is showing.
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
