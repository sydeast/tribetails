import { call } from '../lib/fns';
import { type CollectionSpec } from '../lib/firestore';
import type { Timestamp } from 'firebase/firestore';

/**
 * One `notifications` row (mirrors the wasm `NotificationEntry` in
 * FirestoreClient.kt). Catalog-dispatched notifications written by MyTribe
 * Cloud Functions' notification subsystem (dispatcher.ts); clients never write
 * this collection directly.
 *
 * `createdAt` / `readAt` / `archivedAt` are written server-side as
 * `FieldValue.serverTimestamp()` (confirmed against dispatcher.ts,
 * markNotificationRead.ts, archiveNotification.ts) — NOT ISO strings. The
 * Kotlin client normalizes them to ISO via a custom serializer at decode time;
 * the plain Firebase JS SDK used here hands back a real Firestore `Timestamp`
 * (or `null` while a serverTimestamp() write is still pending locally), so
 * this type says so rather than pretending it is already a string. Format via
 * `formatWhen` below, never `String(ts)`.
 *
 * `readAt` is cleared with `FieldValue.delete()` on unread (not blanked to
 * `''` as the wasm model's string field is), so on the wire it is simply
 * ABSENT, hence optional here rather than a blank-string sentinel.
 */
export interface NotificationEntry {
  _id: string;
  key: string; // catalog key, e.g. 'kincare.booking.confirm'
  category: string;
  recipientUid: string;
  actorUid?: string | null;
  status: string; // pending | dispatched
  mode: string; // trigger | debounced | batched | scheduled
  channels: string[];
  createdAt: Timestamp | null;
  readAt?: Timestamp;
  targetType: string; // '' | 'booking' | 'invoice' | 'kintale' | 'kinfolk'
  targetId: string;
  archivedAt?: Timestamp;
}

/** True once the recipient (or an admin) has marked this notification read. */
export function isRead(entry: NotificationEntry): boolean {
  return entry.readAt !== undefined;
}

/**
 * The bounded, server-ordered notifications listener. Ordered by `createdAt`
 * descending, capped at 200 (the same cap ActivityLog uses for its stream).
 *
 * NO `filters` here, and that is a deliberate read of firestore.rules
 * (web/firestore.rules:497-506), not an omission:
 *
 *   match /notifications/{id} {
 *     // AuntieOS admin console lists the whole collection (unfiltered listen);
 *     // kinfolk (MyTribe) may still read only their own dispatches.
 *     allow read: if isAuntie()
 *                 || (signedIn() && resource.data.recipientUid == request.auth.uid)
 *                 || (isTestAdmin() && resource.data.recipientUid == request.auth.uid);
 *   }
 *
 * The admin console runs as `isAuntie()`, which already grants an unfiltered
 * collection read — exactly what `platformNotificationsStream()` does in
 * FirestoreInterop.*.kt (a plain `collectionStream("notifications")`, no
 * recipientUid where-clause). Adding `['recipientUid', '==', uid]` here would
 * under-scope the admin's own inbox relative to the wasm original. Because
 * there is no `where` combined with the `orderBy`, this query needs NO
 * composite index — a single-field orderBy is always covered by Firestore's
 * automatic single-field indexes.
 */
export const NOTIFICATIONS_QUERY: CollectionSpec = {
  path: 'notifications',
  order: ['createdAt', 'desc'],
  max: 200,
};

/**
 * markNotificationRead (recipient-or-admin gated server-side; an admin uid
 * bypasses the recipient check per markNotificationRead.ts). Stamps `readAt`
 * server-side. Server arg key is `notificationId`.
 */
export async function markNotificationRead(notificationId: string): Promise<void> {
  await call<{ notificationId: string }, { ok: true }>('markNotificationRead', { notificationId });
}

/** markNotificationUnread (inverse of markNotificationRead; clears `readAt`). */
export async function markNotificationUnread(notificationId: string): Promise<void> {
  await call<{ notificationId: string }, { ok: true }>('markNotificationUnread', { notificationId });
}

/**
 * bulkMarkNotificationsRead. Returns the number ACTUALLY marked — ids that are
 * missing, not owned (for a non-admin caller), or lack a `recipientUid` are
 * silently skipped server-side rather than erroring the whole batch, so this
 * count can be smaller than `ids.length` even on success.
 */
export async function bulkMarkNotificationsRead(ids: string[]): Promise<number> {
  const res = await call<{ ids: string[] }, { ok: true; marked: number }>('bulkMarkNotificationsRead', {
    ids,
  });
  return res.marked;
}

/**
 * Render a Firestore Timestamp the way the wasm screen's `relativeTime` does:
 * the real date/time, never a fabricated "2m ago" delta the client cannot
 * compute honestly without its own clock being trusted. `null` covers a
 * serverTimestamp() write whose value has not round-tripped from the server
 * yet (the SDK reports the field as `null` in that brief local-pending window).
 */
export function formatWhen(ts: Timestamp | null | undefined): string {
  if (!ts) return '(no time)';
  const iso = ts.toDate().toISOString(); // e.g. 2026-07-16T14:02:11.000Z
  const t = iso.indexOf('T');
  if (t <= 0) return iso.slice(0, 16);
  const datePart = iso.slice(0, t);
  const timePart = iso.slice(t + 1, t + 6);
  const shortDate = datePart.length >= 10 ? datePart.slice(5) : datePart;
  return `${shortDate} ${timePart}`;
}

/** YYYY-MM-DD day key for grouping, or 'Undated' when createdAt hasn't landed yet. */
export function dayKey(ts: Timestamp | null | undefined): string {
  if (!ts) return 'Undated';
  return ts.toDate().toISOString().slice(0, 10);
}
