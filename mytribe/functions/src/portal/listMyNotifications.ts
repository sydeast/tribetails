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
  /** 'booking' | 'invoice' | 'kintale' | 'kinfolk' | '' as the dispatcher resolved it. */
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

export function toNotificationListItem(id: string, data: Data): NotificationListItem {
  const bag = (typeof data['data'] === 'object' && data['data'] !== null ? data['data'] : {}) as Data;
  const detail = data['detail'];
  return {
    id,
    key: str(data['key']),
    category: str(data['category']),
    title: str(data['title']),
    description: str(data['description']),
    actorName: str(data['actorName']),
    actorPhotoUrl: str(data['actorPhotoUrl']),
    targetType: str(data['targetType']),
    targetId: str(data['targetId']),
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

  const items: NotificationListItem[] = [];
  for (const doc of pageDocs) {
    const data = doc.data() as Data;
    if (!isVisibleNotification(data, kinfolkId)) continue;
    items.push(toNotificationListItem(doc.id, data));
  }

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
