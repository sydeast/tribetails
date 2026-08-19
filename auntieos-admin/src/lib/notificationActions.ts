import { str } from './coerce';
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

export function applicableNotificationActions(entry: NotificationEntry): NotificationActionSet {
  const type = normalizedTargetType(entry.targetType);
  const targetId = str(entry.targetId).trim();

  // DELIBERATE WIDENING of the archive rule, disclosed rather than silent.
  // `NotificationActions.kt` offered Create quote only when targetType ==
  // 'kinfolk', because targetId was the only household reference it read. This
  // build derives the household from `data.kinfolkId` too (see
  // notificationContext.ts), so an invoice or booking notification that names
  // its household can also spawn a quote for it. The button still disappears
  // entirely when no household is identifiable, which is the property the
  // archive's rule was really protecting.
  return {
    open: notificationTargetRoute(entry.targetType, entry.targetId),
    bookingId: type === 'booking' ? targetId : '',
    quote: notificationQuoteRoute(notificationKinfolkId(entry)),
  };
}
