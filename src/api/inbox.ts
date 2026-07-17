import { call } from '../lib/fns';

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
