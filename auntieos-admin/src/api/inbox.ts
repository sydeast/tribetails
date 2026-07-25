import { call } from '../lib/fns';
import { type CollectionSpec } from '../lib/firestore';

/**
 * One `conversations/{kinfolkId}` thread summary, as returned by the
 * `listConversations` admin callable (MyTribe/functions/src/admin/
 * conversations.ts, confirmed live and deployed; see `listConversationsHandler`
 * + MyTribe/functions/src/lib/conversations.ts for the underlying
 * `conversations` collection model). Mirrors the wasm `ConversationSummary`
 * (screens/inbox/InboxScreen.kt's `decodeConversations`) field-for-field.
 *
 * ── ONE-SHOT, not a stream ──────────────────────────────────────────────
 * The Compose reference itself reads this the same way: `FirestoreClient.
 * listConversations()` calls `platformInvokeCallable("listConversations", ...)`,
 * NOT a Firestore listener (contrast `voicemailsStream()`/`callsStream()`/
 * `smsStream()`/`emailsStream()`/`notificationsStream()` in the same file,
 * which ARE listeners). `conversations` has no live-authoring collaborator to
 * watch for (unlike `notifications`, which MyTribe functions dispatch to in
 * real time while the admin has the tab open), so this goes through
 * `lib/fns.call` like `formSchemas.ts`/`templates.ts`, not `lib/firestore.ts`'s
 * `useCollection`.
 *
 * The backend read itself has no Firestore-level `orderBy`/`limit`
 * (`listConversationsHandler` does an unbounded `.collection(CONVERSATIONS_
 * COLLECTION).get()`, then sorts the results in memory by `lastMessageAtMs`
 * descending before returning). That would be the AO-29 bug on a live
 * LISTENER reading an unbounded, ever-growing collection; it is not the same
 * risk here because this collection has exactly one row per household thread
 * (not one row per message), so its size is bounded by household count, the
 * same shape `formSchemas`/`templates` already read this way as a one-shot
 * summary list.
 *
 * `lastMessageAtMs` is a plain epoch-ms NUMBER (`Date.now()`, see
 * `lib/conversations.ts#appendMessage`), not a Firestore Timestamp and not an
 * ISO string; format it via `lib/inboxFormat.ts`'s `threadDayKey`/
 * `threadClock`, never a raw `new Date(ms).toISOString().slice(0, 10)`.
 */
export interface ConversationSummary {
  kinfolkId: string;
  kinfolkName: string;
  lastMessagePreview: string;
  lastMessageAtMs: number;
  lastSenderRole: string;
  unreadForAdmin: boolean;
  messageCount: number;
}

/**
 * `listConversations` (admin-gated via `wrapAdminCallable`): the Inbox thread
 * list, newest-first (the server already sorts by `lastMessageAtMs` desc).
 * Throws (via `lib/fns.call`) on auth/network failure; the screen surfaces it
 * fail-loud rather than swallowing it.
 */
export async function listConversations(): Promise<ConversationSummary[]> {
  const res = await call<Record<string, never>, { conversations: ConversationSummary[] }>(
    'listConversations',
    {},
  );
  return res.conversations ?? [];
}

/**
 * One `conversations/{kinfolkId}` document as the CLIENT sees it, for the
 * nav rail's unread badge (`lib/useUnreadInbox.ts`).
 *
 * Only the field the badge counts is declared. This is not a second, competing
 * model of a thread: `ConversationSummary` above stays the shape of the
 * `listConversations` response and the Inbox screen's row, and anything that
 * needs a thread's content still goes through the callable.
 *
 * `unreadForAdmin` is a STORED boolean, not something the callable derives:
 * `appendMessage` writes `unreadForAdmin: senderRole === 'kinfolk'` and
 * `markThreadRead` clears it (mytribe/functions/src/lib/conversations.ts:91,158),
 * and the callable just passes it through (admin/conversations.ts:56). So a
 * client read counts the same flag the screen does, with no logic duplicated on
 * this side to drift.
 */
export interface ConversationDoc {
  unreadForAdmin: boolean;
}

/**
 * The bounded listener behind the rail's Inbox count. Ordered by
 * `lastMessageAtMs` descending (the field `appendMessage` stamps, and the same
 * order `listConversationsHandler` sorts by in memory), capped at 200, the cap
 * NOTIFICATIONS_QUERY already uses.
 *
 * WHY A LISTENER when the module above argues for a callable. The two answers
 * are for two different questions. The Inbox SCREEN wants a thread list, once,
 * when you open it, and `listConversations` is right for that. The RAIL is on
 * every screen and outlives every navigation, and a one-shot count would be
 * wrong within seconds of being right: reading a thread clears `unreadForAdmin`
 * server-side, which is why `Inbox.tsx` reloads its own list on the way back
 * from a thread. A snapshot taken at page load would sit in the corner of every
 * screen claiming four unread after the operator had read all four. This
 * listener drops to three, two, one, zero on its own, with no further read and
 * no refresh plumbing between the two components.
 *
 * NO `filters`, so no composite index: a single-field `orderBy` is covered by
 * Firestore's automatic indexes, and `where('unreadForAdmin','==',true)`
 * combined with this order would need one deployed. The unread count is taken
 * from the returned rows (`lib/inboxFormat.ts#unreadThreadCount`), which is
 * also what the Inbox screen does with the callable's rows.
 *
 * PERMISSION, and the reason no filter is needed for scoping either:
 * `mytribe/firestore.rules:798` is
 * `allow read: if isAuntie() || (isKinfolk() && kinfolkId == request.auth.token.kinfolkId)`.
 * A real operator holds `isAuntie` and may read the whole collection, the same
 * grant `notifications` relies on. A Stage-0I test admin holds neither claim, so
 * this read is DENIED for a sandbox account, the badge does not render, and the
 * rail is otherwise untouched (see useUnreadInbox for what that degradation
 * deliberately does and does not do).
 */
export const CONVERSATIONS_QUERY: CollectionSpec = {
  path: 'conversations',
  order: ['lastMessageAtMs', 'desc'],
  max: 200,
};
