import type { NoticeOpenTarget } from './noticeOpenTarget';
import { AUNTIE_SCHEDULE_URL, PORTAL_URL } from './visitDates';
import type { AudienceStream } from './types';

/**
 * #2487 (owner report): "the actual links to whatever each notice is about".
 *
 * `{{link}}` is the address a notice's email button and text message open. A
 * household's copy opens its item in MyTribe, the same place a tap on its push
 * or on its row in the notifications list opens (`noticeOpenTarget`). An office
 * or Auntie copy opens the item in auntieOS, the same place Open on the admin
 * notifications list goes (`officeRouteFor`, a copy of the admin's
 * `notificationOpenRoute`). A notice that names nothing to open links to the
 * reader's notifications list, the household's at this notice's own entry.
 *
 * WHY IT IS SAFE TO SEND. The link is a path and ids, nothing else. Every
 * screen it opens reads through the signed-in reader's own access, so a link
 * opened signed out, or by someone it was not sent to, shows nothing that
 * person could not already open; signed out, both sites send the reader to
 * sign in and then on to the link (#1384). A household's target is decided per
 * key (`householdNoticeTarget`) and never names the office's household record.
 * Household ids are percent-encoded and office ids must be plain record ids,
 * so an id cannot add a path part, a query key or another site.
 *
 * PURE. No reads.
 */

/** auntieOS. The Auntie schedule link the #536 emitters already send is this site. */
export const ADMIN_URL = AUNTIE_SCHEDULE_URL;
/** The admin notifications list: where an office copy with nothing more specific opens. */
export const OFFICE_NOTICE_LIST_PATH = '/notifications';

/** The admin client's `isRouteSafeId` (lib/notificationActions.ts), the same pattern. */
const ROUTE_SAFE_ID = /^[A-Za-z0-9_.:~+-]{1,200}$/;
function routeSafe(id: string): boolean {
  return ROUTE_SAFE_ID.test(id) && id !== '.' && id !== '..';
}
/** The admin client's `VISIT_SESSION_PREFIX` (api/bookings.ts). */
const VISIT_SESSION_PREFIX = 'vis_';
/** The admin client's `UNAPPLIED_PAYMENTS_SECTION`. */
export const UNAPPLIED_PAYMENTS_SECTION = 'unapplied-payments';
/**
 * The first path part of every auntieOS screen an Auntie cannot open
 * (`ownerOnly` in the admin client's lib/nav.ts). A link there would only send
 * her Home, so her copy links to her notifications list instead.
 */
export const AUNTIE_REFUSED_SLUGS: ReadonlySet<string> = new Set([
  'invites',
  'packages',
  'invoices',
  'activity',
  'settings',
  'tribal-intel',
  'templates',
  'form-schemas',
  'feature-flags',
]);

function text(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

function withSearch(path: string, search: Record<string, string>): string {
  const q = new URLSearchParams(search).toString();
  return q ? `${path}?${q}` : path;
}

export interface OfficeRouteInput {
  key: string;
  /** The work order's own, as stored: a string, or a number on an older row. */
  targetType?: unknown;
  targetId?: unknown;
  data?: Record<string, unknown>;
}

/**
 * Where Open goes on the admin notifications list for this notice, as a path,
 * or null when it opens nothing. Mirrors `notificationOpenRoute` and the
 * request-card rule of `applicableNotificationActions`; the shared cases in
 * `noticeLink.test.ts` pin the two.
 */
export function officeTargetRoute(input: OfficeRouteInput): string | null {
  const key = text(input.key);
  const type = text(input.targetType).toLowerCase();
  const id = text(input.targetId);
  const data = input.data ?? {};
  const kinfolkId = text(data['kinfolkId']) || text(data['familyId']) || (type === 'kinfolk' ? id : '');

  if (key === 'kin.removal.requested') {
    const requestId = text(data['requestId']);
    if (routeSafe(requestId)) return withSearch('/bookings', { kinRemoval: requestId });
  }
  if (key === 'invoice.payment.unapplied' && routeSafe(kinfolkId)) {
    const paymentId = text(data['stripeEventId']);
    return withSearch(`/directory/${kinfolkId}`, {
      section: UNAPPLIED_PAYMENTS_SECTION,
      ...(routeSafe(paymentId) ? { paymentId } : {}),
    });
  }
  // A whole booking (its batch is its target), and a fresh request, open on Bookings.
  const batchId = text(data['batchId']);
  const wholeBooking = type === 'booking' && batchId !== '' && batchId === id;
  const freshRequest = key === 'kincare.requested' && type === 'booking' && id !== '';
  if (wholeBooking || freshRequest) {
    return routeSafe(id) && routeSafe(kinfolkId)
      ? withSearch('/bookings', { requestId: id, requestKinfolkId: kinfolkId })
      : null;
  }
  if (!routeSafe(id)) return null;
  switch (type) {
    case 'invoice':
      return withSearch('/invoices', { invoiceId: id });
    case 'kintale':
      return withSearch('/kintales', { kinTaleId: id });
    case 'kinfolk':
      return `/directory/${id}`;
    case 'booking':
      return withSearch('/bookings', {
        bookingId: id.startsWith(VISIT_SESSION_PREFIX) ? id : `${VISIT_SESSION_PREFIX}${id}`,
      });
    default:
      return null;
  }
}

/** An office or Auntie copy's path in auntieOS. Never null: the list is the fallback. */
export function officeRouteFor(input: OfficeRouteInput & { auntie: boolean }): string {
  const route = officeTargetRoute(input);
  if (route === null) return OFFICE_NOTICE_LIST_PATH;
  const slug = route.split(/[/?]/)[1] ?? '';
  // An Auntie is never handed money: the unapplied payment opens a household's credit section.
  if (input.auntie && (AUNTIE_REFUSED_SLUGS.has(slug) || input.key === 'invoice.payment.unapplied')) {
    return OFFICE_NOTICE_LIST_PATH;
  }
  return route;
}

export interface NoticeLinkInput extends OfficeRouteInput {
  stream?: AudienceStream;
  /**
   * The copy is an Auntie's (the catalog row resolves to the visit's assigned
   * Auntie). Not read off the stream: a `staff` stream also marks the owner's
   * copy of a key the catalog shares with staff.
   */
  auntie?: boolean;
  /** The household copy's open target, from `noticeOpenTarget` for the same work order. */
  open?: NoticeOpenTarget;
}

/** The whole address `{{link}}` fills with for one copy of one notice. */
export function noticeLink(input: NoticeLinkInput): string {
  if (input.stream === 'kinfolk') {
    const route = input.open?.route ?? input.open?.readInList?.route ?? '/notifications';
    return `${PORTAL_URL}${route}`;
  }
  return `${ADMIN_URL}${officeRouteFor({ ...input, auntie: input.auntie === true })}`;
}
