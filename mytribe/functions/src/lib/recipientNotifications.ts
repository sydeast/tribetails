import type { Firestore } from 'firebase-admin/firestore';

/**
 * #1316: the one reading of a household's `notifications/{id}` rows, shared by
 * `getMyHome` (the bell badge) and `listMyNotifications` (the list the bell
 * opens), so "unread" and "visible" mean the same thing on both.
 *
 * WHAT IS VISIBLE. A row the dispatcher wrote for this recipient
 * (`recipientUid == uid`, the query predicate) that is not archived and is
 * about the household the caller is signed into. Archive is `archivedAt`
 * carrying a value: the archive callables stamp a timestamp, the restore
 * callables write `null`, and the dispatcher writes nothing, so null and
 * absent are both "active" (the same predicate the React admin's
 * `isNotificationArchived` uses). The tribe check reads `data.kinfolkId`
 * (`familyId` is the older spelling `resolveTargetRef` also accepts): a row
 * that names a household other than the active one is left out, so a
 * kinfolk who holds two tribes sees each tribe's notifications under that
 * tribe, and a row that names none is shown everywhere.
 *
 * WHAT IS UNREAD. `readAt` is written ONLY by `markNotificationRead` and the
 * bulk read callable, and `markNotificationUnread` deletes it, so an unread
 * row simply LACKS the field. Firestore's `== null` matches only documents
 * that have the field, so no query can count these; the count here is a scan
 * of the newest rows, capped, with the filter applied in code.
 */

export const NOTIFICATIONS_COLLECTION = 'notifications';

/**
 * How far back the badge looks. A household with more than this many unread
 * rows reads a count of this many, which is already past what the badge can
 * draw (both clients cap the display at 99+).
 */
export const UNREAD_SCAN_CAP = 100;

type Data = Record<string, unknown>;

/** A string id, or '' when the field is missing, blank or not an id. */
function idOf(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

/** `archivedAt` carrying a value. Null and absent are both active. */
export function isArchivedNotification(data: Data): boolean {
  return data['archivedAt'] !== undefined && data['archivedAt'] !== null;
}

/** No `readAt` on the row. The field is absent on an unread row, never blank. */
export function isUnreadNotification(data: Data): boolean {
  return data['readAt'] === undefined || data['readAt'] === null;
}

/**
 * Whether a row belongs under the active tribe. A row that names a different
 * household is another tribe's; a row that names none is shown under every
 * tribe the caller holds.
 */
export function isForTribe(data: Data, kinfolkId: string): boolean {
  const bag = data['data'];
  if (typeof bag !== 'object' || bag === null) return true;
  const named = idOf((bag as Data)['kinfolkId']) || idOf((bag as Data)['familyId']);
  return named === '' || named === kinfolkId;
}

/** Visible in the list and counted on the bell: active, and about this tribe. */
export function isVisibleNotification(data: Data, kinfolkId: string): boolean {
  return !isArchivedNotification(data) && isForTribe(data, kinfolkId);
}

/**
 * Epoch millis from whatever a timestamp field holds, or null. A live row
 * carries a Firestore `Timestamp`; seeded and backfilled rows have carried a
 * `Date` or a plain millis number. Anything else reads as absent, never as
 * the epoch.
 */
export function toMillisOrNull(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof (value as { toMillis?: () => number }).toMillis === 'function') {
    const ms = (value as { toMillis: () => number }).toMillis();
    return typeof ms === 'number' && Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** ISO 8601 for the wire, or null when the field holds no readable time. */
export function toIsoOrNull(value: unknown): string | null {
  const ms = toMillisOrNull(value);
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * The recipient's newest rows, newest first. Both callers start here; the
 * list adds a cursor and a page size, the badge count takes the cap.
 */
export function recipientNotificationsQuery(firestore: Firestore, uid: string) {
  return firestore
    .collection(NOTIFICATIONS_COLLECTION)
    .where('recipientUid', '==', uid)
    .orderBy('createdAt', 'desc');
}

/**
 * How many of the recipient's newest `UNREAD_SCAN_CAP` rows are visible under
 * this tribe and still unread. Needs the composite index
 * `notifications: recipientUid ASC, createdAt DESC` (firestore.indexes.json).
 */
export async function countUnreadNotifications(
  firestore: Firestore,
  uid: string,
  kinfolkId: string,
): Promise<number> {
  const snap = await recipientNotificationsQuery(firestore, uid).limit(UNREAD_SCAN_CAP).get();
  let unread = 0;
  for (const doc of snap.docs) {
    const data = doc.data() as Data;
    if (isVisibleNotification(data, kinfolkId) && isUnreadNotification(data)) unread += 1;
  }
  return unread;
}
