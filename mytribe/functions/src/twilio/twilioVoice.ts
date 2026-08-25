import { onRequest, Request } from 'firebase-functions/v2/https';
import type { Response } from 'express';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapHttp } from '../lib/wrapHttp';
import { FULL_CPU } from '../lib/runtimeOptions';
import { guardVoice } from './twilioSignature';
import { resolveBusinessOpenNow, type BusinessOpenState } from '../lib/businessHours';
import { sendCallInvitePush } from './voicePush';
import { getTwilio, getTwilioFromNumber } from '../lib/twilio';
import { sanitizePlainText } from '../lib/richText';

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
 * Press 3, during open hours, is a real live connect (landed in `8d09bf7`).
 * `/route` redirects to `/screen`, which gathers a spoken reason and hands off
 * to `/screen-connect`: `sendCallInvitePush` tells the operator's devices who
 * is calling over FCM, `dialOperator` places an outbound call to
 * `client:auntie`, and both legs are bridged in a `<Conference>` (:372-461).
 * If nobody is reachable (`push.delivered === 0 && !dialed`) or the operator
 * never picks up (`/screen-status` ends the conference on a no-answer
 * status), the caller falls through to `/missed` and then `/voicemail`. Press
 * 4, or anything outside open hours, goes straight to voicemail.
 *
 * ── ROUTES ────────────────────────────────────────────────────────────────────
 *
 *   POST /           entry. Resolves hours, greets, gathers one digit.
 *   POST /route      the digit. 3 during open hours -> /screen (live
 *                    connect); 4, or 3 outside open hours -> voicemail;
 *                    anything else -> retry.
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
 * OPEN_GREETING's "press 3 to talk to me right now" is true again as of
 * `8d09bf7`: press 3 is a live connect (see PRESS 3 above). Between this
 * file's creation and that commit, press 3 only took a message, and this
 * greeting's wording briefly did not promise a live connect for exactly that
 * reason. It reverted along with the fix.
 */
const SPEECH = {
  OPEN_GREETING:
    "Hey, you've reached Tribe Tails Pet Care, this is Auntie's line. " +
    'Press 3 to talk to me right now, or press 4 to leave me a voicemail.',
  /** Asked before ringing the operator, so she sees who it is before answering. */
  SCREEN_PROMPT:
    "Alright, after the tone, tell me your name and what you're calling about, " +
    "and I'll hop on the line.",
  HOLD: 'Just a moment, connecting you now.',
  MISSED:
    "I'm sorry I missed your call. To leave a voicemail, press 4. " +
    'Otherwise, have a wonderful day.',
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
 * The Twilio Client identity the admin app registers as. Must match
 * `CLIENT_IDENTITY` in `admin/mintVoiceAccessToken.ts`: that file mints the
 * token for this name and this file dials it, so a change in one without the
 * other rings an identity nobody is registered as, which fails as SILENCE
 * rather than as an error.
 */
const OPERATOR_CLIENT_IDENTITY = 'auntie';

/**
 * How long the operator's phone rings before the caller is released to the
 * missed-call path. Deliberately shorter than the 55s the retired service used:
 * a caller who has already said their name is listening to hold music the whole
 * time, and a minute of it reads as an abandoned line.
 */
const OPERATOR_RING_SECONDS = 30;

/** One block of hold audio. Twilio re-requests the wait URL until the wait ends. */
const HOLD_PAUSE_SECONDS = 15;

/**
 * Call statuses that mean the operator never picked up. `completed` is
 * deliberately ABSENT: it fires when a call she DID take ends normally, and
 * ending the conference on it would be a no-op at best and a race at worst.
 */
const UNANSWERED_STATUSES = new Set(['no-answer', 'busy', 'failed', 'canceled']);

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
 * 3 is the live connect, and it is only offered during open hours: the
 * after-hours greeting never mentions it, so a 3 pressed then falls to the
 * retry rather than ringing the operator at midnight.
 */
function handleRoute(req: Request, res: Response, body: Record<string, string>, open: boolean): void {
  const digits = (body.Digits || '').trim();
  logEvent({
    severity: 'info',
    function: 'twilioVoice',
    event: 'twilioVoice.route',
    extra: { sid: (body.CallSid || '').trim(), digits, open },
  });
  if (digits === '3' && open) {
    sendTwiml(res, `<Redirect method="POST">${xmlEscape(selfUrl(req, '/screen'))}</Redirect>`);
    return;
  }
  if (digits === '4') {
    sendTwiml(res, `<Redirect method="POST">${xmlEscape(selfUrl(req, '/voicemail'))}</Redirect>`);
    return;
  }
  sendTwiml(res, `<Redirect method="POST">${xmlEscape(selfUrl(req, '/retry'))}</Redirect>`);
}

/** The conference a screened call is bridged in. One per inbound call. */
export function conferenceName(callSid: string): string {
  return `conf_${callSid}`;
}

/**
 * Ask who is calling, so the operator can decide before answering.
 *
 * Speech, not digits: the answer is read aloud on her phone. `speechTimeout`
 * is "auto" so a caller who pauses mid-sentence is not cut off.
 */
function handleScreen(req: Request, res: Response): void {
  sendTwiml(
    res,
    `<Gather input="speech" speechTimeout="auto" timeout="6" ` +
      `action="${xmlEscape(selfUrl(req, '/screen-connect'))}" method="POST">` +
      say(SPEECH.SCREEN_PROMPT) +
      `</Gather>` +
      // A caller who says nothing still gets a voicemail box rather than a
      // hangup. Saying nothing is not the same as wanting nothing.
      `<Redirect method="POST">${xmlEscape(selfUrl(req, '/voicemail'))}</Redirect>`,
  );
}

/**
 * Ring the operator, and park the caller in a conference while she decides.
 *
 * ── WHY A CONFERENCE AND NOT A QUEUE ──────────────────────────────────────────
 *
 * The Studio flow this replaces used `<Enqueue>` and then REST-injected new
 * TwiML onto the caller's live call to yank them out of the queue and into a
 * conference. Two mechanisms fighting over one leg, which is where its race
 * conditions came from: on a reject the caller could still be in the queue,
 * never having entered the conference, so ending the conference did nothing.
 *
 * Here the caller goes straight into the conference as a non-moderator and
 * hears hold music. The operator's leg joins as the moderator, and her joining
 * is what starts it. That gives the missed-call path for free: when the
 * conference ends, or never starts, this `<Dial>` verb simply COMPLETES and
 * TwiML continues to the next verb. No injection, no queue, no race.
 */
async function handleScreenConnect(
  req: Request,
  res: Response,
  body: Record<string, string>,
): Promise<void> {
  const sid = (body.CallSid || '').trim();
  const from = (body.From || '').trim();
  const transcript = sanitizePlainText(body.SpeechResult || '').trim();
  const conference = conferenceName(sid);

  // Tell the operator's phone who is calling. Fail-soft: this never throws, and
  // an undelivered push is logged as an outage rather than dropping the caller.
  const push = await sendCallInvitePush({ callSid: sid, callerNumber: from, transcript });

  const dialed = await dialOperator(req, sid, conference);

  // Nobody was told AND nobody was rung: holding the caller would be a lie.
  if (push.delivered === 0 && !dialed) {
    logEvent({
      severity: 'error',
      function: 'twilioVoice',
      event: 'twilioVoice.screen.unreachable',
      extra: { sid },
    });
    sendTwiml(res, `<Redirect method="POST">${xmlEscape(selfUrl(req, '/voicemail'))}</Redirect>`);
    return;
  }

  sendTwiml(
    res,
    `<Dial><Conference startConferenceOnEnter="false" endConferenceOnExit="false" beep="false" ` +
      `waitUrl="${xmlEscape(selfUrl(req, '/hold'))}" waitMethod="POST">` +
      `${xmlEscape(conference)}</Conference></Dial>` +
      // Reached when the conference ends or never starts: rejected, missed, or
      // hung up on her side. The caller is still on the line.
      `<Redirect method="POST">${xmlEscape(selfUrl(req, '/missed'))}</Redirect>`,
  );
}

/**
 * Places the outbound leg to the operator's registered Voice SDK client.
 *
 * Returns false rather than throwing: a Twilio API fault must not cost the
 * caller their call, and `handleScreenConnect` needs to know so it can fall
 * back to voicemail instead of parking them in a conference nobody will join.
 */
async function dialOperator(req: Request, callSid: string, conference: string): Promise<boolean> {
  try {
    const client = await getTwilio();
    await client.calls.create({
      to: `client:${OPERATOR_CLIENT_IDENTITY}`,
      from: getTwilioFromNumber(),
      url: `${selfUrl(req, '/connect')}?conference=${encodeURIComponent(conference)}`,
      method: 'POST',
      statusCallback: `${selfUrl(req, '/screen-status')}?conference=${encodeURIComponent(conference)}`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['no-answer', 'busy', 'failed', 'canceled', 'completed'],
      timeout: OPERATOR_RING_SECONDS,
    });
    return true;
  } catch (err) {
    logEvent({
      severity: 'error',
      function: 'twilioVoice',
      event: 'twilioVoice.screen.dial-failed',
      extra: { sid: callSid, err: (err as Error)?.message },
    });
    return false;
  }
}

/**
 * The operator's leg. She is the moderator: her arrival starts the conference
 * and her departure ends it, which drops the caller to `/missed`.
 */
function handleConnect(req: Request, res: Response): void {
  const conference = String(req.query?.conference ?? '').trim();
  if (!conference) {
    logEvent({
      severity: 'error',
      function: 'twilioVoice',
      event: 'twilioVoice.connect.no-conference',
    });
    sendTwiml(res, '<Hangup/>');
    return;
  }
  sendTwiml(
    res,
    `<Dial><Conference startConferenceOnEnter="true" endConferenceOnExit="true" beep="false">` +
      `${xmlEscape(conference)}</Conference></Dial>`,
  );
}

/**
 * Hold music. Twilio requests this repeatedly for as long as the caller waits,
 * so it does not need to loop itself.
 */
function handleHold(_req: Request, res: Response): void {
  sendTwiml(res, say(SPEECH.HOLD) + `<Pause length="${HOLD_PAUSE_SECONDS}"/>`);
}

/**
 * The operator did not pick up. Ends the conference so the caller's `<Dial>`
 * completes and they fall through to `/missed` instead of holding forever.
 */
async function handleScreenStatus(req: Request, res: Response, body: Record<string, string>): Promise<void> {
  const status = (body.CallStatus || '').trim();
  const conference = String(req.query?.conference ?? '').trim();
  if (!UNANSWERED_STATUSES.has(status) || !conference) {
    res.status(200).json({ ok: true });
    return;
  }
  await endConference(conference, `status:${status}`);
  res.status(200).json({ ok: true });
}

/**
 * Ends a conference by name, which releases every leg still in it.
 *
 * Fail-soft and idempotent: a conference that already ended, or never started
 * because the operator never answered, is not an error. Twilio answers 404 for
 * both and there is nothing to do about either.
 */
export async function endConference(conference: string, reason: string): Promise<boolean> {
  try {
    const client = await getTwilio();
    const found = await client.conferences.list({ friendlyName: conference, status: 'in-progress', limit: 1 });
    const target = found[0];
    if (!target) return false;
    await client.conferences(target.sid).update({ status: 'completed' });
    logEvent({
      severity: 'info',
      function: 'twilioVoice',
      event: 'twilioVoice.conference.ended',
      extra: { conference, reason },
    });
    return true;
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'twilioVoice',
      event: 'twilioVoice.conference.end-failed',
      extra: { conference, reason, err: (err as Error)?.message },
    });
    return false;
  }
}

/** One more chance at a voicemail after a call the operator did not take. */
function handleMissed(req: Request, res: Response): void {
  sendTwiml(
    res,
    `<Gather numDigits="1" timeout="${GATHER_TIMEOUT_SECONDS}" ` +
      `action="${xmlEscape(selfUrl(req, '/route'))}" method="POST">` +
      say(SPEECH.MISSED) +
      `</Gather>` +
      `<Redirect method="POST">${xmlEscape(selfUrl(req, '/goodbye'))}</Redirect>`,
  );
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
    case '/route': {
      // Hours are resolved again rather than carried from the greeting. It is
      // one extra read per keypress, and it means a 3 pressed after closing
      // time cannot ring the operator because the caller was mid-call when the
      // business shut.
      const state = await resolveBusinessOpenNow(db(), Date.now());
      handleRoute(req, res, body, state.open);
      return;
    }
    case '/retry':
      handleRetry(req, res);
      return;
    case '/screen':
      handleScreen(req, res);
      return;
    case '/screen-connect':
      await handleScreenConnect(req, res, body);
      return;
    case '/connect':
      handleConnect(req, res);
      return;
    case '/hold':
      handleHold(req, res);
      return;
    case '/screen-status':
      await handleScreenStatus(req, res, body);
      return;
    case '/missed':
      handleMissed(req, res);
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
    // TWILIO_ACCOUNT_SID + TWILIO_FROM_NUMBER are for the OUTBOUND leg that
    // rings the operator; AUNTIE_OPERATOR_UIDS lets the push sender resolve the
    // admin roster when businessSettings/admins has not been seeded yet.
    // Without that binding it reads as undefined and resolveBusinessAdminUids
    // throws, which this file turns into a logged outage rather than a dropped
    // call, but the caller still loses the live connect.
    secrets: [
      'TWILIO_AUTH_TOKEN',
      'TWILIO_ACCOUNT_SID',
      'TWILIO_FROM_NUMBER',
      'AUNTIE_OPERATOR_UIDS',
      'SENTRY_DSN',
    ],
    ...FULL_CPU,
  },
  wrapHttp('twilioVoice', twilioVoiceHandler),
);
