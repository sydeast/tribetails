import { collection, onSnapshot, orderBy, query } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { firestore } from './firebase';
import type { SenderRole, ThreadMessageDto } from '../api/messagesApi';

/**
 * Realtime conversation messages for one household, ported from
 * subscribeBreadcrumbs's pattern (breadcrumbs.ts) — same shape (a plain
 * subscribe function + a React hook wrapper), applied to
 * `conversations/{kinfolkId}/messages` instead of a session's breadcrumbs.
 * Read-only: writes only ever go through sendKinfolkMessage; firestore.rules
 * gate reads to the kinfolk's own thread (same claim breadcrumbs.ts relies
 * on). Unlike breadcrumbs.ts's un-ordered query, this one CAN use `orderBy`
 * server-side — createdAtMs is already indexed for readThread's admin-side
 * query (functions/src/lib/conversations.ts), and a plain single-field
 * orderBy on a subcollection needs no composite index.
 */
export function subscribeConversation(
  kinfolkId: string,
  onUpdate: (messages: ThreadMessageDto[]) => void,
): () => void {
  const ref = collection(firestore, 'conversations', kinfolkId, 'messages');
  const q = query(ref, orderBy('createdAtMs', 'asc'));
  return onSnapshot(
    q,
    (snapshot) => {
      const messages: ThreadMessageDto[] = snapshot.docs.map((doc) => {
        const data = doc.data() as Record<string, unknown>;
        const senderRole: SenderRole = data.senderRole === 'auntie' ? 'auntie' : 'kinfolk';
        return {
          id: doc.id,
          senderRole,
          senderUid: typeof data.senderUid === 'string' ? data.senderUid : '',
          body: typeof data.body === 'string' ? data.body : '',
          createdAtMs: typeof data.createdAtMs === 'number' ? data.createdAtMs : 0,
          deliveredAt: typeof data.deliveredAt === 'number' ? data.deliveredAt : null,
          readAt: typeof data.readAt === 'number' ? data.readAt : null,
        };
      });
      onUpdate(messages);
    },
    (err) => {
      // Best-effort: a listener failure (permission hiccup, offline) never
      // breaks the screen — getMyConversation's query result stays the
      // fallback data source. See Messages.tsx.
      console.warn('[messagesListener] onSnapshot error:', err);
    },
  );
}

/**
 * React hook wrapper: live message list for `kinfolkId`, null until the
 * first snapshot arrives (or if kinfolkId is null) so callers can tell
 * "not subscribed yet" apart from "subscribed, thread is empty".
 */
export function useConversationMessages(kinfolkId: string | null): ThreadMessageDto[] | null {
  const [messages, setMessages] = useState<ThreadMessageDto[] | null>(null);

  useEffect(() => {
    if (!kinfolkId) {
      setMessages(null);
      return;
    }
    setMessages(null);
    return subscribeConversation(kinfolkId, setMessages);
  }, [kinfolkId]);

  return messages;
}
