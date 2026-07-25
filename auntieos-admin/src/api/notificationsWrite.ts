import { call } from '../lib/fns';

/**
 * The archive half of the `notifications` surface. The read/unread callables
 * live in `api/notifications.ts` alongside the query they belong to; archiving
 * gets its own module because it is the only write that REMOVES a row from the
 * feed, and because both callables here take a different argument key than the
 * mark-read pair does.
 *
 * ARGUMENT KEYS, checked against the deployed handlers rather than guessed:
 * `archiveNotification` parses `{ id }` and `bulkArchiveNotifications` parses
 * `{ ids }` (mytribe/functions/src/portal/archiveNotification.ts), while
 * `markNotificationRead` next door parses `{ notificationId }`. Sending
 * `notificationId` here would fail zod validation with an `invalid-argument`,
 * so the mismatch is deliberate and load-bearing.
 *
 * NOTHING IS DELETED. Both handlers stamp `archivedAt` (server timestamp) and
 * `archivedByUid` with a merge write; `activeNotifications` in
 * lib/notificationsFeed.ts is what actually hides the row. An archived
 * notification is still readable, and still audited (AUDIT_EVENTS.NOTIFICATIONS_ARCHIVE).
 */

/**
 * Archive one notification out of the active feed. Returns 1 when the write
 * landed and 0 when the server declined it: the handler skips a doc that is
 * missing, has no `recipientUid`, or belongs to someone else and the caller is
 * not an admin, and reports that as `archived: 0` rather than throwing. A 0 is
 * therefore a real answer the caller must surface, not a silent success.
 *
 * Throws (via lib/fns.call) on auth/validation failures; the caller shows the
 * message fail-loud.
 */
export async function archiveNotification(id: string): Promise<number> {
  const res = await call<{ id: string }, { archived: number }>('archiveNotification', { id });
  return res.archived;
}

/**
 * Archive a selected batch. Same per-id skip rule as the single version, so the
 * returned count can be smaller than `ids.length` on a partially stale
 * selection. Server-side the batch is capped at 200 ids.
 */
export async function bulkArchiveNotifications(ids: string[]): Promise<number> {
  const res = await call<{ ids: string[] }, { archived: number }>('bulkArchiveNotifications', {
    ids,
  });
  return res.archived;
}
