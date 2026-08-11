import { onRequest, Request } from 'firebase-functions/v2/https';
import type { Response } from 'express';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapHttp } from '../lib/wrapHttp';
import { normalizeE164 } from '../lib/phoneNormalize';
import { sanitizePlainText } from '../lib/richText';
import { FULL_CPU } from '../lib/runtimeOptions';
// Signature verification and the POST/403 guard moved to twilioSignature.ts so
// the voice handler shares one implementation of these rules rather than
// growing a second, subtly different copy. Behaviour is unchanged; the
// describe.each guard battery in test/twilioInbound.test.ts still proves it
// through these three handlers.
import { guard } from './twilioSignature';

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
 * still written, so nothing is dropped and nothing is fabricated.
 *
 * BECAUSE A FAULT AND A GENUINE MISS ARE INDISTINGUISHABLE HERE, every caller
 * writes the result only on a HIT. A freshly created document gets
 * kinfolkId=null + reconcileStatus='pending' from its seeds; a document that
 * already carries a match keeps it, because a read that threw is not evidence
 * the kinfolk went away.
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

/** Respond with empty TwiML so Twilio does not auto-reply to the sender. */
function respondTwiml(res: Response): void {
  res.set('Content-Type', 'text/xml');
  res.status(200).send('<Response></Response>');
}

/**
 * Merge-write ONE Twilio callback onto its document, in one transaction.
 *
 * `asserted` is what the callback in hand actually says. `seeds` are the keys
 * that must EXIST on the document for a consumer to find it at all, but that
 * this handler must never restate once they are there.
 *
 * THE SEED IS PER KEY, NOT PER DOCUMENT, and the distinction is load-bearing:
 * a document that already exists but lacks `reconcileStatus` is invisible to
 * reconcile_comms.py's `.where('reconcileStatus','==','pending')` FOREVER, so
 * `if (!snap.exists)` would be the wrong test. Any writer that is not this
 * handler can leave that state behind (the e2e fixtures in
 * auntieos-admin/e2e/seed.rows.ts do exactly that today), and on calls_log the
 * FCM push does.
 *
 * One runTransaction, mirroring the android writer PR #344 landed and the call
 * handler PR #345 landed: the seed decision is taken from the document as it is
 * at write time, not from a read taken moments earlier that a concurrent
 * callback may already have moved past.
 */
async function writeCallback(
  collection: string,
  id: string,
  asserted: Record<string, unknown>,
  seeds: Record<string, unknown>,
): Promise<void> {
  const ref = db().collection(collection).doc(id);
  await db().runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const stored = (snap.exists ? snap.data() : undefined) ?? {};
    const payload: Record<string, unknown> = { ...asserted };
    for (const [key, value] of Object.entries(seeds)) {
      if (!(key in stored) && !(key in payload)) payload[key] = value;
    }
    // merge: everything this callback did not mention is left exactly as it is.
    txn.set(ref, payload, { merge: true });
  });
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
  const body = await guard(req, res, 'twilioInboundSms', 'TWILIO_INBOUND_SMS_URL');
  if (!body) return;

  const sid = (body.MessageSid || '').trim();
  if (!sid) {
    // Without a SID we cannot dedupe; reject rather than write a non-idempotent doc.
    logEvent({ severity: 'warn', function: 'twilioInboundSms', event: 'twilioInboundSms.no-sid' });
    res.status(400).json({ error: 'missing-MessageSid' });
    return;
  }

  // ONLY WHAT THIS CALLBACK ACTUALLY ASSERTS.
  //
  // One webhook is wired here (the number's "A MESSAGE COMES IN" URL), so the
  // second writer landing on sms_messages/{MessageSid} is Twilio itself. Its
  // retry policy retries "on any 5xx response from your web server", "on TCP
  // connect or TLS handshake failure" and "on no response received within read
  // timeout", up to 5 attempts. A retry is the SAME request replayed — same
  // MessageSid, same Body — so it carries NO new information, and the read
  // timeout is the ordinary case: reconcile claims and folds the message while
  // Twilio is still waiting, then the retry arrives and undoes it.
  //
  // Parameters Twilio documents for this request
  // (twilio.com/docs/messaging/guides/webhook-request): MessageSid, SmsSid,
  // SmsMessageSid, AccountSid, MessagingServiceSid, From, To, Body, NumMedia,
  // NumSegments, plus MediaContentType{N}/MediaUrl{N} and the From*/To* geo
  // fields. Nothing about the reconcile pipeline, the thread, or when the Inbox
  // should sort the message is in that list.
  //
  // WHO OWNS WHAT on sms_messages/{MessageSid}:
  //   counterpartNumber, body, mediaUrls — TWILIO owns them, and they are
  //                   written from the keys the request actually carries. A
  //                   request with no Body key is silent about the text, not
  //                   asserting the message was blank.
  //   threadId      — NOT this handler's. smsChannelMirror.findExistingThread
  //                   reads it off the inbound row to thread an operator's
  //                   reply, so restating '' on a retry unthreads the
  //                   conversation. Seeded once and then left alone.
  //   status        — 'received' is an invariant of THIS endpoint, not a guess:
  //                   every request reaching it is an inbound message that has
  //                   been received, and Twilio's own SmsStatus on it says
  //                   `received`. If the operator ever points the incoming
  //                   message STATUS callback (which reports `receiving` then
  //                   `received`, with no ordering guarantee) at this URL, this
  //                   is the line to revisit.
  //   reconcile*    — RECONCILE owns them after the seed. reconcile_comms.py
  //                   finds work with .where('reconcileStatus','==','pending')
  //                   and claims a doc by flipping pending -> in_progress in a
  //                   transaction. Restating 'pending' un-claims it mid-run and
  //                   lets a second worker fold the same SMS into the dossier
  //                   twice, and blanks the notes explaining an error result.
  const from = (body.From || '').trim();
  // Only look up a kinfolk when this request actually names a number, and write
  // the result only on a HIT: matchKinfolkByPhone is deliberately fail-soft, so
  // a transient kinfolk read fault on a retry returns a miss that would
  // otherwise erase a good match. reconcile_comms.py does the authoritative
  // last-10-digit match later and must not find its own work undone.
  const match = from ? await matchKinfolkByPhone(from) : null;
  const asserted: Record<string, unknown> = {
    direction: 'inbound',
    subType: 'sms',
    status: 'received',
    twilioMessageSid: sid,
  };
  if (from) asserted.counterpartNumber = from;
  if (match?.kinfolkId) {
    asserted.kinfolkId = match.kinfolkId;
    asserted.kinfolkName = match.kinfolkName;
  }
  // Key presence, not truthiness: an inbound MMS can legitimately carry an
  // empty Body, and `NumMedia: '0'` is a real statement that there is no media.
  if ('Body' in body) asserted.body = sanitizePlainText(body.Body || '');
  if ('NumMedia' in body) asserted.mediaUrls = collectMediaUrls(body);

  // Keys that must EXIST but must never be restated. `reconcileStatus` must, or
  // reconcile's equality query never sees the record; `timestamp` must, or the
  // Inbox's orderBy('timestamp') drops the row; `counterpartNumber` must, or
  // smsChannelMirror's counterpartNumber+timestamp thread lookup cannot see it.
  // The rest keep the android SmsMessage shape (Models.kt) for a fresh doc.
  const seeds: Record<string, unknown> = {
    counterpartNumber: '',
    body: '',
    mediaUrls: [],
    timestamp: nowIso(),
    kinfolkId: null,
    kinfolkName: '',
    threadId: '',
    reconcileStatus: 'pending',
    reconciledAt: '',
    reconcileNotes: '',
  };

  await writeCallback(SMS, sid, asserted, seeds);
  logEvent({ severity: 'info', function: 'twilioInboundSms', event: 'twilioInboundSms.wrote', extra: { sid } });
  respondTwiml(res);
}

// ---------------------------------------------------------------------------
// 2. Inbound voicemail transcription  ->  voicemails/{RecordingSid}
// ---------------------------------------------------------------------------
export async function twilioInboundVoicemailHandler(req: Request, res: Response): Promise<void> {
  const body = await guard(req, res, 'twilioInboundVoicemail', 'TWILIO_INBOUND_VOICEMAIL_URL');
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

  // ONLY WHAT THIS CALLBACK ACTUALLY ASSERTS.
  //
  // TWO DIFFERENT CALLBACKS land on this one document, and each is the sole
  // source of a field the other never mentions. Both parameter tables are on
  // twilio.com/docs/voice/twiml/record:
  //
  //   recordingStatusCallback
  //     AccountSid, CallSid, RecordingSid, RecordingUrl, RecordingStatus,
  //     RecordingDuration, RecordingChannels, RecordingStartTime,
  //     RecordingSource, RecordingTrack. It is the ONLY one carrying
  //     RecordingDuration, and it carries NO From, NO Caller and NO
  //     TranscriptionText.
  //
  //   transcribeCallback — "the standard TwiML request parameters as well as
  //     transcription specific ones": TranscriptionSid, TranscriptionText,
  //     TranscriptionStatus, TranscriptionUrl, RecordingSid, RecordingUrl,
  //     CallSid, AccountSid, From, To, CallStatus, ApiVersion, Direction,
  //     ForwardedFrom. It is the ONLY one carrying TranscriptionText, and there
  //     is NO RecordingDuration anywhere in that table.
  //
  // Twilio gives no ordering guarantee between separate webhook requests, so
  // whichever lands second must not speak for the first.
  //
  // WHO OWNS WHAT on voicemails/{RecordingSid}:
  //   transcript    — the TRANSCRIBE callback owns it, and only it. The
  //                   recording status callback has no TranscriptionText in its
  //                   parameter table at all, so `|| ''` turned that silence
  //                   into an erasure of the only copy of what the caller said.
  //                   A `TranscriptionStatus: failed` attempt carries no text
  //                   either, and a failed attempt is not a blank voicemail.
  //   durationSec   — the RECORDING status callback owns it, and only it. The
  //                   transcribe callback carries no duration, so `Number(...
  //                   || 0)` reported a 31-second voicemail as zero seconds.
  //   callerNumber  — the TRANSCRIBE callback owns it (From/Caller). A
  //                   recording callback naming no number is not evidence there
  //                   is no caller, and the kinfolk match hangs off it.
  //   audioUrl,
  //   twilioCallSid — TWILIO owns them; both callbacks carry RecordingUrl and
  //                   CallSid, so both may state them.
  //   replyStatus,
  //   repliedAt,
  //   replyLogId    — THE APP owns them and this handler never restates them.
  //                   An Auntie listens and replies (AuntieRepository
  //                   markVoicemailRead/markVoicemailReplied, and the web's
  //                   markVoicemail in api/inboxChannelsWrite.ts); restating
  //                   `replyStatus: 'unread'` on a late callback puts a handled
  //                   voicemail back in the unread queue and drops the link to
  //                   the reply that answered it.
  //   reconcile*    — RECONCILE owns them after the seed, exactly as on
  //                   calls_log (PR #345) and on the android side (PR #344).
  const caller = (body.From || body.Caller || '').trim();
  // Fail-soft means a miss is also what a transient kinfolk read fault returns,
  // so only a HIT is written — a fault on a later callback must not erase a
  // match an earlier one made. reconcile_comms.py matches authoritatively later.
  const match = caller ? await matchKinfolkByPhone(caller) : null;
  const asserted: Record<string, unknown> = { direction: 'inbound' };
  if (caller) asserted.callerNumber = caller;
  if (match?.kinfolkId) {
    asserted.kinfolkId = match.kinfolkId;
    asserted.kinfolkName = match.kinfolkName;
  }
  const transcript = sanitizePlainText(body.TranscriptionText || '').trim();
  if (transcript) asserted.transcript = transcript;
  const audioUrl = (body.RecordingUrl || '').trim();
  if (audioUrl) asserted.audioUrl = audioUrl;
  const callSid = (body.CallSid || '').trim();
  if (callSid) asserted.twilioCallSid = callSid;
  const durationRaw = (body.RecordingDuration || '').trim();
  if (durationRaw) {
    const duration = Number(durationRaw);
    if (Number.isFinite(duration)) asserted.durationSec = duration;
  }

  // Keys that must EXIST but must never be restated. `reconcileStatus` must, or
  // reconcile's equality query never sees the record; `timestamp` must, or the
  // Inbox's orderBy('timestamp') drops the row. The rest keep the android
  // VoicemailLog shape (Models.kt) for a freshly created document.
  const seeds: Record<string, unknown> = {
    callerNumber: '',
    transcript: '',
    audioUrl: '',
    durationSec: 0,
    twilioCallSid: '',
    timestamp: nowIso(),
    kinfolkId: null,
    kinfolkName: '',
    replyStatus: 'unread',
    repliedAt: '',
    replyLogId: '',
    reconcileStatus: 'pending',
    reconciledAt: '',
    reconcileNotes: '',
  };

  await writeCallback(VOICEMAILS, sid, asserted, seeds);
  logEvent({ severity: 'info', function: 'twilioInboundVoicemail', event: 'twilioInboundVoicemail.wrote', extra: { sid } });
  res.status(200).json({ ok: true });
}

// ---------------------------------------------------------------------------
// 3. Inbound call recording / status  ->  calls_log/{CallSid}
// ---------------------------------------------------------------------------
export async function twilioInboundCallHandler(req: Request, res: Response): Promise<void> {
  const body = await guard(req, res, 'twilioInboundCall', 'TWILIO_INBOUND_CALL_URL');
  if (!body) return;

  const sid = (body.CallSid || '').trim();
  if (!sid) {
    logEvent({ severity: 'warn', function: 'twilioInboundCall', event: 'twilioInboundCall.no-sid' });
    res.status(400).json({ error: 'missing-CallSid' });
    return;
  }

  // ONLY WHAT THIS CALLBACK ACTUALLY ASSERTS.
  //
  // Several callbacks land on this one document and they do NOT carry the same
  // fields. A callback that omits a field is SILENT about it; it is not saying
  // the field is empty, and turning that silence into `|| ''` erased another
  // writer's work. What each one carries, from Twilio's own parameter tables:
  //
  //   recordingStatusCallback (twilio.com/docs/voice/twiml/record)
  //     AccountSid, CallSid, RecordingSid, RecordingUrl, RecordingStatus,
  //     RecordingDuration, RecordingChannels, RecordingStartTime,
  //     RecordingSource, RecordingTrack. NO From/To, NO CallStatus, NO
  //     CallDuration. It is the ONLY callback carrying a <Record>-verb
  //     recording's URL.
  //
  //   call statusCallback (CallbackSource="call-progress-events")
  //     the full TwiML voice-request set (From, To, Caller, Called, Direction,
  //     CallStatus...) plus CallDuration, Timestamp and SequenceNumber.
  //     CallDuration is "only present in the completed event"; RecordingUrl
  //     appears here only in the completed event and only "if record is set on
  //     the <Dial>" — never for a <Record>-verb recording.
  //
  // Twilio on ordering: events "are made as separate HTTP requests, and there
  // is no guarantee they will arrive in the same order", so no field may depend
  // on which callback lands first.
  //
  // WHO OWNS WHAT on calls_log/{CallSid}:
  //   recordingUrl  — TWILIO owns it. Written only when a callback carries a
  //                   RecordingUrl. There is no second copy of that link on
  //                   this system, so a blank write loses the recording.
  //   transcript    — THE APP owns it, and this handler NEVER writes it. No
  //                   callback reaching this endpoint carries one
  //                   (TranscriptionText goes to twilioInboundVoicemail), so
  //                   the server has nothing to say about it. Do not re-add the
  //                   key: `transcript: ''` here wiped what the FCM push wrote
  //                   (AuntieRepository.upsertInboundCallLog), on every call.
  //   reconcile*    — RECONCILE owns them after the seed below. PR #344 settled
  //                   the same ownership question on the android side.
  const from = (body.From || '').trim();
  // Only look up a kinfolk when this callback actually names a number. A
  // callback that carries no From is not evidence there is no kinfolk.
  const match = from ? await matchKinfolkByPhone(from) : null;
  const asserted: Record<string, unknown> = {
    direction: 'inbound',
    twilioCallSid: sid,
  };
  if (from) asserted.counterpartNumber = from;
  // A miss writes nothing: reconcile_comms.py does the authoritative
  // last-10-digit match later and must not find its own work undone.
  if (match?.kinfolkId) {
    asserted.kinfolkId = match.kinfolkId;
    asserted.kinfolkName = match.kinfolkName;
  }
  const callStatus = (body.CallStatus || '').trim();
  // No `|| 'completed'` default: a recording callback carries no CallStatus,
  // and claiming "completed" would overwrite a real no-answer/busy/failed.
  if (callStatus) asserted.status = callStatus;
  const recordingUrl = (body.RecordingUrl || '').trim();
  if (recordingUrl) asserted.recordingUrl = recordingUrl;
  // Status callbacks send CallDuration, recording callbacks RecordingDuration.
  // Neither present means unknown, which is not the same fact as zero seconds.
  const durationRaw = (body.CallDuration || body.RecordingDuration || '').trim();
  if (durationRaw) {
    const duration = Number(durationRaw);
    if (Number.isFinite(duration)) asserted.durationSec = duration;
  }

  // Fields that must EXIST on the document but must never be restated:
  //   reconcileStatus/reconciledAt/reconcileNotes — reconcile_comms.py finds
  //     work with .where('reconcileStatus','==','pending') and claims a doc by
  //     flipping pending -> in_progress in a transaction. Restating 'pending'
  //     un-claims a doc mid-run and lets a second worker fold the same call
  //     into the dossier twice, and blanks the notes explaining an error.
  //   timestamp — the Inbox sorts on it; the first writer's value is the one
  //     that means anything, and nowIso() on every callback walks it forward.
  //   kinfolkId/kinfolkName/voicemailLogId — the android CallLog schema shape
  //     for a freshly created doc (nothing writes voicemailLogId yet).
  //
  // Seeded per KEY, not per document, and that distinction is load-bearing: the
  // FCM push creates calls_log/{CallSid} without a reconcileStatus, so seeding
  // only when the DOCUMENT is absent would leave every phone-first call
  // invisible to reconcile forever. See writeCallback above.
  const seeds: Record<string, unknown> = {
    timestamp: nowIso(),
    kinfolkId: null,
    kinfolkName: '',
    voicemailLogId: '',
    reconcileStatus: 'pending',
    reconciledAt: '',
    reconcileNotes: '',
  };

  await writeCallback(CALLS, sid, asserted, seeds);
  logEvent({ severity: 'info', function: 'twilioInboundCall', event: 'twilioInboundCall.wrote', extra: { sid } });
  res.status(200).json({ ok: true });
}

export const twilioInboundSms = onRequest(
  // 512MiB is deliberate and stays (PR #211). Twilio gives an inbound webhook
  // a 15s budget and retries on failure, and an exhausted retry is a lost
  // inbound message, so this keeps a full vCPU and 80-way concurrency.
  {
    region: 'us-central1',
    memory: '512MiB',
    secrets: ['TWILIO_AUTH_TOKEN', 'SENTRY_DSN'],
    ...FULL_CPU,
  },
  wrapHttp('twilioInboundSms', twilioInboundSmsHandler),
);

export const twilioInboundVoicemail = onRequest(
  // 512MiB is deliberate and stays (PR #211). See twilioInboundSms above.
  {
    region: 'us-central1',
    memory: '512MiB',
    secrets: ['TWILIO_AUTH_TOKEN', 'SENTRY_DSN'],
    ...FULL_CPU,
  },
  wrapHttp('twilioInboundVoicemail', twilioInboundVoicemailHandler),
);

export const twilioInboundCall = onRequest(
  // 512MiB is deliberate and stays (PR #211). See twilioInboundSms above.
  {
    region: 'us-central1',
    memory: '512MiB',
    secrets: ['TWILIO_AUTH_TOKEN', 'SENTRY_DSN'],
    ...FULL_CPU,
  },
  wrapHttp('twilioInboundCall', twilioInboundCallHandler),
);
