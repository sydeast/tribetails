import { collection, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { firestore } from './firebase';
import { badgeRowFromDoc, UNREAD_SCAN_CAP, type BadgeRow } from './unreadBadge';

/**
 * #1833: the live read behind the bell's count, the signed-in person's own
 * newest `notifications` rows.
 *
 * WHY THE RULES ALLOW IT. `firestore.rules`, `match /notifications/{id}`:
 * `allow read: if signedIn() && resource.data.recipientUid == request.auth.uid`,
 * and no client writes. A list query is admitted only when it carries the
 * `recipientUid == <own uid>` filter, which this one does; an unfiltered
 * listen is denied. `functions/test/rules/flatCollections.test.ts` pins the
 * query form. Nothing new is exposed: `listMyNotifications` already hands the
 * same person these rows.
 *
 * SAME ROWS AS THE SERVER'S COUNT. `recipientUid ==`, newest first, the newest
 * 100: the query `countUnreadNotifications` runs, on the composite index
 * `notifications: recipientUid ASC, createdAt DESC` that already exists.
 *
 * Read only. Marking a row read stays with `markNotificationRead`.
 */
/** One snapshot of those rows, as the bell needs it. */
export interface UnreadSnapshot {
  rows: BadgeRow[];
  /** #2329: read from this browser's cache, not (yet) from the server. */
  fromCache: boolean;
  /** A row arrived, left or changed. False for a snapshot that only says where it came from. */
  rowsChanged: boolean;
}
/**
 * #2329: metadata changes are listened to as well, so the moment the server
 * first answers is seen even when it agrees with what the cache said (an
 * offline start with nothing unread). Without them that answer raises no
 * snapshot, and the bell would stay on the count the portal opened with.
 */
export function subscribeUnreadRows(
  uid: string,
  onSnapshotRows: (snapshot: UnreadSnapshot) => void,
  onError: (err: unknown) => void,
): () => void {
  const q = query(
    collection(firestore, 'notifications'),
    where('recipientUid', '==', uid),
    orderBy('createdAt', 'desc'),
    limit(UNREAD_SCAN_CAP),
  );
  return onSnapshot(
    q,
    { includeMetadataChanges: true },
    (snapshot) =>
      onSnapshotRows({
        rows: snapshot.docs.map((doc) => badgeRowFromDoc(doc.id, doc.data() as Record<string, unknown>)),
        fromCache: snapshot.metadata.fromCache,
        rowsChanged: snapshot.docChanges().length > 0,
      }),
    onError,
  );
}
