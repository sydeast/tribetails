/**
 * Wire types + typed wrappers for the S5 kinfolk-conversation callables
 * (functions/src/portal/sendKinfolkMessage.ts, functions/src/lib/conversations.ts).
 * Self-contained (mirrors invoicesApi.ts's `call` pattern) so this screen's
 * backend surface doesn't touch api/types.ts or api/portal.ts.
 *
 * Every DTO below is transcribed from its backend handler; each block cites
 * its source file. Field names/types MUST stay in sync with those files.
 */
import { FirebaseError } from 'firebase/app';
import { call, CallableTimeoutError } from '../lib/fns';

// ── shared thread shape (functions/src/lib/conversations.ts, ThreadMessage) ─

export type SenderRole = 'kinfolk' | 'auntie';

export interface ThreadMessageDto {
  id: string;
  senderRole: SenderRole;
  senderUid: string;
  /**
   * Sanitized rich-text HTML (functions/src/lib/richText.ts's
   * sanitizeRichText already ran server-side on every write path into this
   * field — allowlist: b, strong, i, em, u, p, br, ul, ol, li, blockquote,
   * a[href]). Safe to render as HTML client-side; see Messages.tsx.
   */
  body: string;
  createdAtMs: number;
  deliveredAt: number | null;
  readAt: number | null;
}

// ── sendKinfolkMessage (functions/src/portal/sendKinfolkMessage.ts) ─────────

export interface SendKinfolkMessageRequest {
  kinfolkId?: string;
  body: string;
}

export interface SendKinfolkMessageResult {
  ok: true;
  kinfolkId: string;
  messageId: string;
}

/**
 * Sends a rich-text message (TipTap HTML, pre-sanitize) to the household's
 * auntie thread. `body` is re-sanitized server-side no matter what the
 * client sends — never trust the composer's own toolbar restrictions as a
 * security boundary, only as UX.
 */
export function sendKinfolkMessage(body: string, kinfolkId?: string): Promise<SendKinfolkMessageResult> {
  const payload: SendKinfolkMessageRequest = { body, ...(kinfolkId !== undefined ? { kinfolkId } : {}) };
  return call<SendKinfolkMessageRequest, SendKinfolkMessageResult>('sendKinfolkMessage', payload);
}

// ── getMyConversation (functions/src/portal/sendKinfolkMessage.ts) ──────────

export interface GetMyConversationRequest {
  kinfolkId?: string;
}

export interface GetMyConversationResult {
  ok: true;
  kinfolkId: string;
  messages: ThreadMessageDto[];
}

/**
 * The signed-in kinfolk's full thread, oldest-first. Calling this ALSO
 * marks every unread auntie message as read server-side (markMessagesRead
 * inside the handler) — it is not a passive read. Messages.tsx relies on
 * that side effect for the initial mark-read and only calls
 * `markThreadRead` explicitly for messages that arrive later over the
 * realtime listener (see lib/messagesListener.ts), so the two paths never
 * double-mark the same message.
 */
export function getMyConversation(kinfolkId?: string): Promise<GetMyConversationResult> {
  const payload: GetMyConversationRequest = kinfolkId !== undefined ? { kinfolkId } : {};
  return call<GetMyConversationRequest, GetMyConversationResult>('getMyConversation', payload);
}

// ── markThreadRead (functions/src/portal/sendKinfolkMessage.ts) ─────────────

export interface MarkThreadReadRequest {
  kinfolkId?: string;
}

export interface MarkThreadReadResult {
  ok: true;
  kinfolkId: string;
  markedCount: number;
}

/**
 * Explicit mark-read for a thread already loaded client-side (the realtime
 * listener delivered a new auntie message while the screen was open) —
 * avoids a full getMyConversation refetch just to stamp readAt.
 */
export function markThreadRead(kinfolkId?: string): Promise<MarkThreadReadResult> {
  const payload: MarkThreadReadRequest = kinfolkId !== undefined ? { kinfolkId } : {};
  return call<MarkThreadReadRequest, MarkThreadReadResult>('markThreadRead', payload);
}

// ── generate (functions/src — O-8 AI message assist) ────────────────────────

export type GenerateAssistMode = 'polish' | 'suggest_reply';

export interface GenerateAssistRequest {
  kinfolkId?: string;
  mode: GenerateAssistMode;
  /** Required for 'polish' (the draft to rewrite); ignored for 'suggest_reply'. */
  body?: string;
}

export interface GenerateAssistResult {
  ok: true;
  mode: string;
  /**
   * AI-drafted rich text, constrained server-side to the SAME allowlist as
   * message bodies (p, br, b/strong, i/em, u, ul, ol, li, blockquote,
   * a[href]) — safe to load straight into the composer.
   */
  html: string;
  text: string;
}

/**
 * O-8 writing helper. 'polish' rewrites the current draft (`body` required);
 * 'suggest_reply' drafts a reply from the thread itself, which the SERVER
 * reads — the client sends no thread content, so `body` is omitted.
 */
export function generateAssist(
  mode: GenerateAssistMode,
  body?: string,
  kinfolkId?: string,
): Promise<GenerateAssistResult> {
  const payload: GenerateAssistRequest = {
    mode,
    ...(body !== undefined ? { body } : {}),
    ...(kinfolkId !== undefined ? { kinfolkId } : {}),
  };
  return call<GenerateAssistRequest, GenerateAssistResult>('generate', payload);
}

// ── error mapping ────────────────────────────────────────────────────────

/**
 * Maps a rejected sendKinfolkMessage call to grandma-friendly copy, pure so
 * vitest can cover every branch (mirrors lib/authErrors.ts's mapAuthError
 * shape). The three business-rule rejections below are cited verbatim from
 * sendKinfolkMessage.ts's HttpsError call sites:
 *   - failed-precondition / 'chat_disabled'      operator turned chat off
 *   - invalid-argument   / 'message_too_long'    over the operator's cap
 *   - invalid-argument   / 'message_body_empty'  nothing left after sanitize
 *   - resource-exhausted / 'rate_limited'        per-uid hourly cap hit
 * Anything else (network blip, cold-start timeout, an unrecognized server
 * error) falls through to a generic retry message — never a raw error dump.
 */
export function mapSendMessageError(err: unknown): string {
  if (err instanceof CallableTimeoutError) {
    return err.message;
  }
  if (err instanceof FirebaseError) {
    switch (err.message) {
      case 'chat_disabled':
        return 'Messaging is turned off right now. Please reach out another way.';
      case 'message_too_long':
        return 'That message is too long. Trim it a little and try sending again.';
      case 'message_body_empty':
        return 'Write something before sending.';
      case 'rate_limited':
        return "You're sending messages a little too fast. Wait a bit and try again.";
    }
    if (err.code === 'functions/resource-exhausted') {
      return "You're sending messages a little too fast. Wait a bit and try again.";
    }
    if (err.code === 'functions/unauthenticated') {
      return 'You were signed out. Sign in again to send messages.';
    }
    if (err.code === 'functions/invalid-argument') {
      return 'That message is too long or empty. Trim it and try again.';
    }
  }
  return "Your message didn't send. Check your connection and try again.";
}

/**
 * Maps a rejected generateAssist call to grandma-friendly copy, pure so
 * vitest can cover every branch (same shape as mapSendMessageError above).
 * Backend rejection surface (generate's HttpsError call sites):
 *   - invalid-argument   / 'polish_body_empty'   nothing to polish (the UI
 *                                                disables Polish on an empty
 *                                                draft, so this falls through
 *                                                to the generic message)
 *   - failed-precondition / 'thread_empty'       nothing to reply to yet
 *   - resource-exhausted / 'rate_limited'        hourly cap (30) hit
 *   - unavailable / 'ai_unavailable' or 'ai_empty_result'
 * Anything else falls through to a generic retry message.
 */
export function mapGenerateError(err: unknown): string {
  if (err instanceof CallableTimeoutError) {
    return err.message;
  }
  if (err instanceof FirebaseError) {
    if (err.code === 'functions/resource-exhausted') {
      return "You've used the writing helper a lot this hour. Please try again later.";
    }
    if (err.code === 'functions/failed-precondition') {
      return 'There are no messages to reply to yet.';
    }
    if (err.code === 'functions/unavailable') {
      return "The writing helper isn't available right now. Please try again in a moment.";
    }
  }
  return "The writing helper couldn't finish that. Please try again.";
}
