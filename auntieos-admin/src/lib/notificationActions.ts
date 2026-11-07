import { rec, str } from './coerce';
import { normalizedTargetType, notificationKinfolkId } from './notificationContext';
import { sessionIdForVisit } from '../api/bookings';
import { type NotificationEntry } from '../api/notifications';

/**
 * The ACTION half of a notification row: where a row can take you, and which
 * quick actions it may offer.
 *
 * Ported from the archive's `NotificationActions.kt` (`applicableActions` +
 * `NAVIGABLE_TARGET_TYPES`), kept pure and out of the component for the same
 * reason the Kotlin original did: these are decisions, and decisions get tested
 * without a renderer.
 *
 * The routing table is the part worth guarding. An `Open` button that navigates
 * nowhere is worse than no button, so an unknown or missing `targetType` yields
 * `null` here and the component renders no control at all.
 */

/**
 * A destination in the admin router, shaped for TanStack's `navigate()`. The
 * screen never calls the router itself: it hands one of these to its
 * `onNavigate` prop and `router.tsx` performs the navigation, which is what
 * keeps this table unit-testable and the screen renderable without a router
 * (the same prop convention `Directory`'s `onSelectKinfolk` already uses).
 */
export interface NotificationRoute {
  to: string;
  params?: Record<string, string>;
  search?: Record<string, string>;
}

/**
 * Where a notification's linked item lives. One entry per target type the
 * dispatcher writes; anything else is null.
 *
 * Deep links land as SEARCH params rather than paths for invoices, bookings and
 * kintales because all three screens open their detail as an in-screen modal
 * over the list (the list is the route), while a household profile is a screen
 * of its own, so `kinfolk` gets the real `/directory/{id}` path.
 *
 * BOOKING CROSSES TWO ID SPACES, and the crossing is deterministic. A booking
 * notification's `targetId` is an ENVELOPE visit id
 * (`families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}`, the model
 * `batchUpdateBookings` acts on), while the Bookings screen lists the FLAT
 * `kin_care_sessions` collection. This table used to drop the id entirely, on
 * the reasoning that the two spaces were unbridgeable. They are not: the
 * session doc is minted at exactly `vis_{visitId}` by
 * `approveBookingSeriesCore.ts:95`, and `manageBookingSeries.ts:100` and
 * `batchUpdateBookings.ts:184` both re-derive that id to mirror onto it.
 * `sessionIdForVisit` is that derivation. Dropping the id was the booking half
 * of issue #389: Open landed on the list, the behaviour the operator called out
 * as contradicting the purpose of the feature.
 *
 * ONE REAL CAVEAT, answered on the screen rather than here: a visit that is
 * still REQUESTED has no session document at all, because one is only created
 * on approval, so its derived id resolves to nothing. Bookings says so in its
 * "Booking unavailable" dialog; it never opens an empty sheet and never leaves
 * the operator to conclude the list was the destination.
 *
 * The Approve/Deny path below still carries the RAW envelope id. Those
 * callables act on the envelope, so deriving there would break them.
 */
export function notificationTargetRoute(rawType: unknown, rawId: unknown): NotificationRoute | null {
  const type = normalizedTargetType(rawType);
  const id = str(rawId).trim();
  if (type === null || id === '') return null;
  switch (type) {
    case 'invoice':
      return { to: '/invoices', search: { invoiceId: id } };
    case 'kintale':
      return { to: '/kintales', search: { kinTaleId: id } };
    case 'kinfolk':
      return { to: '/directory/$kinfolkId', params: { kinfolkId: id } };
    case 'booking':
      return { to: '/bookings', search: { bookingId: sessionIdForVisit(id) } };
  }
}

/** #1003: the `section` search value that opens "Payments needing a decision". */
export const UNAPPLIED_PAYMENTS_SECTION = 'unapplied-payments';

/**
 * #1003: a card payment Stripe took that could not be applied to its invoice.
 * The server targets the INVOICE, but the decision lives on the HOUSEHOLD
 * profile (its Account credit panel), so this key opens the profile instead.
 * `data.stripeEventId` is the payment's id; its Decide dialog opens on arrival.
 */
const UNAPPLIED_PAYMENT_KEY = 'invoice.payment.unapplied';

/**
 * Where "Open" goes for one notification: a per-key override first, then the
 * target-type table above. Only `invoice.payment.unapplied` overrides today,
 * and only when the notice names its household; without one it falls back to
 * the invoice like any other invoice notice.
 */
export function notificationOpenRoute(entry: NotificationEntry): NotificationRoute | null {
  if (str(entry.key).trim() === UNAPPLIED_PAYMENT_KEY) {
    const kinfolkId = notificationKinfolkId(entry);
    if (kinfolkId !== '') {
      const paymentId = str(rec(entry.data)['stripeEventId']).trim();
      return {
        to: '/directory/$kinfolkId',
        params: { kinfolkId },
        search: {
          section: UNAPPLIED_PAYMENTS_SECTION,
          ...(paymentId !== '' ? { paymentId } : {}),
        },
      };
    }
  }
  return notificationTargetRoute(entry.targetType, entry.targetId);
}

/**
 * The Invoices quote composer, seeded with a household. The archive threaded
 * the same seed through its App shell as `composeQuoteForKinfolkId`; here it
 * rides the URL, so the seeded composer survives a reload and is linkable.
 */
export function notificationQuoteRoute(rawKinfolkId: unknown): NotificationRoute | null {
  const id = str(rawKinfolkId).trim();
  return id === '' ? null : { to: '/invoices', search: { composeQuoteForKinfolkId: id } };
}

/**
 * Which quick actions a row may offer. Read/unread and archive are unconditional
 * (every notification can be read and filed), so they are not modelled here; the
 * three CONDITIONAL affordances are.
 */
export interface NotificationActionSet {
  /** Destination for "Open", or null when there is nothing to open. */
  open: NotificationRoute | null;
  /**
   * The waiting request's envelope id (`batchId`) for Approve/Deny, or '' when
   * this row is not a request still waiting on a decision. With the row's
   * household (`notificationKinfolkId`) it names
   * `families/{kinfolkId}/bookings/{batchId}`, what `manageBookingSeries`
   * answers (#1675).
   */
  bookingId: string;
  /** Destination for "Create quote", or null when no household is identifiable. */
  quote: NotificationRoute | null;
  /**
   * #1647: how an answered request ended ("Booked", "Declined", "Cancelled"),
   * shown where Approve/Deny used to be. Null on every row that is not an
   * answered `kincare.requested`.
   */
  outcome: string | null;
}

/**
 * #1647: the operator-facing word for how a booking request ended, read off the
 * `requestResolution` stamp the server writes onto the request's rows once it
 * is booked or declined. Null while the request is still waiting.
 *
 * An unrecognised non-blank value still counts as answered and reads
 * "Answered": the server only stamps a row once the request has left
 * `requested`, so offering Approve on it would fire at a request that is no
 * longer waiting. A blank or absent value is still waiting.
 */
export function requestOutcomeLabel(entry: NotificationEntry): string | null {
  if (str(entry.key).trim() !== PENDING_BOOKING_REQUEST_KEY) return null;
  const resolution = str(entry.requestResolution).trim().toLowerCase();
  if (resolution === '') return null;
  switch (resolution) {
    case 'booked':
      return 'Booked';
    case 'declined':
      return 'Declined';
    case 'cancelled':
      return 'Cancelled';
    default:
      return 'Answered';
  }
}

/**
 * The one catalog key that means "a booking request is waiting on a decision"
 * (mytribe/functions/src/notifications/catalog.ts: "Kinfolk requested a
 * KinCare visit"). Fired once, at the moment of the ask, by
 * onBookingEnvelopeCreate.ts.
 */
const PENDING_BOOKING_REQUEST_KEY = 'kincare.requested';

/** The household turned a quote down; a new quote is the natural follow-up. */
const QUOTE_DENIED_KEY = 'quote.denied';

/**
 * RULING (issue #706, operator: "most of these don't need most of these
 * ctas"). Every booking-flavoured row used to offer Approve/Deny, and any row
 * naming a household offered Create quote, regardless of what the event was or
 * what had already happened to it. Narrowed per event below.
 *
 * APPROVE/DENY answers the whole request through `manageBookingSeries`
 * (#1675), the call Bookings > Review makes. The row's `targetId` is the
 * request's envelope id (`batchId`, written by `onBookingEnvelopeCreate`), and
 * `batchUpdateBookings`, which these buttons used to call, only knows visit
 * ids, so every press came back not-found. It needs the household too, so a row
 * that names none offers no Approve/Deny. Only a FRESH request takes this
 * path: `kincare.reschedule.requested`
 * resolves through `resolveBookingRescheduleRequest`, and
 * `kincare.cancel.requested` resolves through the #438 accept/decline path.
 * Offering Approve/Deny on either would fire the wrong callable at the entity.
 * Pendency is read off the dispatch key PLUS the server's answer stamp:
 * `kincare.requested` only ever fires once, at the moment of the ask, and
 * #1647 has the server stamp `requestResolution` on its rows once the request
 * is booked or declined anywhere (`onBookingEnvelopeResolve`). An answered
 * request offers no Approve/Deny; it shows its outcome instead (`outcome`),
 * and "Needs a decision" stops counting it because that count is derived from
 * `bookingId` below. Before #1647 a booked request kept offering Approve/Deny
 * on its card until the row was archived.
 *
 * CREATE QUOTE is offered for a quote or a booking request that has no
 * invoice yet: `quote.denied` (the quote itself was rejected, no bill exists)
 * or `kincare.requested` (a fresh ask, nothing billed) PROVIDED the entry does
 * not already reference an invoice (`targetType === 'invoice'`, or
 * `data.invoiceId`). `quote.accepted` is excluded because that quote already
 * became the bill. Every other event, including a declined request or an
 * assignment change, gets none of this: an already-decided or non-billing
 * event has nothing left to approve, deny or quote. That includes a request
 * the server has stamped as answered (#1647): it is no longer a fresh ask. The
 * button still disappears when no household is identifiable, same as before.
 */
export function applicableNotificationActions(entry: NotificationEntry): NotificationActionSet {
  const type = normalizedTargetType(entry.targetType);
  const targetId = str(entry.targetId).trim();
  const key = str(entry.key).trim();
  const outcome = requestOutcomeLabel(entry);

  const kinfolkId = notificationKinfolkId(entry);
  const isPendingBookingRequest =
    key === PENDING_BOOKING_REQUEST_KEY &&
    outcome === null &&
    type === 'booking' &&
    targetId !== '' &&
    kinfolkId !== '';

  const hasInvoiceReference = type === 'invoice' || str(rec(entry.data)['invoiceId']).trim() !== '';
  const isQuoteDenial = key === QUOTE_DENIED_KEY;
  const isUninvoicedBookingRequest =
    key === PENDING_BOOKING_REQUEST_KEY && outcome === null && !hasInvoiceReference;
  const quoteEligible = kinfolkId !== '' && (isQuoteDenial || isUninvoicedBookingRequest);

  return {
    open: notificationOpenRoute(entry),
    bookingId: isPendingBookingRequest ? targetId : '',
    quote: quoteEligible ? notificationQuoteRoute(kinfolkId) : null,
    outcome,
  };
}
