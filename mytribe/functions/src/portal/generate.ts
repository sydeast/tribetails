import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { resolveKinfolkAccess } from '../lib/resolveKinfolkAccess';
import { requireKinfolkPerm } from '../lib/memberGate';
import { enforceRateLimit } from '../lib/rateLimit';
import { sanitizeRichText, sanitizePlainText, toPlainTextPreview } from '../lib/richText';
import { readThread } from '../lib/conversations';
import { generateCopy } from '../lib/aiCopy';
import { logEvent } from '../lib/logger';
import { FULL_CPU } from '../lib/runtimeOptions';

/**
 * O-8: `generate` — kinfolk-facing AI copy assistance for the Messages
 * composer, on web and Android.
 *
 * Modes:
 *  - polish:        rewrite the kinfolk's own draft for clarity in their own
 *                   voice. Requires `body`.
 *  - suggest_reply: draft a short reply the kinfolk could send, based on the
 *                   most recent messages in their household thread. `body`
 *                   is ignored.
 *
 * Same access model as sendKinfolkMessage: the caller must belong to the
 * kinfolk (resolveKinfolkAccess) and hold the messaging_direct member
 * permission. Nothing is written; the result is returned for the composer to
 * adopt or discard, and the eventual send goes through sendKinfolkMessage's
 * own sanitization.
 *
 * Rate limit: fixed-window per uid (defense against cost abuse; the Anthropic
 * call is the only metered resource this touches).
 */

export const GENERATE_MODES = ['polish', 'suggest_reply'] as const;
export type GenerateMode = (typeof GENERATE_MODES)[number];

const MAX_INPUT_CHARS = 5000;
const RATE_LIMIT_PER_HOUR = 30;
/** Household ceiling across all member accounts. */
const RATE_LIMIT_PER_KINFOLK_HOUR = 60;
/** How much recent thread context suggest_reply sees. */
const THREAD_CONTEXT_MESSAGES = 10;

const GenerateArgs = z.object({
  kinfolkId: z.string().min(1).max(200).optional(),
  mode: z.enum(GENERATE_MODES),
  body: z.string().max(MAX_INPUT_CHARS).optional(),
});

export interface GenerateResult {
  ok: true;
  mode: GenerateMode;
  /** Rich-text result constrained to the message allowlist (web composer). */
  html: string;
  /** Plain-text rendering of the same result (Android composer). */
  text: string;
}

function polishInstruction(): string {
  return (
    'Task: polish the kinfolk message draft below. Keep the writer\'s meaning, details, ' +
    'language, and first-person voice. Fix clarity, spelling, and flow only. Stay close ' +
    'to the original length. HTML is allowed.\n\nDraft:'
  );
}

function suggestReplyInstruction(): string {
  return (
    'Task: suggest one short reply (1 to 3 sentences) the kinfolk could send next in the ' +
    'conversation below. Speak as the kinfolk, plainly. If the last message from the auntie ' +
    'asks a question you cannot answer from the conversation, acknowledge it and ask for or ' +
    'promise the missing detail instead of inventing one. HTML is allowed.\n\nConversation, oldest first:'
  );
}

export async function generateHandler(req: CallableRequest<unknown>): Promise<GenerateResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof GenerateArgs>;
  try {
    args = GenerateArgs.parse(req.data ?? {});
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'generate validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const { kinfolkId } = await resolveKinfolkAccess(uid, args.kinfolkId, req.auth?.token?.admin === true, 'generate');
  // Copy assist is part of messaging: same permission as sending.
  await requireKinfolkPerm(uid, kinfolkId, 'messaging_direct', req.auth?.token?.admin === true, 'generate');

  // Hard (transactional) caps, unlike the chat send's best-effort check: every
  // accepted call costs real money, so a failed-open limiter is wrong here.
  // Two keys: per uid, and per household — otherwise a household could
  // multiply its budget by inviting N secondary members (review finding 4).
  await enforceRateLimit('aiGenerate', uid, RATE_LIMIT_PER_HOUR, 3600);
  await enforceRateLimit('aiGenerateKinfolk', kinfolkId, RATE_LIMIT_PER_KINFOLK_HOUR, 3600);

  let instruction: string;
  let input: string;
  if (args.mode === 'polish') {
    const draft = sanitizeRichText(args.body ?? '');
    if (draft.length === 0) {
      throw new HttpsError('invalid-argument', 'polish_body_empty');
    }
    instruction = polishInstruction();
    input = draft;
  } else {
    const thread = await readThread(kinfolkId);
    const recent = thread.slice(-THREAD_CONTEXT_MESSAGES);
    if (recent.length === 0) {
      throw new HttpsError('failed-precondition', 'thread_empty');
    }
    instruction = suggestReplyInstruction();
    input = recent
      .map((m) => {
        const who = m.senderRole === 'auntie' ? 'Auntie' : 'Kinfolk';
        return `${who}: ${toPlainTextPreview(m.body, 600)}`;
      })
      .join('\n');
  }

  let raw: string;
  try {
    raw = await generateCopy({ instruction, input });
  } catch (err) {
    // Upstream model/API failures are our fault from the caller's view, but
    // must not page as unhandled: map to a stable retryable code.
    logEvent({
      severity: 'error',
      function: 'generate',
      event: 'ai.request.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
    throw new HttpsError('unavailable', 'ai_unavailable');
  }

  // The model is told the allowlist, but the sanitizer is the contract:
  // whatever comes back is forced through the exact same allowlist the send
  // path uses, so the result can never carry anything a hand-typed message
  // couldn't.
  const html = sanitizeRichText(raw);
  const text = sanitizePlainText(raw);
  if (html.length === 0 && text.length === 0) {
    throw new HttpsError('unavailable', 'ai_empty_result');
  }

  return { ok: true, mode: args.mode, html, text };
}

export const generate = onCall(
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS', 'ANTHROPIC_API_KEY'],
    timeoutSeconds: 60,
    // Interactive LLM call with a 60s budget and someone waiting on it. The
    // instance cap here is a Cloud Run cap, not an Anthropic spend cap.
    ...FULL_CPU,
  },
  wrapCallable('generate', generateHandler),
);
