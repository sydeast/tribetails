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
 * markNotificationRead.ts, archiveNotification.ts), NOT ISO strings. The
 * Kotlin client normalizes them to ISO via a custom serializer at decode time;
 * the plain Firebase JS SDK used here hands back a real Firestore `Timestamp`
 * (or `null` while a serverTimestamp() write is still pending locally), so
 * this type says so rather than pretending it is already a string. Format via
 * `formatWhen` below, never `String(ts)`.
 *
 * `readAt` is cleared with `FieldValue.delete()` on unread (not blanked to
 * `''` as the wasm model's string field is), so on the wire it is simply
 * ABSENT, hence optional here rather than a blank-string sentinel.
 *
 * EVERY document-sourced field below is optional, including ones dispatcher.ts
 * always writes today. This interface is a CAST over raw Firestore data, not a
 * validation of it: nothing checks a document actually has `channels` before
 * TypeScript promises `string[]`, and `.length` on an absent field throws,
 * which React's error boundary turns into a blank Notifications page over one
 * legacy or hand-seeded row. Read them through `str`/`arr` (lib/coerce) or a
 * `??`/`||` fallback at the point of use. `_id` stays required, `useCollection`
 * sets it from the document id, so it is never absent.
 */
export interface NotificationEntry {
  _id: string;
  key?: string | undefined; // catalog key, e.g. 'kincare.booking.confirm'
  category?: string | undefined;
  recipientUid?: string | undefined;
  actorUid?: string | null;
  // AO-28: human-renderable content written by dispatcher.ts (title = catalog
  // `label`, description = catalog `description`) + the resolved actor identity.
  // Optional: notifications dispatched BEFORE this landed have neither, so the
  // UI falls back to `key` for the title and hides an absent actor.
  title?: string;
  description?: string;
  actorName?: string | null;
  actorPhotoUrl?: string | null;
  status?: string | undefined; // pending | dispatched
  mode?: string | undefined; // trigger | debounced | batched | scheduled
  channels?: string[] | undefined;
  createdAt?: Timestamp | null | undefined;
  readAt?: Timestamp;
  targetType?: string | undefined; // '' | 'booking' | 'invoice' | 'kintale' | 'kinfolk'
  targetId?: string | undefined;
  /**
   * The emitter's free-form merge bag, written verbatim by dispatcher.ts as
   * `data: args.data`. Typed `unknown` on purpose: it is whatever the calling
   * function passed to `enqueueNotification`, with no schema, so declaring
   * `Record<string, string>` here would be a promise nothing keeps. Read it
   * through `lib/coerce`'s `rec`/`str`, which `lib/notificationContext.ts`
   * does to pull the household reference out of it.
   */
  data?: unknown;
  /**
   * Set by `archiveNotification`, CLEARED TO NULL (not deleted) by
   * `unarchiveNotification`. So three shapes reach a client and only the first
   * means archived:
   *
   *   a real Timestamp   filed away
   *   null               archived once, then restored
   *   absent             never archived
   *
   * Which is why nothing reads this field directly: `isNotificationArchived` in
   * lib/notificationsFeed.ts is the single predicate, and it folds the last two
   * together. A `=== undefined` test would hide every restored row forever with
   * no error to notice.
   */
  archivedAt?: Timestamp | null;
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
 * collection read, exactly what `platformNotificationsStream()` does in
 * FirestoreInterop.*.kt (a plain `collectionStream("notifications")`, no
 * recipientUid where-clause). Adding `['recipientUid', '==', uid]` here would
 * under-scope the admin's own inbox relative to the wasm original. Because
 * there is no `where` combined with the `orderBy`, this query needs NO
 * composite index, a single-field orderBy is always covered by Firestore's
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
 * bulkMarkNotificationsRead. Returns the number ACTUALLY marked, ids that are
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

// Timestamp formatting is centralized + LOCAL (AO-18) in lib/time, re-exported
// so `import { formatWhen, dayKey } from '../api/notifications'` keeps working.
export { formatWhen, dayKey, machineWhen } from '../lib/time';
