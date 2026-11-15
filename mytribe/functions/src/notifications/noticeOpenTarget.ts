import { HOUSEHOLD_NOTE_KEYS, householdNoticeTarget } from './buildNotificationDetail';
import { HOUSEHOLD_NOTICE_ROUTE } from './templateParsers';
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
 * WHERE THE WHOLE MESSAGE IS (operator ruling 2026-11-14, #2030): a household's
 * push is a short line with a way to the full message in MyTribe. When the
 * line was cut, or the office wrote the household a note on this notice, the
 * full message is the notice's own entry on the notifications list, so the tap
 * opens the list at that entry (`readInList`) and not the visit or invoice.
 * Whether the line was cut is only known once it is rendered, so the push
 * sender makes the choice; this file says what each choice opens. An office
 * copy has no such choice and always opens its target.
 *
 * PURE. No reads: every value is already on the work order.
 */
export interface NoticeOpenTarget {
  /** The MyTribe web path a household's tap opens. Absent on an office copy, and when the notice names nothing to open. */
  route?: string;
  /** String data keys for the push payload. Blank values are left out. */
  data: Record<string, string>;
  /**
   * A household's copy only: the notifications list at this notice's entry,
   * for a push whose full message has to be read there. The route alone, with
   * no target fields, so every client follows it to the list.
   */
  readInList?: { route: string };
  /** A household's copy only: the office wrote the household a note on this notice. */
  officeNote?: boolean;
}

export interface NoticeOpenInput {
  key: string;
  stream?: AudienceStream;
  /** The work order's own `data`, as the emitter passed it (never the enriched template context). */
  data?: Record<string, unknown>;
  targetType?: unknown;
  targetId?: unknown;
  /** The work order's `notificationId`: the id of this notice's entry on the recipient's notifications list. */
  notificationId?: unknown;
}
/** The query key the notifications list reads the entry to show from. */
export const HOUSEHOLD_NOTICE_ENTRY_PARAM = 'entry';
/** The notifications list at one entry, or the plain list when the work order names none. */
export function householdNoticeEntryRoute(notificationId: string): string {
  return notificationId
    ? `${HOUSEHOLD_NOTICE_ROUTE}?${HOUSEHOLD_NOTICE_ENTRY_PARAM}=${part(notificationId)}`
    : HOUSEHOLD_NOTICE_ROUTE;
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

  if (!household) return { data };
  const route = householdRouteFor(target.targetType, target.targetId, visitId);
  return {
    ...(route ? { route } : {}),
    data,
    readInList: { route: householdNoticeEntryRoute(text(input.notificationId)) },
    // The list's own rule for showing the note (`buildNotificationDetail`).
    officeNote: HOUSEHOLD_NOTE_KEYS.has(input.key) && text(bag['note']) !== '',
  };
}
