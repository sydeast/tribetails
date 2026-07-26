import { onRequest, Request } from 'firebase-functions/v2/https';
import type { Response } from 'express';
import twilio from 'twilio';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapHttp } from '../lib/wrapHttp';
import { normalizeE164 } from '../lib/phoneNormalize';
import { sanitizePlainText } from '../lib/richText';

/**
 * WARNING-8: server-authoritative inbound comms writes.
 *
 * Today the ONLY writer of the inbound call / voicemail / SMS records
 * (`calls_log` / `voicemails` / `sms_messages`) is the Android client, which
 * persists them in response to UNAUTHENTICATED FCM data pushes. Those pushes are
 * spoofable, so any party able to send the app an FCM data message can forge an
 * inbound-comms record. The fix is to move the write server-side, behind a
 * Twilio-signature-verified webhook, so the record is created from Twilio's own
 * authenticated callback rather than a client reacting to an untrusted push.
 *
 * These three webhooks reproduce the EXACT camelCase schema the Android writers
 * use today (AuntieRepository.upsertInboundCallLog / createInboundVoicemailLog /
 * createInboundSmsLog; data classes CallLog / VoicemailLog / SmsMessage in
 * Models.kt), so the Inbox readers and the python reconcile pipeline
 * (reconcile_comms.py, which queries `.where('reconcileStatus','==','pending')`
 * and matches by phone) keep working unchanged.
 *
 * Each handler also attempts a best-effort kinfolk match by inbound phone
 * (exact E.164 equality on kinfolk.phoneNumber / kinfolk.secondaryPhone, the
 * same fields reconcile uses) and stamps kinfolkId + kinfolkName on a hit. A
 * miss leaves kinfolkId=null and NEVER fails the webhook — reconcile_comms.py
 * does the authoritative last-10-digit match afterward (see matchKinfolkByPhone).
 *
 * This is additive and safe: nothing routes traffic to these endpoints until the
 * operator points Twilio at them (see ACTIVATION below). Until then they receive
 * nothing, and the Android client keeps writing as-is. The client-write removal
 * is a SEPARATE, gated contract step to be done only AFTER the operator repoints
 * Twilio and verifies inbound records land server-side.
 *
 * ACTIVATION (operator-physical, Twilio-side reconfig + env):
 *   - twilioInboundSms: in the Twilio number's Messaging config, set the
 *     "A MESSAGE COMES IN" webhook (HTTP POST) to this function's public URL, and
 *     set env TWILIO_INBOUND_SMS_URL to that EXACT URL (signature validation
 *     hashes the URL Twilio posted to; any drift -> 403).
 *   - twilioInboundVoicemail: in the voicemail TwiML/Studio flow's <Record>,
 *     set transcribeCallback (or the Studio "Record Voicemail" widget's
 *     transcription callback) to this function's URL, and set env
 *     TWILIO_INBOUND_VOICEMAIL_URL to that EXACT URL.
 *   - twilioInboundCall: set the call's recording statusCallback (or the
 *     <Dial>/<Record> recordingStatusCallback / the call statusCallback) to this
 *     function's URL, and set env TWILIO_INBOUND_CALL_URL to that EXACT URL.
 *   - All three verify with the existing TWILIO_AUTH_TOKEN secret. With the token
 *     UNSET the handlers FAIL CLOSED (403) so a forged request can never be
 *     accepted before activation.
 */

const CALLS = 'calls_log';
const VOICEMAILS = 'voicemails';
const SMS = 'sms_messages';

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Best-effort kinfolk lookup by inbound phone number. On a hit returns
 * { kinfolkId, kinfolkName }; on a miss (or any read fault) returns
 * { kinfolkId: null, kinfolkName: '' } — the webhook NEVER fails on no-match,
 * because the python reconcile pipeline (reconcile_comms.py) does the
 * authoritative last-10-digit phone match later and folds the record into the
 * dossier regardless. We do a cheap, indexed *exact* E.164 equality query on
 * `kinfolk.phoneNumber` then `kinfolk.secondaryPhone` (the same two fields
 * reconcile uses), deliberately avoiding a full-collection scan in this public
 * hot path. kinfolkName mirrors reconcile's `firstName + lastName`.
 *
 * Fail-soft (not fail-loud) is correct HERE specifically: a no-match or a
 * transient kinfolk-read error must not 4xx/5xx Twilio (which would trigger
 * retries and, worse, lose the authenticated inbound record). The record is
 * still written with kinfolkId=null + reconcileStatus='pending', so nothing is
 * dropped and nothing is fabricated.
 */
async function matchKinfolkByPhone(
  rawNumber: string,
): Promise<{ kinfolkId: string | null; kinfolkName: string }> {
  const miss = { kinfolkId: null as string | null, kinfolkName: '' };
  let e164: string | null;
  try {
    e164 = normalizeE164(rawNumber);
  } catch {
    // Unparseable inbound number -> cannot exact-match; leave to reconcile.
    return miss;
  }
  if (!e164) return miss;
  try {
    for (const field of ['phoneNumber', 'secondaryPhone'] as const) {
      const snap = await db().collection('kinfolk').where(field, '==', e164).limit(1).get();
      if (!snap.empty) {
        const d = snap.docs[0].data() as Record<string, unknown>;
        const name = `${(d.firstName as string) ?? ''} ${(d.lastName as string) ?? ''}`.trim();
        return { kinfolkId: snap.docs[0].id, kinfolkName: name };
      }
    }
  } catch (err) {
    // Fail-soft: log loud but still write the record (kinfolkId stays null).
    logEvent({
      severity: 'warn',
      function: 'twilioInbound',
      event: 'twilioInbound.kinfolk-match.error',
      extra: { err: (err as Error)?.message },
    });
  }
  return miss;
}

/**
 * Verify a Twilio inbound webhook signature. Mirrors `twilioVerify` in
 * engagementWebhooks.ts: FAIL CLOSED when TWILIO_AUTH_TOKEN is unset (cannot
 * prove the request), then `twilio.validateRequest(token, X-Twilio-Signature,
 * fullUrl, params)`.
 *
 * Twilio signs the EXACT public URL it POSTs to, so behind Cloud Functions /
 * proxies the observed `req.hostname`+`originalUrl` can drift from what Twilio
 * hashed. We therefore prefer a per-webhook env override (urlEnv) set by the
 * operator to the exact public function URL, and only fall back to deriving the
 * absolute URL from the request when that env is unset.
 */
function twilioVerify(req: Request, urlEnv: string): boolean {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return false; // fail closed: cannot verify without the auth token
  const sig = req.header('X-Twilio-Signature') ?? '';
  const url = (process.env[urlEnv] || '').trim() || `https://${req.hostname}${req.originalUrl}`;
  const params = (req.body ?? {}) as Record<string, string>;
  try {
    return twilio.validateRequest(token, sig, url, params);
  } catch {
    return false;
  }
}

/** Respond with empty TwiML so Twilio does not auto-reply to the sender. */
function respondTwiml(res: Response): void {
  res.set('Content-Type', 'text/xml');
  res.status(200).send('<Response></Response>');
}

/**
 * Shared guard: 405 on non-POST, 403 on bad/unverifiable signature. Returns the
 * parsed form body when the request is authentic, else null (response sent).
 */
function guard(req: Request, res: Response, fn: string, urlEnv: string): Record<string, string> | null {
  if (req.method !== 'POST') {
    res.status(405).end();
    return null;
  }
  if (!twilioVerify(req, urlEnv)) {
    logEvent({ severity: 'warn', function: fn, event: `${fn}.verify.fail` });
    res.status(403).json({ error: 'bad-signature' });
    return null;
  }
  return (req.body ?? {}) as Record<string, string>;
}

/** Gather MediaUrl0..MediaUrlN from a Twilio inbound-SMS body into an array. */
function collectMediaUrls(body: Record<string, string>): string[] {
  const count = Number(body.NumMedia || 0);
  if (!Number.isFinite(count) || count <= 0) return [];
  const urls: string[] = [];
  for (let i = 0; i < count; i++) {
    const u = (body[`MediaUrl${i}`] || '').trim();
    if (u) urls.push(u);
  }
  return urls;
}

// ---------------------------------------------------------------------------
// 1. Inbound SMS / MMS  ->  sms_messages/{MessageSid}
// ---------------------------------------------------------------------------
export async function twilioInboundSmsHandler(req: Request, res: Response): Promise<void> {
  const body = guard(req, res, 'twilioInboundSms', 'TWILIO_INBOUND_SMS_URL');
  if (!body) return;

  const sid = (body.MessageSid || '').trim();
  if (!sid) {
    // Without a SID we cannot dedupe; reject rather than write a non-idempotent doc.
    logEvent({ severity: 'warn', function: 'twilioInboundSms', event: 'twilioInboundSms.no-sid' });
    res.status(400).json({ error: 'missing-MessageSid' });
    return;
  }

  const from = body.From || '';
  const match = await matchKinfolkByPhone(from);
  const doc = {
    counterpartNumber: from,
    direction: 'inbound',
    subType: 'sms',
    body: sanitizePlainText(body.Body || ''),
    mediaUrls: collectMediaUrls(body),
    timestamp: nowIso(),
    status: 'received',
    twilioMessageSid: sid,
    kinfolkId: match.kinfolkId,
    kinfolkName: match.kinfolkName,
    threadId: '',
    reconcileStatus: 'pending',
    reconciledAt: '',
    reconcileNotes: '',
  };

  // merge:true -> a Twilio retry with the same MessageSid upserts the same doc.
  await db().collection(SMS).doc(sid).set(doc, { merge: true });
  logEvent({ severity: 'info', function: 'twilioInboundSms', event: 'twilioInboundSms.wrote', extra: { sid } });
  respondTwiml(res);
}

// ---------------------------------------------------------------------------
// 2. Inbound voicemail transcription  ->  voicemails/{RecordingSid}
// ---------------------------------------------------------------------------
export async function twilioInboundVoicemailHandler(req: Request, res: Response): Promise<void> {
  const body = guard(req, res, 'twilioInboundVoicemail', 'TWILIO_INBOUND_VOICEMAIL_URL');
  if (!body) return;

  // Twilio's transcription callback always carries a RecordingSid; recording
  // status callbacks may carry only a CallSid. Prefer RecordingSid as the doc
  // id (stable across the two callbacks for one recording) and fall back to
  // CallSid so a recording-only callback still dedupes idempotently.
  const sid = (body.RecordingSid || '').trim() || (body.CallSid || '').trim();
  if (!sid) {
    logEvent({ severity: 'warn', function: 'twilioInboundVoicemail', event: 'twilioInboundVoicemail.no-sid' });
    res.status(400).json({ error: 'missing-RecordingSid-or-CallSid' });
    return;
  }

  const caller = body.From || body.Caller || '';
  const match = await matchKinfolkByPhone(caller);
  const durationRaw = Number(body.RecordingDuration || 0);
  const doc = {
    callerNumber: caller,
    transcript: sanitizePlainText(body.TranscriptionText || ''),
    audioUrl: body.RecordingUrl || '',
    direction: 'inbound',
    timestamp: nowIso(),
    replyStatus: 'unread',
    twilioCallSid: body.CallSid || '',
    durationSec: Number.isFinite(durationRaw) ? durationRaw : 0,
    kinfolkId: match.kinfolkId,
    kinfolkName: match.kinfolkName,
    repliedAt: '',
    replyLogId: '',
    reconcileStatus: 'pending',
    reconciledAt: '',
    reconcileNotes: '',
  };

  await db().collection(VOICEMAILS).doc(sid).set(doc, { merge: true });
  logEvent({ severity: 'info', function: 'twilioInboundVoicemail', event: 'twilioInboundVoicemail.wrote', extra: { sid } });
  res.status(200).json({ ok: true });
}

// ---------------------------------------------------------------------------
// 3. Inbound call recording / status  ->  calls_log/{CallSid}
// ---------------------------------------------------------------------------
export async function twilioInboundCallHandler(req: Request, res: Response): Promise<void> {
  const body = guard(req, res, 'twilioInboundCall', 'TWILIO_INBOUND_CALL_URL');
  if (!body) return;

  const sid = (body.CallSid || '').trim();
  if (!sid) {
    logEvent({ severity: 'warn', function: 'twilioInboundCall', event: 'twilioInboundCall.no-sid' });
    res.status(400).json({ error: 'missing-CallSid' });
    return;
  }

  const from = body.From || '';
  const match = await matchKinfolkByPhone(from);
  // Twilio call status callbacks send CallDuration; recording callbacks send
  // RecordingDuration. Accept either so the duration is populated whichever
  // callback fires.
  const durationRaw = Number(body.CallDuration || body.RecordingDuration || 0);
  const doc = {
    counterpartNumber: from,
    direction: 'inbound',
    status: body.CallStatus || 'completed',
    transcript: '',
    recordingUrl: body.RecordingUrl || '',
    durationSec: Number.isFinite(durationRaw) ? durationRaw : 0,
    timestamp: nowIso(),
    twilioCallSid: sid,
    voicemailLogId: '',
    kinfolkId: match.kinfolkId,
    kinfolkName: match.kinfolkName,
    reconcileStatus: 'pending',
    reconciledAt: '',
    reconcileNotes: '',
  };

  // merge-upsert: a recording callback and a later status callback for the same
  // CallSid converge on one doc rather than duplicating.
  await db().collection(CALLS).doc(sid).set(doc, { merge: true });
  logEvent({ severity: 'info', function: 'twilioInboundCall', event: 'twilioInboundCall.wrote', extra: { sid } });
  res.status(200).json({ ok: true });
}

export const twilioInboundSms = onRequest(
  { region: 'us-central1', secrets: ['TWILIO_AUTH_TOKEN', 'SENTRY_DSN'] },
  wrapHttp('twilioInboundSms', twilioInboundSmsHandler),
);

export const twilioInboundVoicemail = onRequest(
  { region: 'us-central1', secrets: ['TWILIO_AUTH_TOKEN', 'SENTRY_DSN'] },
  wrapHttp('twilioInboundVoicemail', twilioInboundVoicemailHandler),
);

export const twilioInboundCall = onRequest(
  { region: 'us-central1', secrets: ['TWILIO_AUTH_TOKEN', 'SENTRY_DSN'] },
  wrapHttp('twilioInboundCall', twilioInboundCallHandler),
);
