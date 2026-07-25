import { dayKey, isRead, type NotificationEntry } from '../api/notifications';

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

/** The bucket a row with a blank or absent `category` falls into. */
const UNCATEGORIZED = 'uncategorized';

/** Sentinel filter value for the "Unread" chip. Never a real category name. */
export const NOTIF_UNREAD_FILTER = ' unread';

/**
 * The categories actually present in the feed, sorted. Ports the archive's
 * `NotificationsScreen.kt` FilterRow rule verbatim: the chips reflect what the
 * dispatcher really emitted, never an invented taxonomy that would leave the
 * operator clicking chips that match nothing.
 */
export function notificationCategories(rows: readonly NotificationEntry[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) seen.add((r.category ?? '').trim() || UNCATEGORIZED);
  return [...seen].sort();
}

/**
 * The rows visible under the active filter chip: `null` = All,
 * [NOTIF_UNREAD_FILTER] = unread (by the real `readAt` field), anything else a
 * category match. A category nothing matches yields an EMPTY list, not a silent
 * fallback to everything: the operator asked to narrow, so an empty result is
 * the honest answer and the screen says so.
 */
export function notificationsForFilter(
  rows: readonly NotificationEntry[],
  filter: string | null,
): NotificationEntry[] {
  if (filter === null) return [...rows];
  if (filter === NOTIF_UNREAD_FILTER) return rows.filter((r) => !isRead(r));
  return rows.filter((r) => ((r.category ?? '').trim() || UNCATEGORIZED) === filter);
}

/**
 * Day separators. Groups by LOCAL day (`dayKey`, see lib/time for why local and
 * not UTC), preserving the stream's own newest-first order both between groups
 * and within one. Rows whose `createdAt` has not round-tripped yet collect under
 * a single "Undated" separator rather than being dropped.
 */
export function notificationsByDay(
  rows: readonly NotificationEntry[],
): [string, NotificationEntry[]][] {
  const groups = new Map<string, NotificationEntry[]>();
  for (const r of rows) {
    const day = dayKey(r.createdAt);
    const bucket = groups.get(day);
    if (bucket) bucket.push(r);
    else groups.set(day, [r]);
  }
  return [...groups.entries()];
}
