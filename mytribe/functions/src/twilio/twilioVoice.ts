import { onRequest, Request } from 'firebase-functions/v2/https';
import type { Response } from 'express';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapHttp } from '../lib/wrapHttp';
import { FULL_CPU } from '../lib/runtimeOptions';
import { guardVoice } from './twilioSignature';
import { resolveBusinessOpenNow, type BusinessOpenState } from '../lib/businessHours';

/**
 * The business phone line, as TwiML served from this repo.
 *
 * ── WHAT THIS REPLACES, AND WHY ───────────────────────────────────────────────
 *
 * A Twilio Studio Flow (`FW9b2aa5e0…`, mirrored in
 * `auntieos-admin/studio_flow_v2.json`) that asked a Twilio Serverless function
 * whether the business was open. On 2026-08-11 that arrangement was found to
 * have been telling EVERY caller, at EVERY hour, that the business was closed:
 *
 *   1. The deployed `/check-hours` computed `isOpen` and then returned the
 *      literal `{ is_open: false }` with a `// or true` comment beside it. Its
 *      source in this repo (`auntieos-admin/twilio-service/functions/check-hours.js`)
 *      is a DIFFERENT, correct implementation that returns `"yes"`/`"no"`. The
 *      repo copy was never what ran.
 *   2. The flow's split compared the whole HTTP body against the string `"yes"`.
 *      The body was JSON. It could never match, so every call fell through
 *      `noMatch` to the after-hours greeting. Fixing (1) alone would not have
 *      helped: `{"is_open":true}` is not `"yes"` either.
 *   3. The flow had a `failed -> open_hours_greeting` fail-open transition,
 *      designed for exactly this. It never fired, because a 200 carrying a
 *      useless answer is not a failure. The HTTP widget logged `success` on all
 *      four executions Twilio retained.
 *
 * All four executions on record took the after-hours branch, two of them at
 * 14:01 on a Tuesday. The account holds ZERO queue resources, and Twilio creates
 * a queue on first `<Enqueue>`, which is independent proof that the press-3
 * live-connect path had never once executed.
 *
 * THE LESSON THAT SHAPES THIS FILE: none of the three breakages were invisible
 * because they were subtle. They were invisible because nothing could observe
 * them. A Studio flow has no test, no review, and no diff; the hours it depended
 * on lived in a console function nobody could see; and the one safety net it did
 * have was defeated by a successful HTTP response. So the rules here are pure
 * and unit-tested (`lib/businessHours.ts`), the greeting text is in source, and
 * every uncertain answer is logged rather than silently absorbed.
 *
 * ── HOURS ─────────────────────────────────────────────────────────────────────
 *
 * `business_settings/business_settings`, via `resolveBusinessOpenNow`. That is
 * the document the React admin's Business Hours editor writes, and it is the
 * first time the phone has read the operator's actual hours instead of a
 * hardcoded Mon-Fri 08:00-18:00. It also honours `companyHolidays` and notices
 * `specialHours`, neither of which the old handler had any concept of.
 *
 * ── PRESS 3 ───────────────────────────────────────────────────────────────────
 *
 * Press 3 currently takes a message. It is NOT yet a live connect, and that is
 * deliberate rather than unfinished: the screening path it used to reach is
 * verifiably non-functional on this account (no TwiML Application exists, and
 * the Voice SDK token endpoint 404s), so a caller pressing 3 could not have
 * reached a person even if the flow had let them try. Offering "talk to me now"
 * and then failing is worse than offering a message, so the greeting says what
 * actually happens. Restoring the live connect is the next change, and this
 * comment should be deleted with it.
 *
 * ── ROUTES ────────────────────────────────────────────────────────────────────
 *
 *   POST /           entry. Resolves hours, greets, gathers one digit.
 *   POST /route      the digit. 3 or 4 -> voicemail, anything else -> retry.
 *   POST /retry      one more chance during open hours, then the text nudge.
 *   POST /voicemail  <Record>, both callbacks wired.
 *   POST /goodbye    the text nudge, then hang up.
 *
 * ── ACTIVATION ────────────────────────────────────────────────────────────────
 *
 *   - Set the number's Voice "A CALL COMES IN" webhook (HTTP POST) to this
 *     function's public URL.
 *   - Set env `TWILIO_VOICE_BASE_URL` to that EXACT URL with no trailing slash.
 *     Signature validation hashes the full URL Twilio posted to, so this handler
 *     appends its own path to that base; any drift is a 403, which on a live
 *     call is a rejected caller.
 *   - `TWILIO_INBOUND_VOICEMAIL_URL` must already point at `twilioInboundVoicemail`;
 *     the `<Record>` below sends BOTH its transcription and its recording-status
 *     callbacks there.
 *   - Verifies with the existing `TWILIO_AUTH_TOKEN` secret, and FAILS CLOSED
 *     without it.
 */

const CALLS = 'calls_log';

/** Env naming this function's public root, with no trailing slash. */
const VOICE_BASE_ENV = 'TWILIO_VOICE_BASE_URL';

/** Env naming the voicemail callback target, already set for `twilioInboundVoicemail`. */
const VOICEMAIL_CALLBACK_ENV = 'TWILIO_INBOUND_VOICEMAIL_URL';

/**
 * The spoken lines, carried over verbatim from the flow that is being replaced,
 * so a caller who has phoned before hears the same words.
 *
 * The flow's blueprint doc describes six `.mp3` assets instead of these. There
 * are none: `auntieos-admin/twilio-service/assets/` is empty and all six URLs
 * 404. The live flow used text-to-speech, which is what actually reached
 * callers, so that is what is reproduced here.
 *
 * OPEN_GREETING is the one line that is NOT verbatim. The original offered
 * "press 3 to talk to me right now", which was never true on this account.
 */
const SPEECH = {
  OPEN_GREETING:
    "Hey, you've reached Tribe Tails Pet Care, this is Auntie's line. " +
    "I can't pick up live just yet, so press 3 or 4 to leave me a voicemail " +
    "and I'll get right back to you.",
  CLOSED_GREETING:
    "Hey, you've reached Tribe Tails Pet Care. We're closed right now. " +
    "If you'd like to leave me a voicemail, press 4. Or send a text to this " +
    "same number and I'll get back to you first thing.",
  RETRY: "Sorry, I didn't catch that. Press 4 to leave me a voicemail.",
  VOICEMAIL_PROMPT: 'Please leave your message after the beep, and press pound when you are finished.',
  VOICEMAIL_THANKS: "Got it, thank you. I'll listen to your message and get back to you soon. Bye now.",
  TEXT_NUDGE:
    'The quickest way to reach me is by text. Send a message to this same number ' +
    "and I'll get right back to you. Talk soon.",
} as const;

/** How long the caller has to press a key before the gather gives up. */
const GATHER_TIMEOUT_SECONDS = 8;

/** Matches the flow's Record Voicemail widgets: 3 minutes, `#` to finish. */
const VOICEMAIL_MAX_LENGTH_SECONDS = 180;

/**
 * XML-escape a value bound into TwiML.
 *
 * Every string this file interpolates is a constant today, so nothing here is
 * currently attacker-controlled. It is applied anyway because the next change
 * to this file is the screening path, which speaks a CALLER-SUPPLIED name back
 * into TwiML, and an escaping helper added at that point would be a fix rather
 * than a habit.
 */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Absolute URL for one of this function's own routes, for a TwiML `action`. */
function selfUrl(req: Request, path: string): string {
  const base = (process.env[VOICE_BASE_ENV] || '').trim().replace(/\/+$/, '');
  return base ? `${base}${path}` : `https://${req.hostname}${path}`;
}

function sendTwiml(res: Response, body: string): void {
  res.set('Content-Type', 'text/xml');
  res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);
}

function say(text: string): string {
  return `<Say>${xmlEscape(text)}</Say>`;
}

/**
 * A greeting plus a one-digit gather, falling through to `fallbackPath` when the
 * caller presses nothing.
 *
 * The `<Redirect>` after the `<Gather>` is not optional: TwiML continues to the
 * next verb when a gather times out, and a `<Response>` that ends after a
 * `<Gather>` hangs up on the caller without a word.
 */
function gatherOneDigit(req: Request, prompt: string, fallbackPath: string): string {
  return (
    `<Gather numDigits="1" timeout="${GATHER_TIMEOUT_SECONDS}" ` +
    `action="${xmlEscape(selfUrl(req, '/route'))}" method="POST">` +
    `${say(prompt)}` +
    `</Gather>` +
    `<Redirect method="POST">${xmlEscape(selfUrl(req, fallbackPath))}</Redirect>`
  );
}

/**
 * Records the inbound call server-side, from an authenticated Twilio request.
 *
 * Deliberately narrow. `twilioInboundCall` owns this document's status,
 * duration and recording URL, and PR #345 exists because a callback that
 * restated fields it had no news about erased the ones it did not. This writes
 * only what a call ARRIVING proves, and only when the key is absent, so it can
 * never overwrite a later status callback that has already landed.
 *
 * Fail-soft: a Firestore fault must not stop the greeting. A caller hearing
 * Twilio's "an application error has occurred" because a log write failed would
 * be a far worse outcome than an unlogged call.
 */
async function recordInboundCall(body: Record<string, string>, state: BusinessOpenState): Promise<void> {
  const sid = (body.CallSid || '').trim();
  if (!sid) return;
  const from = (body.From || '').trim();
  try {
    const ref = db().collection(CALLS).doc(sid);
    await db().runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      const stored = (snap.exists ? snap.data() : undefined) ?? {};
      const payload: Record<string, unknown> = {};
      const seeds: Record<string, unknown> = {
        direction: 'inbound',
        twilioCallSid: sid,
        timestamp: new Date().toISOString(),
        kinfolkId: null,
        kinfolkName: '',
        voicemailLogId: '',
        reconcileStatus: 'pending',
        reconciledAt: '',
        reconcileNotes: '',
      };
      if (from) seeds.counterpartNumber = from;
      for (const [key, value] of Object.entries(seeds)) {
        if (!(key in stored)) payload[key] = value;
      }
      if (Object.keys(payload).length === 0) return;
      txn.set(ref, payload, { merge: true });
    });
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'twilioVoice',
      event: 'twilioVoice.calls-log.error',
      extra: { sid, err: (err as Error)?.message, reason: state.reason },
    });
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function handleEntry(req: Request, res: Response, body: Record<string, string>): Promise<void> {
  const state = await resolveBusinessOpenNow(db(), Date.now());

  // Every uncertain answer is logged at a severity that will actually be
  // noticed. The failure this file replaces was silent for months precisely
  // because "we could not tell" looked exactly like "we are closed".
  logEvent({
    severity: state.reason === 'settings-unavailable' || state.reason === 'timezone-unusable' ? 'error' : 'info',
    function: 'twilioVoice',
    event: state.uncertain ? 'twilioVoice.hours.uncertain' : 'twilioVoice.hours.resolved',
    extra: {
      sid: (body.CallSid || '').trim(),
      open: state.open,
      reason: state.reason,
      dayName: state.dayName,
      localTime: state.localTimeHHmm,
      timeZone: state.timeZone,
    },
  });

  await recordInboundCall(body, state);

  sendTwiml(
    res,
    state.open
      ? gatherOneDigit(req, SPEECH.OPEN_GREETING, '/retry')
      : gatherOneDigit(req, SPEECH.CLOSED_GREETING, '/goodbye'),
  );
}

/**
 * The pressed digit.
 *
 * 3 and 4 both reach voicemail today. 3 is still accepted rather than dropped
 * because callers who have used this line before know it as the "talk to a
 * person" key, and refusing it would strand exactly the people most likely to
 * press it. When the live connect returns, 3 diverges here and nowhere else.
 */
function handleRoute(req: Request, res: Response, body: Record<string, string>): void {
  const digits = (body.Digits || '').trim();
  logEvent({
    severity: 'info',
    function: 'twilioVoice',
    event: 'twilioVoice.route',
    extra: { sid: (body.CallSid || '').trim(), digits },
  });
  if (digits === '3' || digits === '4') {
    sendTwiml(res, `<Redirect method="POST">${xmlEscape(selfUrl(req, '/voicemail'))}</Redirect>`);
    return;
  }
  sendTwiml(res, `<Redirect method="POST">${xmlEscape(selfUrl(req, '/retry'))}</Redirect>`);
}

/** One more chance, then the text nudge. A third round would just be a phone tree. */
function handleRetry(req: Request, res: Response): void {
  sendTwiml(res, gatherOneDigit(req, SPEECH.RETRY, '/goodbye'));
}

/**
 * The voicemail box.
 *
 * BOTH callbacks are set, and that is the point of this route existing rather
 * than being folded into `/route`. The Studio widget it replaces carried only
 * `transcribeCallback`, and Twilio's transcription callback has no
 * `RecordingDuration` field, so every voicemail this business has ever taken
 * landed in Firestore with `durationSec: 0`. `recordingStatusCallback` is the
 * only callback that carries the duration; `twilioInboundVoicemail` already
 * keys on `RecordingSid` and reads `RecordingDuration`, so it needs no change
 * to accept it.
 */
function handleVoicemail(req: Request, res: Response): void {
  const callback = (process.env[VOICEMAIL_CALLBACK_ENV] || '').trim();
  const recordAttrs = [
    `maxLength="${VOICEMAIL_MAX_LENGTH_SECONDS}"`,
    'playBeep="true"',
    'finishOnKey="#"',
    'trim="trim-silence"',
    'transcribe="true"',
  ];
  if (callback) {
    recordAttrs.push(`transcribeCallback="${xmlEscape(callback)}"`);
    recordAttrs.push(`recordingStatusCallback="${xmlEscape(callback)}"`);
    recordAttrs.push('recordingStatusCallbackEvent="completed"');
    recordAttrs.push('recordingStatusCallbackMethod="POST"');
  } else {
    // Loud, because a voicemail recorded with no callback is audio Twilio keeps
    // and this app never learns about. The caller still gets to leave it.
    logEvent({
      severity: 'error',
      function: 'twilioVoice',
      event: 'twilioVoice.voicemail.no-callback-url',
      extra: { env: VOICEMAIL_CALLBACK_ENV },
    });
  }
  sendTwiml(
    res,
    say(SPEECH.VOICEMAIL_PROMPT) +
      `<Record ${recordAttrs.join(' ')}/>` +
      say(SPEECH.VOICEMAIL_THANKS) +
      '<Hangup/>',
  );
}

function handleGoodbye(_req: Request, res: Response): void {
  sendTwiml(res, say(SPEECH.TEXT_NUDGE) + '<Hangup/>');
}

/**
 * One function, many paths.
 *
 * Split into five Cloud Functions this would be five cold starts inside one
 * phone call. Measured cold starts on this project's existing Twilio functions
 * run 6 to 8.5 seconds; Twilio's webhook timeout is 15. One warm instance
 * answers the whole call.
 */
export async function twilioVoiceHandler(req: Request, res: Response): Promise<void> {
  const body = await guardVoice(req, res, 'twilioVoice', VOICE_BASE_ENV);
  if (!body) return;

  const path = (req.path || '/').replace(/\/+$/, '') || '/';
  switch (path) {
    case '/':
      await handleEntry(req, res, body);
      return;
    case '/route':
      handleRoute(req, res, body);
      return;
    case '/retry':
      handleRetry(req, res);
      return;
    case '/voicemail':
      handleVoicemail(req, res);
      return;
    case '/goodbye':
      handleGoodbye(req, res);
      return;
    default:
      // An authenticated Twilio request for a path this handler does not serve
      // means a webhook somewhere points at a route that no longer exists. Say
      // something useful to the caller rather than letting Twilio play its own
      // error message, and log loudly enough to find the stale config.
      logEvent({
        severity: 'error',
        function: 'twilioVoice',
        event: 'twilioVoice.unknown-path',
        extra: { path, sid: (body.CallSid || '').trim() },
      });
      sendTwiml(res, say(SPEECH.TEXT_NUDGE) + '<Hangup/>');
  }
}

export const twilioVoice = onRequest(
  // 512MiB matches the other Twilio webhooks (PR #211) and for the same reason:
  // a full vCPU, and no retry budget worth gambling.
  //
  // minInstances: 1 is the addition, and it is a recurring cost rather than a
  // free tweak. It buys the greeting: a cold start here is 6 to 8.5 seconds of
  // silence after the caller hears ringing stop, against Twilio's 15s webhook
  // timeout. The Studio flow this replaces was always warm, so shipping without
  // it would be a regression a caller can hear.
  {
    region: 'us-central1',
    memory: '512MiB',
    minInstances: 1,
    secrets: ['TWILIO_AUTH_TOKEN', 'SENTRY_DSN'],
    ...FULL_CPU,
  },
  wrapHttp('twilioVoice', twilioVoiceHandler),
);
