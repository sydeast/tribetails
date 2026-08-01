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
 * Is this row filed away?
 *
 * ONE predicate, and it must stay one, because there are now TWO ways a doc can
 * be un-archived on the wire and only one of them is "the field is absent":
 *
 *   - a notification nobody ever archived has no `archivedAt` key at all
 *     (dispatcher.ts does not write one), and
 *   - a notification that was archived and then RESTORED carries
 *     `archivedAt: null`, because `unarchiveNotification` merge-writes null
 *     rather than deleting the field (see CALLABLE_CONTRACT.md: an absent field
 *     is unreachable by any future Firestore predicate, an explicit null is not).
 *
 * The old test was `r.archivedAt === undefined`, which would have read a
 * restored row as still archived and hidden it forever, with no error anywhere.
 * An undo that silently does nothing is worse than no undo at all, so the
 * null case is handled here, in the one place both the feed filter and the
 * facet read.
 */
export function isNotificationArchived(entry: NotificationEntry): boolean {
  return entry.archivedAt !== undefined && entry.archivedAt !== null;
}

/**
 * Archived notifications never reappear in the DEFAULT feed (the wasm
 * `activeNotifications` rule). Input order is preserved, so the server's
 * newest-first ordering survives.
 *
 * Still the default, but no longer the only view: `notificationsForArchived`
 * below is what lets the operator go and look at what they filed away, which is
 * the other half of making Archive reversible.
 */
export function activeNotifications(rows: readonly NotificationEntry[]): NotificationEntry[] {
  return rows.filter((r) => !isNotificationArchived(r));
}

/**
 * The three-state archive facet, mirroring the Invoices screen's exactly:
 * hide archived (the default), show them alongside the active feed, or show only
 * them. Kept as a shared selector rather than an inline filter so the screen and
 * its tests agree on what each mode means.
 *
 * Deliberately NOT a fourth filter chip. The chips answer "which category", and
 * archived-ness is orthogonal to that: an archived booking notification is still
 * a booking notification. Folding them together would make "Booking" and
 * "Archived" mutually exclusive, which is false.
 */
export type NotificationArchivedMode = 'hide' | 'include' | 'only';

export function notificationsForArchived(
  rows: readonly NotificationEntry[],
  mode: NotificationArchivedMode,
): NotificationEntry[] {
  if (mode === 'hide') return rows.filter((r) => !isNotificationArchived(r));
  if (mode === 'only') return rows.filter((r) => isNotificationArchived(r));
  return [...rows];
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

/**
 * How many of these rows the dispatcher says it actually DELIVERED.
 *
 * A separate axis from read state, and the reason the Notifications stat strip
 * carries both: `status` describes the dispatcher's own pipeline (a `pending`
 * row is one the sender has not gotten out of the door yet), while `readAt`
 * describes the operator. A dispatched notification can be unread, and an unread
 * notification can be one that never went anywhere. Collapsing the two would
 * hide a delivery outage behind a healthy-looking inbox.
 *
 * Counted over the ACTIVE feed, like every other figure on the strip, so
 * archiving a row takes it out of all three counts together rather than out of
 * some of them.
 */
export function dispatchedNotificationCount(rows: readonly NotificationEntry[]): number {
  return activeNotifications(rows).filter(
    (r) => (r.status ?? '').trim().toLowerCase() === 'dispatched',
  ).length;
}

/**
 * The rows the "mark read" bulk action should actually be sent.
 *
 * NOT simply "the selection". `bulkMarkNotificationsRead` returns how many it
 * really marked and skips rows already read, so sending a selection of five that
 * contains three read rows comes back as `marked: 2` and the screen reported
 * "Marked 2 of 5, the rest were already read or not yours to mark." That is a
 * partial-failure sentence for a batch in which nothing failed, on the most
 * ordinary action the screen has (select a day, mark it read).
 *
 * Narrowing to the unread subset here makes the count on the button, the count
 * sent to the server, and the count in any partial report all the same number,
 * so the warning fires only when something genuinely went wrong. Android
 * narrows the same way (`unreadSelected`).
 */
export function unreadAmong(
  rows: readonly NotificationEntry[],
  selectedIds: ReadonlySet<string>,
): string[] {
  return rows.filter((r) => selectedIds.has(r._id) && !isRead(r)).map((r) => r._id);
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
