import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { requireKinfolkPerm } from '../lib/memberGate';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { enqueueNotification } from '../notifications/dispatcher';
import { TRIBETAILS_CORS } from '../lib/cors';
import { resolveKinfolkAccess } from '../lib/resolveKinfolkAccess';
import { sanitizeRichText, toPlainTextPreview } from '../lib/richText';
import {
  appendMessage,
  readThread,
  markMessagesRead,
  MAX_MESSAGE_BODY,
  MESSAGES_SUBCOLLECTION,
  CONVERSATIONS_COLLECTION,
  type ThreadMessage,
} from '../lib/conversations';

/**
 * Server-side chat policy from `business_settings/business_settings.mytribePortal.chat`
 * (§8). Client checks are UX-only; these are the authoritative gate. Every field
 * is defaulted so a settings doc without `mytribePortal.chat` behaves exactly as
 * before this validation existed (enabled, 2000-char cap, no rate limit).
 */
interface ChatPolicy {
  enabled: boolean;
  maxMessageLength: number;
  rateLimitPerHour: number;
}

async function loadChatPolicy(): Promise<ChatPolicy> {
  const snap = await db().collection('business_settings').doc('business_settings').get();
  const settings = (snap.data() ?? {}) as Record<string, unknown>;
  const mt = (typeof settings['mytribePortal'] === 'object' && settings['mytribePortal'] !== null
    ? (settings['mytribePortal'] as Record<string, unknown>)
    : {});
  const chat = (typeof mt['chat'] === 'object' && mt['chat'] !== null
    ? (mt['chat'] as Record<string, unknown>)
    : {});
  return {
    enabled: typeof chat['enabled'] === 'boolean' ? (chat['enabled'] as boolean) : true,
    maxMessageLength: typeof chat['maxMessageLength'] === 'number' ? (chat['maxMessageLength'] as number) : 2000,
    rateLimitPerHour: typeof chat['rateLimitPerHour'] === 'number' ? (chat['rateLimitPerHour'] as number) : 0,
  };
}

/**
 * Best-effort per-uid hourly rate check. Counts this uid's own messages in the
 * household thread sent within the last hour and returns whether sending another
 * would exceed `rateLimitPerHour`. Bounded by `.limit(cap + 1)` so a chatty
 * thread never scans unboundedly. Read-only and tolerant: any query failure is
 * swallowed by the caller so the happy path is never blocked by this defense.
 */
async function exceedsRateLimit(kinfolkId: string, uid: string, cap: number): Promise<boolean> {
  const sinceMs = Date.now() - 60 * 60 * 1000;
  const snap = await db()
    .collection(CONVERSATIONS_COLLECTION)
    .doc(kinfolkId)
    .collection(MESSAGES_SUBCOLLECTION)
    .where('senderUid', '==', uid)
    .where('createdAtMs', '>=', sinceMs)
    .limit(cap + 1)
    .get();
  return snap.size >= cap;
}

/**
 * Stage 2 step 7 (Message Auntie 16.4) - kinfolk-portal side.
 *
 * sendKinfolkMessage: the MyTribe kinfolk app sends a message to the auntie.
 * getMyConversation: the kinfolk app reads its own thread (and marks it read).
 *
 * Both are portal callables (wrapCallable, any signed-in kinfolk) and resolve the
 * caller's own kinfolkId via resolveKinfolkAccess so a kinfolk can only ever read
 * or write their OWN household thread. The auntie side is in src/admin.
 */

const SendArgs = z.object({
  kinfolkId: z.string().min(1).max(200).optional(),
  body: z.string().min(1).max(MAX_MESSAGE_BODY),
});

/** Composes a household display name from a kinfolk doc, falling back to the id. */
function kinfolkDisplayName(data: Record<string, unknown> | undefined, kinfolkId: string): string {
  const first = typeof data?.firstName === 'string' ? data.firstName : '';
  const last = typeof data?.lastName === 'string' ? data.lastName : '';
  const name = `${first} ${last}`.trim();
  return name.length > 0 ? name : kinfolkId;
}

export async function sendKinfolkMessageHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; kinfolkId: string; messageId: string }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof SendArgs>;
  try {
    args = SendArgs.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'sendKinfolkMessage validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const { kinfolkId, isOperator } = await resolveKinfolkAccess(uid, args.kinfolkId, req.auth?.token?.admin === true, 'sendKinfolkMessage');
  const member = await requireKinfolkPerm(uid, kinfolkId, 'messaging_direct', req.auth?.token?.admin === true, 'sendKinfolkMessage');

  const body = sanitizeRichText(args.body);
  if (body.length === 0) {
    throw new HttpsError('invalid-argument', 'message_body_empty');
  }

  // --- Server-side chat policy (§8, defense-in-depth; client checks are UX only) ---
  const policy = await loadChatPolicy();
  // Chat turned off in admin → reject before any write.
  if (policy.enabled === false) {
    throw new HttpsError('failed-precondition', 'chat_disabled');
  }
  // Hard length cap (0 = unlimited). Independent of the Zod MAX_MESSAGE_BODY ceiling,
  // which is the absolute storage bound; this is the operator-configurable limit.
  if (policy.maxMessageLength > 0 && body.length > policy.maxMessageLength) {
    throw new HttpsError('invalid-argument', 'message_too_long');
  }
  // Per-uid hourly cap (0 = unlimited). Best-effort: never let a rate-check failure
  // (e.g. missing composite index) block a legitimate message.
  if (policy.rateLimitPerHour > 0) {
    let limited = false;
    try {
      limited = await exceedsRateLimit(kinfolkId, uid, policy.rateLimitPerHour);
    } catch (err) {
      logEvent({
        severity: 'warn',
        function: 'sendKinfolkMessage',
        event: 'rate_limit.check.failed',
        uid,
        errorMessage: (err as Error)?.message,
      });
    }
    if (limited) {
      throw new HttpsError('resource-exhausted', 'rate_limited');
    }
  }

  const kinSnap = await db().collection('kinfolk').doc(kinfolkId).get();
  const kinfolkName = kinfolkDisplayName(kinSnap.data() as Record<string, unknown> | undefined, kinfolkId);

  const messageId = await appendMessage({
    kinfolkId,
    kinfolkName,
    senderRole: 'kinfolk',
    senderUid: uid,
    body,
    memberUid: uid,
  });

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.CONVERSATION_MESSAGE_SENT,
    severity: 'info',
    // Reflect the real sender: a secondary with messaging_direct is SECONDARY,
    // an operator send is AUNTIE, and a legacy primary (no member doc) is PRIMARY.
    actorRole: member ? member.role : isOperator ? 'AUNTIE' : 'PRIMARY',
    actorUid: uid,
    targetCollection: `${CONVERSATIONS_COLLECTION}/${kinfolkId}`,
    description: `Kinfolk message to auntie (${kinfolkName})`,
    payload: { kinfolkId, messageId, senderRole: 'kinfolk' },
  }).catch((err) => {
    logEvent({ severity: 'warn', function: 'sendKinfolkMessage', event: 'audit.write.failed', uid, errorMessage: (err as Error)?.message });
  });

  // Vendor-parity (2026-07-02): the office hears new kinfolk messages through the
  // notification gate like everything else. Best-effort: a dispatch failure never
  // fails the send itself.
  try {
    await enqueueNotification({
      key: 'message.received',
      data: {
        kinfolkId,
        kinfolkName,
        messageId,
        preview: toPlainTextPreview(body, 200),
      },
      actorUid: uid,
    });
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'sendKinfolkMessage',
      event: 'notification.dispatch.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  }

  return { ok: true, kinfolkId, messageId };
}

export const sendKinfolkMessage = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('sendKinfolkMessage', sendKinfolkMessageHandler),
);

// ---------------------------------------------------------------------------
// getMyConversation: kinfolk reads its own thread and clears its unread flag.
// ---------------------------------------------------------------------------

const GetArgs = z.object({ kinfolkId: z.string().min(1).max(200).optional() });

export async function getMyConversationHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; kinfolkId: string; messages: ThreadMessage[] }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof GetArgs>;
  try {
    args = GetArgs.parse(req.data ?? {});
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'getMyConversation validation failed');
    }
    throw err;
  }

  const { kinfolkId } = await resolveKinfolkAccess(uid, args.kinfolkId, req.auth?.token?.admin === true, 'getMyConversation');
  const messages = await readThread(kinfolkId);

  // Reading clears the kinfolk-side unread flag and stamps readAt on every
  // unread auntie message (best-effort; markMessagesRead no-ops cleanly if
  // the thread doesn't exist yet).
  await markMessagesRead(kinfolkId, 'kinfolk');

  return { ok: true, kinfolkId, messages };
}

export const getMyConversation = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('getMyConversation', getMyConversationHandler),
);

// ---------------------------------------------------------------------------
// markThreadRead: explicit portal callable for a thread already loaded client
// -side (e.g. a realtime listener delivered a new message) — avoids a full
// getMyConversation refetch just to stamp readAt.
// ---------------------------------------------------------------------------

export async function markThreadReadHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; kinfolkId: string; markedCount: number }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof GetArgs>;
  try {
    args = GetArgs.parse(req.data ?? {});
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'markThreadRead validation failed');
    }
    throw err;
  }

  const { kinfolkId } = await resolveKinfolkAccess(uid, args.kinfolkId, req.auth?.token?.admin === true, 'markThreadRead');
  const markedCount = await markMessagesRead(kinfolkId, 'kinfolk');
  return { ok: true, kinfolkId, markedCount };
}

export const markThreadRead = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('markThreadRead', markThreadReadHandler),
);
