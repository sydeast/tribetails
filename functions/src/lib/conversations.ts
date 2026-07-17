import { FieldValue } from 'firebase-admin/firestore';
import { db } from './firestoreAdmin';
import { sanitizeRichText, toPlainTextPreview } from './richText';

/**
 * Stage 2 step 7 (Inbox conversations / Message Auntie 16.4). Two-way threads
 * between a kinfolk household and the auntie (admin).
 *
 * Model:
 *   conversations/{kinfolkId}                       one canonical thread per household
 *     - kinfolkId, kinfolkName, memberUids[]        memberUids = the kinfolk's MyTribe
 *                                                    auth uids (admins read via isAuntie()
 *                                                    so they are not listed here)
 *     - lastMessagePreview, lastMessageAtMs, lastSenderRole
 *     - unreadForAdmin, unreadForKinfolk            drive the per-side unread badges
 *     - messageCount, createdAt, updatedAt
 *   conversations/{kinfolkId}/messages/{auto}
 *     - senderRole 'kinfolk'|'auntie', senderUid, body, createdAtMs, createdAt
 *     - deliveredAt, readAt (ms, null until read)  a direct Firestore write is
 *       delivered synchronously with creation (no separate transport hop like
 *       email/SMS has), so deliveredAt == createdAtMs; readAt is the real
 *       per-message state markMessagesRead/markThreadRead advance.
 *
 * Reads are admin-gated (listConversations / getConversationThread) or
 * portal-scoped (getMyConversation); writes go only through the callables
 * (sendKinfolkMessage / replyToConversation), never direct client writes.
 */

export const CONVERSATIONS_COLLECTION = 'conversations';
export const MESSAGES_SUBCOLLECTION = 'messages';
export const MAX_MESSAGE_BODY = 5000;
export const PREVIEW_MAX = 140;

export type SenderRole = 'kinfolk' | 'auntie';

/** Single-line preview for the thread list. Pure. Strips any markup, collapses whitespace + truncates. */
export function previewOf(body: string): string {
  const oneLine = toPlainTextPreview(body, Number.MAX_SAFE_INTEGER).replace(/\s+/g, ' ').trim();
  return oneLine.length <= PREVIEW_MAX ? oneLine : `${oneLine.slice(0, PREVIEW_MAX - 1)}…`;
}

export interface AppendMessageArgs {
  kinfolkId: string;
  kinfolkName: string;
  senderRole: SenderRole;
  senderUid: string;
  body: string;
  /** When the sender is the kinfolk, their auth uid is recorded as a thread member. */
  memberUid?: string;
}

/**
 * Appends a message to a conversation and refreshes the thread summary in a
 * single transaction so the message and the lastMessage/unread fields can never
 * diverge. Creates the conversation doc on first message. Sets the OTHER side's
 * unread flag true and the sender's side false. Returns the new message id.
 */
export async function appendMessage(args: AppendMessageArgs): Promise<string> {
  const { kinfolkId, kinfolkName, senderRole, senderUid, memberUid } = args;
  // Re-cap post-sanitize: the allowed tag subset can grow a body past the
  // raw-input MAX_MESSAGE_BODY check the callables already ran (rare, but a
  // sanitizer's job is to never trust its own output length either).
  const body = sanitizeRichText(args.body).slice(0, MAX_MESSAGE_BODY);
  const now = Date.now();
  const convRef = db().collection(CONVERSATIONS_COLLECTION).doc(kinfolkId);
  const msgRef = convRef.collection(MESSAGES_SUBCOLLECTION).doc();

  await db().runTransaction(async (tx) => {
    const snap = await tx.get(convRef);
    const exists = snap.exists;
    const prevCount = exists ? ((snap.data()?.messageCount as number | undefined) ?? 0) : 0;

    tx.set(msgRef, {
      senderRole,
      senderUid,
      body,
      createdAtMs: now,
      createdAt: FieldValue.serverTimestamp(),
      deliveredAt: now,
      readAt: null,
    });

    const summary: Record<string, unknown> = {
      kinfolkId,
      kinfolkName,
      lastMessagePreview: previewOf(body),
      lastMessageAtMs: now,
      lastSenderRole: senderRole,
      messageCount: prevCount + 1,
      // The recipient side now has something unread; the sender's side is current.
      unreadForAdmin: senderRole === 'kinfolk',
      unreadForKinfolk: senderRole === 'auntie',
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (!exists) {
      summary.createdAt = FieldValue.serverTimestamp();
      summary.memberUids = memberUid ? [memberUid] : [];
    } else if (memberUid) {
      summary.memberUids = FieldValue.arrayUnion(memberUid);
    }
    tx.set(convRef, summary, { merge: true });
  });

  return msgRef.id;
}

export interface ThreadMessage {
  id: string;
  senderRole: SenderRole;
  senderUid: string;
  body: string;
  createdAtMs: number;
  deliveredAt: number | null;
  readAt: number | null;
}

/**
 * Reads a conversation's messages oldest-first (chronological thread order).
 * Bounds the read at the DB layer: fetches the most recent [limit] messages via
 * orderBy(createdAtMs desc).limit(limit) so a long thread never loads the whole
 * subcollection into memory, then reverses to ascending for display.
 */
export async function readThread(kinfolkId: string, limit = 200): Promise<ThreadMessage[]> {
  const snap = await db()
    .collection(CONVERSATIONS_COLLECTION)
    .doc(kinfolkId)
    .collection(MESSAGES_SUBCOLLECTION)
    .orderBy('createdAtMs', 'desc')
    .limit(limit)
    .get();
  const msgs: ThreadMessage[] = snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    return {
      id: d.id,
      senderRole: (data.senderRole as SenderRole) ?? 'kinfolk',
      senderUid: typeof data.senderUid === 'string' ? data.senderUid : '',
      body: typeof data.body === 'string' ? data.body : '',
      createdAtMs: typeof data.createdAtMs === 'number' ? data.createdAtMs : 0,
      deliveredAt: typeof data.deliveredAt === 'number' ? data.deliveredAt : null,
      readAt: typeof data.readAt === 'number' ? data.readAt : null,
    };
  });
  // Re-sort ascending (the query returned newest-first for the limit window).
  msgs.sort((a, b) => a.createdAtMs - b.createdAtMs);
  return msgs;
}

/**
 * Marks every unread message from the OTHER side as read (readAt = now) and
 * clears the reader's own unread flag on the thread summary. Idempotent —
 * safe to call on every thread view, not just once. Bounded to the most
 * recent 500 unread messages so a huge backlog can't blow up a single write
 * batch (Firestore's hard cap is 500 writes/batch).
 */
export async function markMessagesRead(kinfolkId: string, readerRole: SenderRole): Promise<number> {
  const convRef = db().collection(CONVERSATIONS_COLLECTION).doc(kinfolkId);
  const senderRoleBeingRead: SenderRole = readerRole === 'kinfolk' ? 'auntie' : 'kinfolk';
  const unreadFlag = readerRole === 'kinfolk' ? 'unreadForKinfolk' : 'unreadForAdmin';

  const unreadSnap = await convRef
    .collection(MESSAGES_SUBCOLLECTION)
    .where('senderRole', '==', senderRoleBeingRead)
    .where('readAt', '==', null)
    .limit(500)
    .get();

  if (unreadSnap.docs.length === 0) {
    // Still clear a stale unread flag even if every message already has a
    // readAt (e.g. a flag left over from before this field existed).
    const convSnap = await convRef.get();
    if (convSnap.exists && convSnap.data()?.[unreadFlag] === true) {
      await convRef.set({ [unreadFlag]: false, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    }
    return 0;
  }

  const now = Date.now();
  const batch = db().batch();
  for (const doc of unreadSnap.docs) {
    batch.update(doc.ref, { readAt: now });
  }
  batch.set(convRef, { [unreadFlag]: false, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  await batch.commit();
  return unreadSnap.docs.length;
}
