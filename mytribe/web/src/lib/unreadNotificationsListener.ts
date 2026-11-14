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
export function subscribeUnreadRows(
  uid: string,
  onRows: (rows: BadgeRow[]) => void,
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
    (snapshot) => onRows(snapshot.docs.map((doc) => badgeRowFromDoc(doc.id, doc.data() as Record<string, unknown>))),
    onError,
  );
}
