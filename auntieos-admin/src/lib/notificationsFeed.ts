import { isRead, type NotificationEntry } from '../api/notifications';

/**
 * Pure `notifications` feed selectors, shared by the Notifications SCREEN and
 * the Inbox's Notifications digest strip.
 *
 * These used to live as a private helper inside `screens/Notifications.tsx`.
 * They moved here when the Inbox grew its own notifications section (Task 2.2,
 * restoring the archive's stacked Notifications + Messages layout): two
 * surfaces reading the same collection must agree on what "active" and
 * "unread" mean, and the way to guarantee that is one definition, not two
 * that happen to match today.
 *
 * Both surfaces subscribe through the SAME bounded listener
 * (`NOTIFICATIONS_QUERY` in `api/notifications.ts`, createdAt desc, capped
 * 200); nothing here re-queries Firestore.
 */

/**
 * Archived notifications never reappear in the feed (the wasm
 * `activeNotifications` rule). Input order is preserved, so the server's
 * newest-first ordering survives.
 */
export function activeNotifications(rows: readonly NotificationEntry[]): NotificationEntry[] {
  return rows.filter((r) => r.archivedAt === undefined);
}

/**
 * The rows a digest strip should show: unread AND unarchived. Archiving is a
 * stronger signal than reading, so an archived-but-unread row is out; showing
 * it would resurrect something the operator deliberately filed away.
 */
export function unreadNotifications(rows: readonly NotificationEntry[]): NotificationEntry[] {
  return activeNotifications(rows).filter((r) => !isRead(r));
}

/**
 * Unread count for a badge. Only ever called on a RESOLVED stream: a count is
 * a claim, and `lib/async.ts` exists so nobody derives one from a failed read.
 */
export function unreadNotificationCount(rows: readonly NotificationEntry[]): number {
  return unreadNotifications(rows).length;
}
