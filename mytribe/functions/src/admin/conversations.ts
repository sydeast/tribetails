import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';
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
  MAX_MESSAGE_BODY,
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
  body: z.string().min(1).max(MAX_MESSAGE_BODY),
});

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

  return { ok: true, kinfolkId: args.kinfolkId, messageId };
}

export const replyToConversation = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('replyToConversation', replyToConversationHandler),
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
