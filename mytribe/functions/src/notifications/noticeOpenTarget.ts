import { householdNoticeTarget } from './buildNotificationDetail';
import type { AudienceStream } from './types';

/**
 * #2259, #2100: WHAT A TAPPED PUSH OPENS.
 *
 * A push used to say only that something happened. The household's copy
 * carried the notifications list as its route (#2280) and the office's copy
 * carried no route at all, so a tap opened the app wherever it last was. The
 * notifications list has opened the exact visit, KinTale, Kin or invoice since
 * #1831, #1898 and #1913, from the row's `targetType` and `targetId`. This is
 * the same answer for the push, built from the same fields, so a tap on the
 * push and a tap on its row in the list cannot land in two places.
 *
 * THE WORK ORDER CARRIES THE TARGET. The push sender reads one document, the
 * work order, and never the notification beside it. The dispatcher stamps
 * `targetType` and `targetId` on the work order when it writes the two
 * together, and they are read back here.
 *
 * TWO SHAPES GO OUT, because the clients differ:
 *
 *   `route`: an in-app path of the MyTribe web portal, for a household's copy
 *   only. The portal's service worker opens it. Only the paths below are ever
 *   built, and every id is percent-encoded, so an id can never add a path
 *   part, a query or another site to the route.
 *
 *   `targetType`, `targetId`, `visitId`, `batchId`, and for the office's copy
 *   the household, removal request and payment the list's own Open reads: the
 *   Android apps build their typed destination from these and never from a
 *   path, so nothing a push says can name a screen the app does not have.
 *
 * A household's target is `householdNoticeTarget`'s, which is decided per key
 * and never names the office's household record. An office copy keeps the
 * target the dispatcher resolved.
 *
 * PURE. No reads: every value is already on the work order.
 */
export interface NoticeOpenTarget {
  /** The MyTribe web path a household's tap opens. Absent on an office copy, and when the notice names nothing to open. */
  route?: string;
  /** String data keys for the push payload. Blank values are left out. */
  data: Record<string, string>;
}

export interface NoticeOpenInput {
  key: string;
  stream?: AudienceStream;
  /** The work order's own `data`, as the emitter passed it (never the enriched template context). */
  data?: Record<string, unknown>;
  targetType?: unknown;
  targetId?: unknown;
}

function text(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  // An older AuntieOS row stores a number id; it is read as its digits.
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

/** One path part. An id with a slash, a question mark or a colon in it stays one part. */
function part(id: string): string {
  return encodeURIComponent(id);
}

/**
 * The portal path for a household target, or undefined when there is nothing
 * to open (the caller then sends the notifications list). The same table as
 * the portal's `notificationTarget` (web/src/lib/notificationsList.ts) and the
 * routes it navigates to (web/src/screens/NotificationsList.tsx).
 */
export function householdRouteFor(targetType: string, targetId: string, visitId: string): string | undefined {
  switch (targetType) {
    case 'booking':
      return visitId ? `/schedule/${part(visitId)}` : '/schedule';
    case 'invoice':
      return targetId ? `/invoices/${part(targetId)}` : undefined;
    case 'kintale':
      return targetId ? `/kintales?tale=${part(targetId)}` : '/kintales';
    case 'kin':
      return targetId ? `/kin/${part(targetId)}` : '/kin';
    case 'household':
      return '/tribe';
    case 'conversation':
      return '/messages';
    default:
      return undefined;
  }
}

export function noticeOpenTarget(input: NoticeOpenInput): NoticeOpenTarget {
  const bag = input.data ?? {};
  const household = input.stream === 'kinfolk';
  const stored = { targetType: text(input.targetType), targetId: text(input.targetId) };
  const target = household
    ? householdNoticeTarget({ key: input.key, data: bag, targetType: stored.targetType, targetId: stored.targetId })
    : stored;
  const visitId = text(bag['visitId']) || text(bag['kinCareId']);
  const batchId = text(bag['batchId']);

  const data: Record<string, string> = {};
  const put = (k: string, v: string) => {
    if (v !== '') data[k] = v;
  };
  put('targetType', target.targetType);
  put('targetId', target.targetId);
  if (target.targetType === 'booking') {
    put('visitId', visitId);
    put('batchId', batchId);
  }
  if (!household) {
    // What the office's notifications list reads for the notices whose Open is
    // not their target: the household (a visit request, an unapplied payment),
    // the Kin removal request, the payment waiting on a decision.
    put('kinfolkId', text(bag['kinfolkId']) || text(bag['familyId']));
    put('requestId', text(bag['requestId']));
    put('stripeEventId', text(bag['stripeEventId']));
  }

  const route = household ? householdRouteFor(target.targetType, target.targetId, visitId) : undefined;
  return route ? { route, data } : { data };
}
