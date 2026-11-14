import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import {
  appendMessage,
  readThread,
  markMessagesRead,
  MAX_MESSAGE_HTML,
  CONVERSATIONS_COLLECTION,
  type ThreadMessage,
} from '../lib/conversations';

/**
 * Stage 2 step 7 (Inbox conversations 16.4) - auntie/admin side. All admin-gated
 * (wrapAdminCallable), so a test-admin (no admin claim) cannot read or write the
 * real kinfolk threads.
 *
 *   listConversations    -> thread list for the AuntieOS Inbox (newest first)
 *   getConversationThread -> one thread's messages (and clears the admin unread)
 *   replyToConversation  -> auntie replies (creates the thread if needed)
 *   markConversationRead -> clears the admin-side unread flag + stamps readAt
 *   markConversationUnread -> puts the admin-side unread flag back (#1611)
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

export async function listConversationsHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; conversations: ConversationSummary[] }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const snap = await db().collection(CONVERSATIONS_COLLECTION).get();
  const conversations: ConversationSummary[] = snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    return {
      kinfolkId: d.id,
      kinfolkName: typeof data.kinfolkName === 'string' ? data.kinfolkName : d.id,
      lastMessagePreview: typeof data.lastMessagePreview === 'string' ? data.lastMessagePreview : '',
      lastMessageAtMs: typeof data.lastMessageAtMs === 'number' ? data.lastMessageAtMs : 0,
      lastSenderRole: typeof data.lastSenderRole === 'string' ? data.lastSenderRole : '',
      unreadForAdmin: data.unreadForAdmin === true,
      messageCount: typeof data.messageCount === 'number' ? data.messageCount : 0,
    };
  });
  conversations.sort((a, b) => b.lastMessageAtMs - a.lastMessageAtMs);

  return { ok: true, conversations };
}

export const listConversations = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('listConversations', listConversationsHandler),
);

// ---------------------------------------------------------------------------

const ThreadArgs = z.object({ kinfolkId: z.string().min(1).max(200) });

export async function getConversationThreadHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; kinfolkId: string; messages: ThreadMessage[] }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof ThreadArgs>;
  try {
    args = ThreadArgs.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'getConversationThread validation failed');
    }
    throw err;
  }

  const messages = await readThread(args.kinfolkId);
  // Reading clears the admin-side unread flag and stamps readAt on every
  // unread kinfolk message (no-ops cleanly if the thread doesn't exist yet).
  await markMessagesRead(args.kinfolkId, 'auntie');

  return { ok: true, kinfolkId: args.kinfolkId, messages };
}

export const getConversationThread = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('getConversationThread', getConversationThreadHandler),
);

// ---------------------------------------------------------------------------

const ReplyArgs = z.object({
  kinfolkId: z.string().min(1).max(200),
  body: z.string().min(1).max(MAX_MESSAGE_HTML),
});

/**
 * #1874: tell the household the office replied. Before this a reply showed on
 * the portal Messages page and nowhere else: no row on the notifications list,
 * no bell count, nothing on their channels.
 *
 * Sent from the server, after the message is written, never from the client.
 * Every admin client (web, Android, desktop) replies through this callable, so
 * this one place covers all three. The household send gate, the operator's
 * channel switches and the household's own preferences all apply inside the
 * dispatcher. One notice per reply: `dedupeKey` is the message id, so a second
 * reply a minute later is a second notice, and a retry of this one is not.
 *
 * Best-effort: the reply is already in the thread, and a notice that cannot be
 * sent must not fail it or offer a retry that would post it twice.
 */
async function notifyHouseholdOfReply(args: {
  kinfolkId: string;
  kinfolkName: string;
  messageId: string;
  body: string;
  uid: string;
}): Promise<void> {
  try {
    const [{ resolveKinfolkUid }, { enqueueNotificationDetailed }, { messagePreview }] = await Promise.all([
      import('../lib/resolveKinfolkUid.js'),
      import('../notifications/dispatcher.js'),
      import('../lib/richText.js'),
    ]);
    const recipientUid = await resolveKinfolkUid(args.kinfolkId);
    if (!recipientUid) {
      logEvent({
        severity: 'info',
        function: 'replyToConversation',
        event: 'reply.notice.skipped',
        uid: args.uid,
        extra: { kinfolkId: args.kinfolkId, reason: 'household_has_no_portal_account' },
      });
      return;
    }
    await enqueueNotificationDetailed({
      key: 'message.reply',
      recipientUid,
      data: {
        kinfolkId: args.kinfolkId,
        kinfolkName: args.kinfolkName,
        messageId: args.messageId,
        preview: messagePreview(args.body, 200),
      },
      actorUid: args.uid,
      targetType: 'conversation',
      targetId: args.kinfolkId,
      dedupeKey: `message:${args.messageId}`,
    });
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'replyToConversation',
      event: 'notification.dispatch.failed',
      uid: args.uid,
      errorMessage: (err as Error)?.message,
    });
  }
}

export async function replyToConversationHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; kinfolkId: string; messageId: string }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof ReplyArgs>;
  try {
    args = ReplyArgs.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'replyToConversation validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  // Resolve the household name (from an existing thread, else the kinfolk doc).
  const convSnap = await db().collection(CONVERSATIONS_COLLECTION).doc(args.kinfolkId).get();
  let kinfolkName = (convSnap.data()?.kinfolkName as string | undefined) ?? '';
  if (!kinfolkName) {
    const kinSnap = await db().collection('kinfolk').doc(args.kinfolkId).get();
    const data = kinSnap.data() as Record<string, unknown> | undefined;
    const first = typeof data?.firstName === 'string' ? data.firstName : '';
    const last = typeof data?.lastName === 'string' ? data.lastName : '';
    kinfolkName = `${first} ${last}`.trim() || args.kinfolkId;
  }

  const messageId = await appendMessage({
    kinfolkId: args.kinfolkId,
    kinfolkName,
    senderRole: 'auntie',
    senderUid: uid,
    body: args.body,
  });

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.CONVERSATION_REPLIED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetCollection: `${CONVERSATIONS_COLLECTION}/${args.kinfolkId}`,
    description: `Auntie replied to ${kinfolkName}`,
    payload: { kinfolkId: args.kinfolkId, messageId, senderRole: 'auntie' },
  }).catch((err) => {
    logEvent({ severity: 'warn', function: 'replyToConversation', event: 'audit.write.failed', uid, errorMessage: (err as Error)?.message });
  });

  await notifyHouseholdOfReply({ kinfolkId: args.kinfolkId, kinfolkName, messageId, body: args.body, uid });

  return { ok: true, kinfolkId: args.kinfolkId, messageId };
}

export const replyToConversation = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('replyToConversation', replyToConversationHandler),
);
/**
 * #2061: the push an approved Communicate Push draft sends to one household.
 * The handler, its gate and its settings checks live in
 * `admin/sendHouseholdPush.ts`, loaded here only when the call arrives.
 */
export const sendHouseholdPush = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('sendHouseholdPush', async (req: CallableRequest<unknown>) => {
    const { sendHouseholdPushHandler } = await import('./sendHouseholdPush.js');
    return sendHouseholdPushHandler(req);
  }),
);

// ---------------------------------------------------------------------------

const MarkArgs = z.object({ kinfolkId: z.string().min(1).max(200) });

export async function markConversationReadHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; kinfolkId: string }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof MarkArgs>;
  try {
    args = MarkArgs.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'markConversationRead validation failed');
    }
    throw err;
  }

  const convRef = db().collection(CONVERSATIONS_COLLECTION).doc(args.kinfolkId);
  const snap = await convRef.get();
  if (!snap.exists) {
    throw new HttpsError('not-found', `Conversation ${args.kinfolkId} does not exist.`);
  }
  await markMessagesRead(args.kinfolkId, 'auntie');

  return { ok: true, kinfolkId: args.kinfolkId };
}

export const markConversationRead = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('markConversationRead', markConversationReadHandler),
);

// ---------------------------------------------------------------------------
/**
 * markConversationUnread (#1611): the operator read a thread and wants it back
 * in the unread pile, the way a mail client's "Mark unread" works.
 *
 * Only the admin-side flag moves. The messages keep their `readAt` stamps: the
 * household may already have seen "Read" on them, and un-reading a message the
 * operator did read would put a false receipt in front of them. Nothing in the
 * admin's list reads those stamps; the list, the badge and the Unread chip all
 * read `unreadForAdmin`.
 *
 * Who spoke last is not touched either, so a thread the household is waiting on
 * stays under "Waiting on a reply" (#1572) whatever this flag says.
 */
export async function markConversationUnreadHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; kinfolkId: string }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  let args: z.infer<typeof MarkArgs>;
  try {
    args = MarkArgs.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'markConversationUnread validation failed');
    }
    throw err;
  }
  const convRef = db().collection(CONVERSATIONS_COLLECTION).doc(args.kinfolkId);
  const snap = await convRef.get();
  if (!snap.exists) {
    throw new HttpsError('not-found', `Conversation ${args.kinfolkId} does not exist.`);
  }
  await convRef.set({ unreadForAdmin: true, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { ok: true, kinfolkId: args.kinfolkId };
}
export const markConversationUnread = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('markConversationUnread', markConversationUnreadHandler),
);
