import { call } from '../lib/fns';
import type {
  ListPendingBookingRequestsArgs,
  ListPendingBookingRequestsResult,
  ListPendingBookingRequestsResultRequest,
  ManageBookingSeriesArgs,
  ManageBookingSeriesResult,
} from '../contracts/bookingContracts.generated';

/**
 * The office's end of a NEW booking request (issue #533).
 *
 * A household asks for care in the portal, which writes a booking ENVELOPE at
 * `families/{kinfolkId}/bookings/{batchId}` with its visits underneath, all
 * `requested`. Before this file, nothing in the React admin read that back. The
 * Bookings list streams the flat `kin_care_sessions` collection, and an envelope
 * visit only becomes a session once it is approved, so a pending request stayed
 * invisible there BY DESIGN (see `api/bookings.ts`'s header) and
 * `VisitRequestsSection` held only the reschedule and cancellation asks. A
 * household could ask for care and never be answered. THIS FILE is what closed
 * that gap.
 *
 * Same reason as `cancelRequests.ts` and `rescheduleRequests.ts` for arriving
 * through a callable rather than `useCollection`: the requests live in the
 * per-household `kinCares` subcollection and `CollectionSpec` has no
 * collection-group variant.
 *
 * ONE ROW PER REQUEST, NOT PER VISIT. A long weekend is four visit documents and
 * one request, `manageBookingSeries` rules on the whole envelope in a single
 * transaction, and #532 is the standing lesson that the per-visit grain is wrong
 * for anything about a request. So these rows carry a `batchId` and NO
 * `visitId`, unlike the other two queues.
 */

export type PendingBookingRequestDto = ListPendingBookingRequestsResultRequest;

/** Every booking request still waiting on an answer, oldest ask first. */
export function listPendingBookingRequests(
  limit?: number,
): Promise<ListPendingBookingRequestsResult> {
  const payload: ListPendingBookingRequestsArgs = limit !== undefined ? { limit } : {};
  return call<ListPendingBookingRequestsArgs, ListPendingBookingRequestsResult>(
    'listPendingBookingRequests',
    payload,
  );
}

/**
 * Approves a whole request: every visit becomes `confirmed` and gets its
 * `kin_care_sessions` row, so it appears on the Bookings list and the schedule.
 * Idempotent server-side, so a double-click cannot double-book.
 *
 * #536: the household now hears ONCE, naming every date, instead of once per
 * visit. The result carries `householdNotified` and `newlyConfirmed` so the
 * toast can report what actually happened rather than assume it: a re-approve
 * confirms nothing and tells nobody, and a partial failure leaves the request
 * retryable with the household still waiting.
 */
export function approveBookingRequest(
  kinfolkId: string,
  batchId: string,
): Promise<ManageBookingSeriesResult> {
  return call<ManageBookingSeriesArgs, ManageBookingSeriesResult>('manageBookingSeries', {
    action: 'APPROVE',
    kinfolkId,
    batchId,
  });
}

/**
 * Declines a whole request. Nothing is booked, and the household is told once,
 * with the operator's reason, through `kincare.request.declined`.
 *
 * The `note` is not decoration. A request turned down with no reason is the
 * same silence #533 is about, one step later.
 */
export function declineBookingRequest(
  kinfolkId: string,
  batchId: string,
  note: string,
): Promise<ManageBookingSeriesResult> {
  return call<ManageBookingSeriesArgs, ManageBookingSeriesResult>('manageBookingSeries', {
    action: 'CANCEL',
    kinfolkId,
    batchId,
    note,
  });
}
