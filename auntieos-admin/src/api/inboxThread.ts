import { call } from '../lib/fns';

/**
 * One message in a kinfolk<->auntie conversation, as returned by the
 * `getConversationThread` admin callable. Mirrors the backend `ThreadMessage`
 * (MyTribe lib/conversations.ts) field-for-field. `createdAtMs` / `readAt` are
 * epoch ms (LOCAL-formatted in the UI, AO-18), not Timestamps: this thread is a
 * one-shot callable read, not a Firestore stream.
 */
export interface ThreadMessage {
  id: string;
  senderRole: string; // 'kinfolk' | 'auntie'
  senderUid: string;
  body: string;
  createdAtMs: number;
  readAt: number | null;
}

/**
 * getConversationThread (admin) -> one household's messages, oldest-first as the
 * backend returns them. READING THE THREAD CLEARS THE ADMIN UNREAD flag +
 * stamps readAt server-side (markMessagesRead), so opening a thread is itself
 * the "mark read" action; the Inbox list's `unreadForAdmin` flips on its next
 * load. No client write needed for that.
 */
export async function getConversationThread(kinfolkId: string): Promise<ThreadMessage[]> {
  const res = await call<{ kinfolkId: string }, { ok: true; kinfolkId: string; messages: ThreadMessage[] }>(
    'getConversationThread',
    { kinfolkId },
  );
  return res.messages ?? [];
}

/**
 * replyToConversation (admin) -> appends an auntie message to the thread
 * (creating it if needed) and returns the new message id. Reaches a REAL
 * household, so the caller gates it behind an explicit Send action and surfaces
 * any rejection fail-loud. Server arg is `{ kinfolkId, body }`.
 */
export async function replyToConversation(kinfolkId: string, body: string): Promise<string> {
  const res = await call<{ kinfolkId: string; body: string }, { ok: true; kinfolkId: string; messageId: string }>(
    'replyToConversation',
    { kinfolkId, body },
  );
  return res.messageId;
}

/**
 * markAllThreadsRead (admin) -> clears the admin-side unread flag on EVERY
 * thread waiting on a reply, and stamps `readAt` on their kinfolk messages the
 * same way opening a thread does. Returns the number of threads it ACTUALLY
 * cleared, which is the only number the screen may report.
 *
 * Takes no arguments: the server rejects any payload rather than quietly
 * ignoring one, so a caller cannot think it scoped the clear to one household.
 *
 * `cleared` can be smaller than the badge if the backlog exceeds the server's
 * per-call bound (200 threads). The caller reloads afterwards, so the badge
 * still shows what is genuinely left rather than an assumed zero.
 */
export async function markAllThreadsRead(): Promise<{ cleared: number }> {
  const res = await call<Record<string, never>, { ok: true; cleared: number }>(
    'markAllThreadsRead',
    {},
  );
  return { cleared: res.cleared };
}
