import { auth } from '../lib/firebase';
import { call } from '../lib/fns';

/**
 * Communicate PERSONALIZE (1:1 AI-drafted note) write surface: the flow
 * `Communicate.tsx`'s module doc lists as "not-yet-built" alongside the
 * broadcast compose this repo already shipped (`api/communicateWrite.ts`).
 * This module is that flow's api layer: generate a Auntie-voice draft for one
 * kinfolk, then send the (possibly hand-edited) result to them.
 *
 * ── BOTH ENDPOINTS ARE `onRequest`, NOT `onCall` ────────────────────────────
 * Every other callable this app reaches (`broadcastMessage`, `listRecentSends`,
 * ...) is a Firebase `onCall` in MyTribe/functions, routed through
 * `lib/fns.ts`'s `httpsCallable` wrapper. `generate` and `sendMessage` are
 * different: both are `exports.generate` / `exports.sendMessage` in
 * AuntieOS/web/functions/index.js, declared `onRequest({ ..., cors: false })`
 * (generate.js / index.js, confirmed by direct read 2026-07-17), NOT
 * `onCall`. The wasm bridge (`N8nClient.kt`) reaches them the same way this
 * module does: a bare `fetch` with a `Bearer <idToken>` header, not the
 * Functions SDK's `httpsCallable`.
 *
 *   generate       admin-only (Firebase ID token, `requireAdminToken` in
 *                  index.js), reads admin-only Firestore context (dossiers /
 *                  kin / the_411 / visit_logs), builds the Auntie Voice Bible
 *                  prompt, calls Claude, writes a `generated_drafts` doc, and
 *                  returns a byte-compatible `GenerateResponse`. Confirmed
 *                  DEPLOYED (2026-06-17 memory: "/api/generate DEPLOYED
 *                  always-on").
 * SENDING is different, and no longer goes through this file's fetch path at
 * all. It used to POST `/api/send-message`, an AuntieOS `onRequest` that was a
 * bare proxy to the n8n `auntie-send-message` webhook. n8n was retired, so that
 * route pointed at a host which no longer answers and every Personalize send in
 * prod failed. `sendPersonalizedMessage` now calls MyTribe's
 * `sendExternalMessage` (`onCall`, Twilio + smtp2go), which is what the
 * broadcast path beside it was already using.
 *
 * ── WHY generate STILL USES A BARE fetch ────────────────────────────────────
 * `lib/fns.ts`'s `call()` is `httpsCallable`-only; an `onRequest` endpoint has
 * no callable name to resolve and does not speak the callable wire protocol
 * (no automatic CORS preflight handling, no automatic ID-token attachment).
 * `generate` is still an `onRequest`, reached through this app's own
 * `firebase.json` rewrite (`/api/generate -> generateAuntieCopy`), so it keeps
 * the fetch. The send does not, which is why only one endpoint constant remains.
 */

const GENERATE_ENDPOINT = '/api/generate';

/** Every `communication_type` the backend's `ALLOWED_TYPES` accepts (generate.js line 25). */
export const GENERATE_COMMUNICATION_TYPES = [
  'sms',
  'email',
  'push',
  'visit_report',
  'social_post',
  'blog_post',
  'general',
] as const;
export type GenerateCommunicationType = (typeof GENERATE_COMMUNICATION_TYPES)[number];

export interface GenerateDraftArgs {
  communication_type: GenerateCommunicationType;
  /**
   * Display name of the household. The backend still resolves it with
   * `matchKinfolk` when no `kinfolk_id` is supplied; when one IS supplied this
   * is carried for the draft doc and the error copy only.
   */
  recipient: string;
  /**
   * The REAL `kinfolk` doc id, when the caller resolved one (the Personalize
   * typeahead always does). The backend looks the household up directly and
   * skips the fuzzy name scan entirely, so two households named Dana can no
   * longer collapse into whichever one `matchKinfolk` reached first.
   * Optional: the KinTale composer and the no-recipient types omit it.
   */
  kinfolk_id?: string;
  raw_notes: string;
  tone_hint?: string;
  max_length?: string;
  /** On regenerate: the previous draft's opening, so the model does not repeat it. */
  avoid_opening?: string;
  /**
   * Ask for a title alongside the body. Opt-in, not inferred from
   * `communication_type`: the second model call is only worth paying for when
   * the caller has somewhere to put the result. The KinTale composer sets it;
   * Communicate does not.
   */
  want_title?: boolean;
}

/**
 * `generate`'s response, field-for-field (generate.js `runGenerate` /
 * index.js's `exports.generate` doc comment). `draft_id` is `null` when the
 * Firestore draft write failed (`draftWriteFailed: true`); the copy is still
 * returned and usable, callers must surface `draftWriteFailed` fail-loud
 * rather than silently treating a successful generation as a saved one.
 */
export interface GenerateDraftResult {
  generated_copy: string;
  /**
   * Blank unless `want_title` was set, and also blank when the title call
   * failed (the backend swallows that failure so a title problem never costs
   * the operator the body). Blank means "write your own", never an error.
   */
  generated_title: string;
  communication_type: string;
  kinfolk_name: string | null;
  kinfolk_id: string | null;
  draft_id: string | null;
  model: string | null;
  draftWriteFailed: boolean;
  warnings: string[];
}

export class GenerateDraftError extends Error {}
export class SendMessageError extends Error {}

/**
 * Current admin's Firebase ID token, or a named fail-loud error if nobody is
 * signed in. Mirrors `N8nClient.generate`'s
 * `AuthClient().idToken(forceRefresh = false) ?: throw ...`. Takes the
 * caller's own error constructor + a short action phrase so the two callers
 * below (`generateDraft` / `sendPersonalizedMessage`) each throw THEIR OWN
 * named error type with an accurate message, rather than sharing one that
 * would say "before generating a draft" even when the caller was sending.
 */
async function requireIdToken<E extends Error>(ErrorCtor: new (message: string) => E, action: string): Promise<string> {
  const user = auth.currentUser;
  if (!user) {
    throw new ErrorCtor(`Sign-in required before ${action}.`);
  }
  return user.getIdToken();
}

/** Parses a fetch Response body as JSON, or `null` on a non-JSON/empty body (never throws). */
async function parseJsonBody(response: Response): Promise<Record<string, unknown> | null> {
  const text = await response.text();
  if (text.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stringField(body: Record<string, unknown> | null, key: string): string | null {
  const v = body?.[key];
  return typeof v === 'string' ? v : null;
}

/**
 * Calls `POST /api/generate`. Requires the site's own `firebase.json` to
 * carry the `/api/generate -> generate` rewrite (see this module's header
 * doc); without it this 404s against `index.html` and the JSON parse below
 * returns `null`, which this function correctly reports as a failure rather
 * than a fabricated empty draft.
 *
 * Throws `GenerateDraftError` on any failure (no sign-in, network failure,
 * non-2xx response, or an `error` field on the response body), naming the
 * backend's own error string where one exists (e.g. `No Kinfolk match for
 * "X"`, `generate_rate_limit_exceeded`) rather than a generic message.
 */
export async function generateDraft(args: GenerateDraftArgs): Promise<GenerateDraftResult> {
  const idToken = await requireIdToken(GenerateDraftError, 'generating a draft');

  let response: Response;
  try {
    response = await fetch(GENERATE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify(args),
    });
  } catch (err) {
    throw new GenerateDraftError(
      `generate request failed: ${err instanceof Error ? err.message : 'network error'}`,
    );
  }

  const body = await parseJsonBody(response);
  const errorField = stringField(body, 'error');
  if (!response.ok || errorField !== null) {
    throw new GenerateDraftError(errorField ?? `generate failed (${response.status})`);
  }

  const generatedCopy = stringField(body, 'generated_copy');
  if (generatedCopy === null || generatedCopy === '') {
    throw new GenerateDraftError('generate returned no draft copy.');
  }

  const warningsRaw = body?.['warnings'];
  return {
    generated_copy: generatedCopy,
    generated_title: stringField(body, 'generated_title') ?? '',
    communication_type: stringField(body, 'communication_type') ?? args.communication_type,
    kinfolk_name: stringField(body, 'kinfolk_name'),
    kinfolk_id: stringField(body, 'kinfolk_id'),
    draft_id: stringField(body, 'draft_id'),
    model: stringField(body, 'model'),
    draftWriteFailed: body?.['draftWriteFailed'] === true,
    warnings: Array.isArray(warningsRaw) ? warningsRaw.filter((w): w is string => typeof w === 'string') : [],
  };
}

/**
 * Pulls a short "opening" out of a draft (its first sentence, or its first
 * `maxWords` words if no sentence-ending punctuation appears within them),
 * for the `avoid_opening` field on a regenerate call. Ports the INTENT of the
 * wasm `GenerateRequest.avoid_opening` doc ("the reader rejected this
 * opener; the generator must not reuse it") without needing wasm's own
 * extraction code, which does not exist in this repo to port from; this is a
 * new, small, independently-testable helper rather than a guess dressed up as
 * a port.
 *
 * Deliberately does NOT pass the whole draft: `generate.js`'s prompt appends
 * `Do NOT open with "${avoidOpening}"...`, and a multi-paragraph value there
 * would read as "don't write any of this again", not "vary the opener".
 */
export function draftOpening(text: string, maxWords = 8): string {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  const sentenceMatch = /^[^.!?\n]+[.!?]/.exec(trimmed);
  if (sentenceMatch) return sentenceMatch[0].trim();
  const words = trimmed.split(/\s+/).slice(0, maxWords);
  return words.join(' ');
}

// ── send ─────────────────────────────────────────────────────────────────

export type PersonalizeChannel = 'email' | 'sms';

export interface SendPersonalizedArgs {
  channel: PersonalizeChannel;
  message_body: string;
  /** Required when channel is 'email'; the backend rejects a blank subject. */
  subject?: string;
  kinfolk_id?: string;
  recipient_email?: string;
  recipient_phone?: string;
}

export interface SendPersonalizedResult {
  ok: true;
  providerId: string | null;
}

/** Wire shape of the MyTribe `sendExternalMessage` callable. */
interface SendExternalMessageRequest {
  channel: PersonalizeChannel;
  to: string;
  body: string;
  subject?: string;
  transactional: boolean;
}

interface SendExternalMessageResponse {
  ok: true;
  channel: PersonalizeChannel;
  providerMessageId?: string | null;
  recipientRedacted?: string;
}

/**
 * Sends a 1:1 personalized message through MyTribe's `sendExternalMessage`
 * callable (Twilio for sms, smtp2go for email).
 *
 * This used to POST `/api/send-message`, which the hosting rewrite pointed at
 * an AuntieOS function that was a bare proxy to
 * `https://n8n.tribetails.com/webhook/auntie-send-message`. n8n was retired, so
 * every Personalize send in prod hit a host that no longer answers, while the
 * Broadcast path beside it already used this same callable. The proxy's
 * defensive `sid` / `message_sid` / `twilioMessageSid` / `id` unwrapping existed
 * because the n8n workflow's response shape varied by provider; the callable
 * returns one documented field, so that guesswork is gone.
 *
 * Behavior gained by moving, both deliberate: sends now pass the consent gate
 * (a recipient in `message_suppressions` is refused) and every send is recorded
 * in `external_messages` with an audit entry.
 *
 * Still throws `SendMessageError` on any failure and never fabricates success.
 */
export async function sendPersonalizedMessage(
  args: SendPersonalizedArgs,
): Promise<SendPersonalizedResult> {
  const to =
    args.channel === 'email'
      ? (args.recipient_email ?? '').trim()
      : (args.recipient_phone ?? '').trim();
  if (to === '') {
    throw new SendMessageError(
      args.channel === 'email'
        ? 'This Kinfolk has no email address on file.'
        : 'This Kinfolk has no phone number on file.',
    );
  }

  const body = args.message_body.trim();
  if (body === '') throw new SendMessageError('The message body is empty.');

  const subject = (args.subject ?? '').trim();
  if (args.channel === 'email' && subject === '') {
    throw new SendMessageError('A subject is required for an email.');
  }

  const payload: SendExternalMessageRequest = {
    channel: args.channel,
    to,
    body,
    // A personalized 1:1 message an operator wrote and confirmed is
    // transactional, not marketing: it must not be dropped by a bulk opt-out.
    transactional: true,
    ...(args.channel === 'email' ? { subject } : {}),
  };

  let res: SendExternalMessageResponse;
  try {
    res = await call<SendExternalMessageRequest, SendExternalMessageResponse>(
      'sendExternalMessage',
      payload,
    );
  } catch (err) {
    throw new SendMessageError(err instanceof Error ? err.message : 'The send failed.');
  }

  return { ok: true, providerId: res.providerMessageId ?? null };
}
