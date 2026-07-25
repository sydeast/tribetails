import { str } from './coerce';
import { normalizedTargetType, notificationKinfolkId } from './notificationContext';
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
 * Deep links land as SEARCH params rather than paths for invoices and kintales
 * because both screens open their detail as an in-screen modal over the list
 * (the list is the route), while a household profile is a screen of its own, so
 * `kinfolk` gets the real `/directory/{id}` path.
 *
 * BOOKING CARRIES NO ID, and that is not an oversight. A booking notification's
 * `targetId` is an ENVELOPE visit id (`families/{kinfolkId}/bookings/{batchId}/
 * kinCares/{visitId}`, the model `batchUpdateBookings` acts on), while the
 * Bookings screen lists the FLAT `kin_care_sessions` collection. Those are
 * different id spaces, so `?bookingId=<envelope id>` would select nothing and
 * be exactly the dead link this table exists to prevent. The row's Approve/Deny
 * buttons act on that envelope id directly, which is what the operator actually
 * wants from a booking-request notification; Open just takes them to Bookings.
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
      return { to: '/bookings' };
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
  /** Booking id for Approve/Deny, or '' when this is not a booking notification. */
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
