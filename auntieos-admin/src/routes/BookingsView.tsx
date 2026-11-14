import { useSearch } from '@tanstack/react-router';
import { Bookings } from '../screens/Bookings';

/**
 * Adapts `/bookings?bookingId=<flat session id>` to Bookings' props, the same
 * one-line convention `InvoicesView` uses for `?invoiceId=`.
 *
 * The id in the URL is already the FLAT `kin_care_sessions` doc id: the
 * envelope-visit-to-session derivation happens once, in
 * `lib/notificationActions.ts`, so the URL names the thing the screen actually
 * opens and stays readable and shareable on its own terms.
 *
 * `/bookings?kinRemoval=<request id>` is the other arrival (#1912): the
 * "Kinfolk asked to remove a Kin" notice, which opens the removal queue here.
 *
 * `/bookings?requestId=<batch id>&requestKinfolkId=<household id>` is the
 * "Kinfolk requested a KinCare visit" notice (#2028), which opens that
 * request's card. A batch id is unique only inside its household, so both.
 */
export function BookingsView() {
  const { bookingId, kinRemoval, requestId, requestKinfolkId } = useSearch({ from: '/admin/bookings' });
  return (
    <Bookings
      {...(bookingId ? { initialBookingId: bookingId } : {})}
      {...(kinRemoval ? { kinRemovalRequestId: kinRemoval } : {})}
      {...(requestId && requestKinfolkId
        ? { focusRequest: { kinfolkId: requestKinfolkId, batchId: requestId } }
        : {})}
    />
  );
}
