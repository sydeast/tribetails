import { rec, str } from './coerce';
import { normalizedTargetType, notificationKinfolkId } from './notificationContext';
import { sessionIdForVisit } from '../api/bookings';
import { isOwnerOnlyPath } from './nav';
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
 * #1912: a household asked to remove a Kin. The server targets the HOUSEHOLD,
 * and the household profile has no place to answer the request, so Open used
 * to land where nothing could be done. The queue on Bookings lists every
 * waiting request with Archive and Decline; `kinRemoval` names the one this
 * notice is about so the queue opens on arrival.
 */
const KIN_REMOVAL_REQUESTED_KEY = 'kin.removal.requested';
/**
 * Where "Open" goes for one notification: a per-key override first, then the
 * target-type table above. `invoice.payment.unapplied` overrides only when the
 * notice names its household, and `kin.removal.requested` only when it names
 * its request; without those each falls back to its target like any other
 * notice.
 */
export function notificationOpenRoute(entry: NotificationEntry): NotificationRoute | null {
  if (str(entry.key).trim() === KIN_REMOVAL_REQUESTED_KEY) {
    const requestId = str(rec(entry.data)['requestId']).trim();
    if (requestId !== '') return { to: '/bookings', search: { kinRemoval: requestId } };
  }
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

/** The identity of one waiting request: a batch id is unique only inside its household. */
export function pendingRequestKey(kinfolkId: string, batchId: string): string {
  return `${kinfolkId}/${batchId}`;
}
/**
 * #2028: where Open goes for a booking request: its card in the Bookings
 * Visit requests queue. `targetId` on `kincare.requested` is the request's
 * envelope id (`batchId`, since #532), and a request has no visit record until
 * it is booked, so the target table's `vis_{id}` lookup found nothing and the
 * operator got "Booking unavailable" instead of the request.
 */
export function notificationRequestRoute(kinfolkId: string, batchId: string): NotificationRoute {
  return { to: '/bookings', search: { requestId: batchId, requestKinfolkId: kinfolkId } };
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
   * shown where Approve/Deny used to be. #2069: "Answered" for a request the
   * live queue no longer holds and the server never stamped. Null on every row
   * that is not an answered `kincare.requested`.
   */
  outcome: string | null;
  /**
   * #2069: an unanswered request row whose waiting state is not known yet,
   * because the live queue has not read (or failed to). Neither offered as
   * waiting nor shown as answered.
   */
  awaitingQueue: boolean;
}

/**
 * #2069: the booking requests still waiting, keyed by `pendingRequestKey`
 * (`lib/pendingBookingRequests.ts`), or null while that read is in flight or
 * failed. Anything with `has` will do: the screen passes the queue's map.
 */
export type PendingRequestSet = { has(key: string): boolean } | null;

export interface NotificationActionContext {
  isAuntie?: boolean;
  /** Absent is the same as null: not known, so nothing is offered as waiting. */
  pendingRequests?: PendingRequestSet;
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
 * #2069 REQUIRES POSITIVE EVIDENCE. The stamp above only reaches rows written
 * after #1647, and rows from before it (the walk's August rows, some carrying a
 * visit id from before #532) never got one, so they kept Approve and Deny
 * three months after their visits had been booked, and "Needs a decision" read
 * 19 against Bookings' 5 waiting. A request is now offered as waiting only when
 * the live queue (`pendingRequests`, the same read Bookings > Review lists)
 * holds its household and batch. While that queue is still loading, or its read
 * failed, nothing is offered as waiting: Open is still there, and the request
 * is answered on its card.
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
export function applicableNotificationActions(
  entry: NotificationEntry,
  { isAuntie = false, pendingRequests = null }: NotificationActionContext = {},
): NotificationActionSet {
  const type = normalizedTargetType(entry.targetType);
  const targetId = str(entry.targetId).trim();
  const key = str(entry.key).trim();
  const stamped = requestOutcomeLabel(entry);

  const kinfolkId = notificationKinfolkId(entry);
  // A request row this client can answer: it names its household and batch.
  const isAnswerableRequest =
    key === PENDING_BOOKING_REQUEST_KEY && type === 'booking' && targetId !== '' && kinfolkId !== '';
  const isPendingBookingRequest =
    isAnswerableRequest &&
    stamped === null &&
    pendingRequests !== null &&
    pendingRequests.has(pendingRequestKey(kinfolkId, targetId));
  // #2069: the queue has spoken and this request is not on it.
  const knownAnswered = isAnswerableRequest && pendingRequests !== null && !isPendingBookingRequest;
  const outcome = stamped ?? (knownAnswered ? 'Answered' : null);

  const hasInvoiceReference = type === 'invoice' || str(rec(entry.data)['invoiceId']).trim() !== '';
  const isQuoteDenial = key === QUOTE_DENIED_KEY;
  const isUninvoicedBookingRequest = isPendingBookingRequest && !hasInvoiceReference;
  const quoteEligible = kinfolkId !== '' && (isQuoteDenial || isUninvoicedBookingRequest);

  // #2200 / #2201: an owner-only screen (Invoices, for these rows) sends an
  // Auntie Home, so for her a button into one is dropped rather than drawn as
  // a dead end. `bookingId` is untouched: Approve / Deny is hers, and the
  // "Needs a decision" count is derived from it.
  const forViewer = (route: NotificationRoute | null): NotificationRoute | null =>
    route !== null && isAuntie && isOwnerOnlyPath(route.to) ? null : route;

  // #2208: the unapplied-payment notice opens the household's Account credit
  // section, which is money and is not drawn for an Auntie. Without a
  // household it falls back to its invoice, which `forViewer` drops anyway.
  const isPaymentDecision = key === UNAPPLIED_PAYMENT_KEY;
  // #2028: a request opens on its card, unless the live queue says it is gone
  // and the server never stamped it. Such a row may predate #532 and carry a
  // visit id, which the target table still opens as that visit.
  const opensOnRequestCard = isAnswerableRequest && (stamped !== null || !knownAnswered);
  const open = opensOnRequestCard ? notificationRequestRoute(kinfolkId, targetId) : notificationOpenRoute(entry);
  return {
    open: isAuntie && isPaymentDecision ? null : forViewer(open),
    bookingId: isPendingBookingRequest ? targetId : '',
    quote: forViewer(quoteEligible ? notificationQuoteRoute(kinfolkId) : null),
    outcome,
    awaitingQueue: isAnswerableRequest && stamped === null && pendingRequests === null,
  };
}
