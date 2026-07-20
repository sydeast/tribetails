import { auth } from '../lib/firebase';

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
 *   sendMessage    admin-only, proxies to the (not-yet-retired) n8n
 *                  `auntie-send-message` webhook and normalizes the response
 *                  to JSON. This is the SAME endpoint the wasm Communicate
 *                  screen's own Personalize flow sends through
 *                  (`N8nClient.sendMessage` posts to `/api/send-message`);
 *                  it is NOT `sendExternalMessage` (a different, MyTribe-side
 *                  `onCall` with a different payload shape that writes
 *                  `external_messages` directly via Twilio/SMTP2GO, used by
 *                  the broadcast path). Using the proven-live wasm path here
 *                  keeps this port on the backend that is actually wired
 *                  today; n8n retirement Phase B (deleting this proxy) is
 *                  still gated on operator prod-verification per the n8n
 *                  retirement plan.
 *
 * ── WHY A BARE fetch, NOT lib/fns.ts's `call` ───────────────────────────────
 * `lib/fns.ts`'s `call()` is `httpsCallable`-only; an `onRequest` endpoint has
 * no callable name to resolve and does not speak the callable wire protocol
 * (no automatic CORS preflight handling, no automatic ID-token attachment).
 * Both facts are why the wasm rewrite exists at all (`web/firebase.json`'s
 * `/api/generate -> generate` / `/api/send-message -> sendMessage`, same-origin
 * so `cors: false` never bites): this admin app is a SEPARATE Firebase Hosting
 * site (`auntieos-admin`, this repo's own `firebase.json`), so it needs the
 * identical rewrite pair added to ITS OWN `firebase.json` before either path
 * works in production. See the rewrite snippet in this module's sibling doc
 * comment on `GENERATE_ENDPOINT` / `SEND_ENDPOINT` below, and the integrator
 * note this task's report calls out.
 */

const GENERATE_ENDPOINT = '/api/generate';
const SEND_ENDPOINT = '/api/send-message';

/** Every `communication_type` the backend's `ALLOWED_TYPES` accepts (generate.js line 25). */
export const GENERATE_COMMUNICATION_TYPES = [
  'sms',
  'email',
  'visit_report',
  'social_post',
  'blog_post',
  'general',
] as const;
export type GenerateCommunicationType = (typeof GENERATE_COMMUNICATION_TYPES)[number];

export interface GenerateDraftArgs {
  communication_type: GenerateCommunicationType;
  /** Free-text name the backend resolves against the `kinfolk` collection (`matchKinfolk`). */
  recipient: string;
  raw_notes: string;
  tone_hint?: string;
  max_length?: string;
  /** On regenerate: the previous draft's opening, so the model does not repeat it. */
  avoid_opening?: string;
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
  kinfolk_id?: string;
  recipient_email?: string;
  recipient_phone?: string;
}

/**
 * Normalized send outcome. `sendMessage` (the n8n proxy) can return any of
 * `sid` / `message_sid` / `twilioMessageSid` / `id` depending on which
 * provider the n8n workflow used; `providerId` reads whichever is present,
 * defensively, rather than assuming one fixed field name.
 */
export interface SendPersonalizedResult {
  ok: true;
  providerId: string | null;
}

/**
 * Calls `POST /api/send-message`. Same rewrite/sign-in/error-surfacing
 * contract as `generateDraft` above. Throws `SendMessageError` naming the
 * backend's `error` or `provider_error` field on any failure; never returns
 * a fabricated success when the HTTP call itself failed or the provider
 * rejected the send.
 */
export async function sendPersonalizedMessage(
  args: SendPersonalizedArgs,
): Promise<SendPersonalizedResult> {
  const idToken = await requireIdToken(SendMessageError, 'sending a message');

  let response: Response;
  try {
    response = await fetch(SEND_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify(args),
    });
  } catch (err) {
    throw new SendMessageError(
      `sendMessage request failed: ${err instanceof Error ? err.message : 'network error'}`,
    );
  }

  const body = await parseJsonBody(response);
  const errorField = stringField(body, 'error') ?? stringField(body, 'provider_error');
  if (!response.ok || errorField !== null) {
    throw new SendMessageError(errorField ?? `sendMessage failed (${response.status})`);
  }

  const providerId =
    stringField(body, 'sid') ??
    stringField(body, 'message_sid') ??
    stringField(body, 'twilioMessageSid') ??
    stringField(body, 'id');
  return { ok: true, providerId };
}
