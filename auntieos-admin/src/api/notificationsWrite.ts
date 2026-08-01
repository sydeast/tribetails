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

/**
 * THE WAY BACK. Puts one notification into the active feed again.
 *
 * `archiveNotification` above had no inverse until now, and no client listed
 * archived rows, so Archive was a one-way door: a row filed away by mistake was
 * unreachable from every surface in the product. The Invoices screen already
 * refuses that shape, with `unarchiveInvoice` plus a three-state archive facet,
 * and a notification is not the thing that should be harder to undo.
 *
 * The server merge-writes `archivedAt: null` rather than deleting the field (see
 * CALLABLE_CONTRACT.md for the query reasoning), which is why
 * `isNotificationArchived` in lib/notificationsFeed.ts tests for a PRESENT,
 * non-null value rather than for the key existing at all. A restored row would
 * otherwise stay hidden forever, silently, which is the worst possible outcome
 * for an undo.
 *
 * Same skip-not-throw rule as the archive pair: a 0 means the server declined,
 * and the caller must say so rather than reading the resolve as success.
 */
export async function unarchiveNotification(id: string): Promise<number> {
  const res = await call<{ id: string }, { unarchived: number }>('unarchiveNotification', { id });
  return res.unarchived;
}

/** Restore a selected batch. Same per-id skip rule; capped at 200 ids server-side. */
export async function bulkUnarchiveNotifications(ids: string[]): Promise<number> {
  const res = await call<{ ids: string[] }, { unarchived: number }>('bulkUnarchiveNotifications', {
    ids,
  });
  return res.unarchived;
}
