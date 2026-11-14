import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { resolveKinfolkAccess } from '../lib/resolveKinfolkAccess';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { refuseAuntie } from '../lib/staffGate';
import { TRIBETAILS_CORS } from '../lib/cors';
import { fillBusinessPlaceholders, loadBusinessName } from '../lib/businessName';
import { NOTIFICATION_CATALOG, canonicalNotificationKey } from '../notifications/catalog';
import {
  householdNoticeRuleFor,
  householdNoticeTarget,
} from '../notifications/buildNotificationDetail';
import {
  countUnreadNotifications,
  isVisibleNotification,
  recipientNotificationsQuery,
  toIsoOrNull,
  toMillisOrNull,
} from '../lib/recipientNotifications';

/**
 * #1316: the notifications list behind the portal's bell.
 *
 * The dispatcher has written one `notifications/{id}` row per alert for every
 * household since the start (booking confirmed, invoice sent, KinTale posted,
 * a comment, a Kin removal outcome...), and `markNotificationRead` has let a
 * household stamp one read, but no portal callable ever listed them: the bell
 * opened Notification settings on both clients. This is the read.
 *
 * SHAPE. The recipient's rows, newest first, with the one count the bell draws.
 * Each item carries what a row needs to draw itself (title, description, who
 * did it, when, read or not) and what a tap needs to open the thing it is about
 * (`targetType` + `targetId`, as the dispatcher resolved them). For a booking
 * the item also carries `visitId` and `batchId` off the row's `data`, because
 * `targetId` is a VISIT for per-visit events (`onBookingsWrite`) and a BATCH
 * for whole-request events (`kincare.requested`, the series approval, a
 * declined request), and a client cannot tell the two apart from the id alone.
 * `detail` rides along verbatim when the dispatcher resolved one: a kinfolk can
 * already read their own row field for field, and the household copy never
 * carried staff notes (#380).
 *
 * GATE. Signed in, not an Auntie (she never uses the kinfolk portal), then
 * `resolveKinfolkAccess` for the tribe, then `recipientUid == uid` on the
 * query. The tribe filter is applied in code (see lib/recipientNotifications.ts),
 * so a kinfolk holding two tribes sees each tribe's rows under that tribe.
 *
 * PAGING. `limit + 1` rows are fetched; the extra one is `hasMore`, and
 * `nextBefore` is the newest-first createdAt of the last RAW row of the page,
 * not the last visible one, so a page whose rows were all archived still hands
 * back a cursor that advances. `before` is that value, exclusive.
 *
 * `unreadCount` is the same number `getMyHome.unreadNotifications` reports, from
 * the same helper, so the bell and the list never disagree about it.
 */

export const Args = z.object({
  kinfolkId: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  /** `nextBefore` from the previous page: that page's oldest `createdAt`, in ms. */
  before: z.number().int().positive().optional(),
});

const DEFAULT_LIMIT = 50;

export interface NotificationListItem {
  id: string;
  key: string;
  category: string;
  title: string;
  description: string;
  actorName: string;
  actorPhotoUrl: string;
  /** 'booking' | 'invoice' | 'kintale' | 'kinfolk' | 'conversation' | '' as the dispatcher resolved it. */
  targetType: string;
  targetId: string;
  /** The visit, when the row is about one visit. Null for a whole-request event. */
  visitId: string | null;
  /** The booking request (envelope), when the row names one. */
  batchId: string | null;
  /** ISO 8601, or null when the row holds no readable time. */
  createdAt: string | null;
  /** ISO 8601 when read, null while unread. */
  readAt: string | null;
  detail?: Record<string, unknown>;
}

export interface ListMyNotificationsResult {
  items: NotificationListItem[];
  unreadCount: number;
  hasMore: boolean;
  nextBefore: number | null;
}

type Data = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** A string id, or null. A number id (older AuntieOS rows) is read as its digits. */
function idOrNull(v: unknown): string | null {
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/**
 * #1831: the title a household reads for a key, from the catalog as it is now,
 * so a row stored under the operator's label ("KinTale (visit report)
 * published", "Pets updated or added") reads the household's title instead.
 * Null for a key with no household title, and for a broadcast, whose stored
 * title is the subject the office wrote. `{business}` is left for the caller.
 */
export function householdTitleTemplate(key: string): string | null {
  if (key === 'broadcast.message' || !householdNoticeRuleFor(key)) return null;
  const title = NOTIFICATION_CATALOG[canonicalNotificationKey(key)]?.householdTitle?.trim();
  return title ? title : null;
}
/**
 * #1831: the line under a household row's title. A copy written since #1831
 * carries `householdLine`, built from its facts when it was written. An older
 * row's `description` is the operator's or the settings wording, and its stored
 * times predate the Time Blocks rule, so it shows its title alone. A broadcast
 * is the exception: its stored description is the body the office wrote.
 */
function householdLineOf(key: string, data: Data): string {
  if (typeof data['householdLine'] === 'string') return data['householdLine'].trim();
  return key === 'broadcast.message' ? str(data['description']).trim() : '';
}
/**
 * One row as the household reads it (#1831, #1898, #1913).
 *
 * - `title`: the household's title for the key ({@link householdTitleTemplate}),
 *   else what the row stored.
 * - `description`: the content line ({@link householdLineOf}): which Kin,
 *   which KinCare and when; the KinTale and who commented; the Kin. Never an
 *   older row's stored description, which is the operator's or the settings
 *   wording. '' when there is none, and the client shows the title alone.
 * - `targetType` / `targetId`: what a tap opens (`householdNoticeTarget`).
 *
 * `businessName` fills `{business}` in a title; undefined leaves "your Auntie".
 */
export function toNotificationListItem(id: string, data: Data, businessName?: string): NotificationListItem {
  const bag = (typeof data['data'] === 'object' && data['data'] !== null ? data['data'] : {}) as Data;
  const detail = data['detail'];
  const key = str(data['key']);
  const household = householdNoticeRuleFor(key) !== undefined;
  const row = {
    key,
    recipientUid: str(data['recipientUid']),
    description: str(data['description']),
    detail: typeof detail === 'object' && detail !== null ? (detail as Data) : undefined,
    data: bag,
    targetType: str(data['targetType']),
    targetId: str(data['targetId']),
  };
  const titleTemplate = householdTitleTemplate(key);
  const target = householdNoticeTarget(row);
  return {
    id,
    key,
    category: str(data['category']),
    title: titleTemplate !== null ? fillBusinessPlaceholders(titleTemplate, businessName) : str(data['title']),
    description: household ? householdLineOf(key, data) : str(data['description']),
    actorName: str(data['actorName']),
    actorPhotoUrl: str(data['actorPhotoUrl']),
    targetType: target.targetType,
    targetId: target.targetId,
    visitId: idOrNull(bag['visitId']) ?? idOrNull(bag['kinCareId']),
    batchId: idOrNull(bag['batchId']),
    createdAt: toIsoOrNull(data['createdAt']),
    readAt: toIsoOrNull(data['readAt']),
    ...(typeof detail === 'object' && detail !== null ? { detail: detail as Record<string, unknown> } : {}),
  };
}

export async function listMyNotificationsHandler(
  req: CallableRequest<unknown>,
): Promise<ListMyNotificationsResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  refuseAuntie(req.auth, 'listMyNotifications');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data ?? {});
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'listMyNotifications validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const hasAdminClaim = req.auth?.token?.admin === true;
  const { kinfolkId } = await resolveKinfolkAccess(uid, args.kinfolkId, hasAdminClaim, 'listMyNotifications');
  const firestore = db();
  const limit = args.limit ?? DEFAULT_LIMIT;

  let page = recipientNotificationsQuery(firestore, uid);
  if (args.before !== undefined) {
    page = page.where('createdAt', '<', Timestamp.fromMillis(args.before));
  }

  const [snap, unreadCount] = await Promise.all([
    page.limit(limit + 1).get(),
    countUnreadNotifications(firestore, uid, kinfolkId),
  ]);

  const hasMore = snap.docs.length > limit;
  const pageDocs = snap.docs.slice(0, limit);
  const lastRaw = pageDocs[pageDocs.length - 1];
  const nextBefore = hasMore && lastRaw ? toMillisOrNull((lastRaw.data() as Data)['createdAt']) : null;

  const visible = pageDocs
    .map((doc) => ({ id: doc.id, data: doc.data() as Data }))
    .filter(({ data }) => isVisibleNotification(data, kinfolkId));
  // One settings read, and only when a title on this page names the business.
  const needsName = visible.some(({ data }) => /\{business/i.test(householdTitleTemplate(str(data['key'])) ?? ''));
  const businessName = needsName ? await loadBusinessName('listMyNotifications') : undefined;
  const items = visible.map(({ id, data }) => toNotificationListItem(id, data, businessName));

  logEvent({
    severity: 'info',
    function: 'listMyNotifications',
    event: 'portal.notifications.listed',
    uid,
    extra: { kinfolkId, returned: items.length, unreadCount, hasMore },
  });

  return { items, unreadCount, hasMore, nextBefore };
}

export const listMyNotifications = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('listMyNotifications', listMyNotificationsHandler),
);
