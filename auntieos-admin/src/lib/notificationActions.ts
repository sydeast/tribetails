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
   * The RAW envelope visit id for Approve/Deny, or '' when this is not a
   * booking notification. Underived on purpose: those callables act on
   * `families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}`, so the
   * `vis_` form `open` carries would be the wrong id here.
   */
  bookingId: string;
  /** Destination for "Create quote", or null when no household is identifiable. */
  quote: NotificationRoute | null;
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
 * APPROVE/DENY calls `batchUpdateBookings` with APPROVE/REJECT, and that is
 * only the right callable for a FRESH request: `kincare.reschedule.requested`
 * resolves through `resolveBookingRescheduleRequest`, and
 * `kincare.cancel.requested` resolves through the #438 accept/decline path.
 * Offering Approve/Deny on either would fire the wrong callable at the entity.
 * A notification doc carries no live visit status to re-check ("is this still
 * pending?"), so pendency is read off the dispatch key itself:
 * `kincare.requested` only ever fires once, at the moment of the ask, which is
 * the moment nothing has ruled on it yet. A request an admin has since decided
 * keeps offering Approve/Deny on its original card until the row is archived
 * or read away; that is not silently wrong, because `bookingAction` in
 * Notifications.tsx fails loud on a stale click (`batchUpdateBookings`
 * resolving `failed[]` or `updated === 0` lands in the error banner, never a
 * fake success).
 *
 * CREATE QUOTE is offered for a quote or a booking request that has no
 * invoice yet: `quote.denied` (the quote itself was rejected, no bill exists)
 * or `kincare.requested` (a fresh ask, nothing billed) PROVIDED the entry does
 * not already reference an invoice (`targetType === 'invoice'`, or
 * `data.invoiceId`). `quote.accepted` is excluded because that quote already
 * became the bill. Every other event, including a declined request or an
 * assignment change, gets none of this: an already-decided or non-billing
 * event has nothing left to approve, deny or quote. The button still
 * disappears when no household is identifiable, same as before.
 */
export function applicableNotificationActions(entry: NotificationEntry): NotificationActionSet {
  const type = normalizedTargetType(entry.targetType);
  const targetId = str(entry.targetId).trim();
  const key = str(entry.key).trim();

  const isPendingBookingRequest =
    key === PENDING_BOOKING_REQUEST_KEY && type === 'booking' && targetId !== '';

  const hasInvoiceReference = type === 'invoice' || str(rec(entry.data)['invoiceId']).trim() !== '';
  const isQuoteDenial = key === QUOTE_DENIED_KEY;
  const isUninvoicedBookingRequest = key === PENDING_BOOKING_REQUEST_KEY && !hasInvoiceReference;
  const kinfolkId = notificationKinfolkId(entry);
  const quoteEligible = kinfolkId !== '' && (isQuoteDenial || isUninvoicedBookingRequest);

  return {
    open: notificationTargetRoute(entry.targetType, entry.targetId),
    bookingId: isPendingBookingRequest ? targetId : '',
    quote: quoteEligible ? notificationQuoteRoute(kinfolkId) : null,
  };
}
