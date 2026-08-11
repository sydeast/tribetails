import { describe, it, expect, vi, beforeEach } from 'vitest';

// WARNING-8: server-authoritative inbound comms webhooks. Each handler must
// FAIL CLOSED when TWILIO_AUTH_TOKEN is unset (403), reject a bad signature
// (403) and non-POST (405), and on a valid signed request write the EXACT
// camelCase schema the Android client writes today — keyed by the Twilio SID so
// a retry upserts (idempotent), with reconcileStatus="pending" + a sortable
// timestamp so reconcile_comms.py and the Inbox readers keep working.

// --- in-memory Firestore double -------------------------------------------
// It records every set() AND applies it to a stored document with Firestore's
// real merge semantics, so a test can replay two Twilio callbacks in sequence
// and assert what the DOCUMENT ends up holding. Asserting only the payload of a
// single set() is what let `recordingUrl: body.RecordingUrl || ''` survive
// review: the payload looked fine in isolation, and the loss only appears when
// a second callback lands on the first one's document.
interface SetCall {
  collection: string;
  id: string;
  data: Record<string, unknown>;
  options: { merge?: boolean } | undefined;
  /** true when the write went through runTransaction rather than a bare set(). */
  viaTransaction: boolean;
}

// A kinfolk record returned by the phone-match query, keyed by the E.164 value
// that should match on `phoneNumber` (tests set this per-case). Empty => no match.
interface KinfolkRow {
  id: string;
  firstName?: string;
  lastName?: string;
  phoneNumber?: string;
  secondaryPhone?: string;
}

const mocks = vi.hoisted(() => ({
  sets: [] as SetCall[],
  // the stored documents, keyed `${collection}/${id}`
  docs: new Map<string, Record<string, unknown>>(),
  transactions: 0,
  validateRequest: vi.fn(),
  // rows the mocked kinfolk collection holds; matched by exact field equality
  kinfolk: [] as KinfolkRow[],
  // throw on the kinfolk query to exercise the fail-soft path
  kinfolkQueryThrows: false,
}));

vi.mock('../src/lib/firestoreAdmin', () => {
  const write = (
    collection: string,
    id: string,
    data: Record<string, unknown>,
    options: { merge?: boolean } | undefined,
    viaTransaction: boolean,
  ) => {
    mocks.sets.push({ collection, id, data, options, viaTransaction });
    const key = `${collection}/${id}`;
    const prior = mocks.docs.get(key);
    // merge:true leaves fields the payload does not mention alone; without it
    // the document is replaced wholesale. Same rule Firestore applies.
    mocks.docs.set(key, options?.merge && prior ? { ...prior, ...data } : { ...data });
  };
  const makeDocRef = (collection: string, id: string) => ({
    __collection: collection,
    __id: id,
    set: (data: Record<string, unknown>, options?: { merge?: boolean }) => {
      write(collection, id, data, options, false);
      return Promise.resolve();
    },
  });
  const snapshotOf = (collection: string, id: string) => {
    const stored = mocks.docs.get(`${collection}/${id}`);
    return { exists: stored !== undefined, data: () => (stored ? { ...stored } : undefined) };
  };
  type Ref = ReturnType<typeof makeDocRef>;
  return {
    db: () => ({
      collection: (collection: string) => {
        if (collection === 'kinfolk') {
          // Supports .where(field,'==',value).limit(n).get() used by the phone match.
          const makeQuery = (field: string, value: unknown) => ({
            limit: (_n: number) => ({
              get: () => {
                if (mocks.kinfolkQueryThrows) return Promise.reject(new Error('kinfolk read boom'));
                const hit = mocks.kinfolk.find((r) => r[field as keyof KinfolkRow] === value);
                return Promise.resolve({
                  empty: !hit,
                  docs: hit ? [{ id: hit.id, data: () => hit }] : [],
                });
              },
            }),
          });
          return {
            where: (field: string, _op: string, value: unknown) => makeQuery(field, value),
          };
        }
        return { doc: (id: string) => makeDocRef(collection, id) };
      },
      runTransaction: async <T>(fn: (txn: unknown) => Promise<T>): Promise<T> => {
        mocks.transactions += 1;
        return fn({
          get: (ref: Ref) => Promise.resolve(snapshotOf(ref.__collection, ref.__id)),
          set: (ref: Ref, data: Record<string, unknown>, options?: { merge?: boolean }) => {
            write(ref.__collection, ref.__id, data, options, true);
          },
        });
      },
    }),
  };
});

/** The document the handlers left behind, or undefined if none was written. */
function storedDoc(collection: string, id: string): Record<string, unknown> | undefined {
  return mocks.docs.get(`${collection}/${id}`);
}
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('twilio', () => ({
  default: { validateRequest: (...args: unknown[]) => mocks.validateRequest(...args) },
}));

beforeEach(() => {
  mocks.sets.length = 0;
  mocks.docs.clear();
  mocks.transactions = 0;
  mocks.validateRequest.mockReset();
  mocks.kinfolk.length = 0;
  mocks.kinfolkQueryThrows = false;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_INBOUND_SMS_URL;
  delete process.env.TWILIO_INBOUND_VOICEMAIL_URL;
  delete process.env.TWILIO_INBOUND_CALL_URL;
});

interface CapturedRes {
  status: number;
  body: Record<string, unknown> | null;
  text: string | null;
  ended: boolean;
  headers: Record<string, string>;
}
function captureRes(): { res: any; captured: CapturedRes } {
  const captured: CapturedRes = { status: 0, body: null, text: null, ended: false, headers: {} };
  const res: any = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(payload: Record<string, unknown>) {
      captured.body = payload;
      return res;
    },
    send(payload: string) {
      captured.text = payload;
      return res;
    },
    set(name: string, value: string) {
      captured.headers[name] = value;
      return res;
    },
    end() {
      captured.ended = true;
      return res;
    },
  };
  return { res, captured };
}

function makeReq(opts: { method?: string; headers?: Record<string, string>; body?: Record<string, string> } = {}): any {
  const headers = opts.headers ?? {};
  return {
    method: opts.method ?? 'POST',
    hostname: 'us-central1-test.cloudfunctions.net',
    originalUrl: '/twilioInbound',
    header: (name: string) => headers[name.toLowerCase()],
    body: opts.body ?? {},
  };
}

// Drive each of the three handlers through the same battery of guard tests.
const HANDLERS = [
  { name: 'twilioInboundSms', sidKey: 'MessageSid', collection: 'sms_messages' },
  { name: 'twilioInboundVoicemail', sidKey: 'RecordingSid', collection: 'voicemails' },
  { name: 'twilioInboundCall', sidKey: 'CallSid', collection: 'calls_log' },
] as const;

async function loadHandler(name: string) {
  const mod = await import('../src/twilio/twilioInbound');
  return (mod as Record<string, any>)[`${name}Handler`];
}

// --- REAL Twilio callback bodies -------------------------------------------
// Verbatim from Twilio's own parameter tables, not a hand-trimmed fixture. The
// point of these three is what they DO NOT contain:
//
//   RECORDING_STATUS_CALLBACK  — recordingStatusCallback on <Record>/<Dial>.
//     Parameters (twilio.com/docs/voice/twiml/record, /voice/api/call-resource):
//     AccountSid, CallSid, RecordingSid, RecordingUrl, RecordingStatus,
//     RecordingDuration, RecordingChannels, RecordingStartTime, RecordingSource,
//     RecordingTrack (+ ErrorCode / EncryptionDetails). There is NO From, NO To,
//     NO CallStatus and NO CallDuration in that list. It is the ONLY callback
//     that carries the recording of a <Record>-verb recording.
//
//   RINGING_STATUS_CALLBACK / COMPLETED_STATUS_CALLBACK — the call
//     statusCallback (CallbackSource="call-progress-events"). Carries the full
//     TwiML voice-request parameter set plus CallStatus, CallDuration
//     ("Only present in the completed event"), Timestamp and SequenceNumber.
//     RecordingUrl appears here ONLY in the completed event AND only "if record
//     is set on the <Dial>", never for a <Record>-verb recording.
//
// Twilio on ordering: "The order in which the events were fired, starting from
// 0. Although events are fired in order, they are made as separate HTTP
// requests, and there is no guarantee they will arrive in the same order."
// So neither arrival order can be assumed, and both are exercised below.
const CALL_SID = 'CA5987df4d600665d67f53e1bd4cec76d6';
const REC_URL = 'https://api.twilio.com/2010-04-01/Accounts/AC18d5/Recordings/REb719';
const CALLER = '+12015550123';

const RECORDING_STATUS_CALLBACK: Record<string, string> = {
  AccountSid: 'AC18d5c6f2003e8710de63b2f9c412b145',
  CallSid: CALL_SID,
  RecordingSid: 'REb719a56ceca43b2d06967983570e658a',
  RecordingUrl: REC_URL,
  RecordingStatus: 'completed',
  RecordingDuration: '42',
  RecordingChannels: '1',
  RecordingStartTime: 'Tue, 28 May 2019 02:18:02 +0000',
  RecordingSource: 'RecordVerb',
  RecordingTrack: 'both',
  ErrorCode: '0',
};

const RINGING_STATUS_CALLBACK: Record<string, string> = {
  AccountSid: 'AC18d5c6f2003e8710de63b2f9c412b145',
  ApiVersion: '2010-04-01',
  CallSid: CALL_SID,
  CallStatus: 'ringing',
  Called: '+12015550199',
  CalledCity: 'NEWARK',
  CalledCountry: 'US',
  CalledState: 'NJ',
  CalledZip: '07102',
  Caller: CALLER,
  CallerCity: 'NEWARK',
  CallerCountry: 'US',
  CallerState: 'NJ',
  CallerZip: '07102',
  Direction: 'inbound',
  From: CALLER,
  To: '+12015550199',
  CallbackSource: 'call-progress-events',
  SequenceNumber: '1',
  Timestamp: 'Tue, 28 May 2019 02:17:55 +0000',
  StirStatus: 'A',
};

const COMPLETED_STATUS_CALLBACK: Record<string, string> = {
  ...RINGING_STATUS_CALLBACK,
  CallStatus: 'completed',
  CallDuration: '42',
  SequenceNumber: '3',
  Timestamp: 'Tue, 28 May 2019 02:18:37 +0000',
};

// Only a call recorded via `record` on <Dial> puts the recording on the status
// callback as well. Kept separate so no test accidentally relies on a recording
// URL reaching the status callback when it would not.
const COMPLETED_STATUS_CALLBACK_WITH_RECORDING: Record<string, string> = {
  ...COMPLETED_STATUS_CALLBACK,
  RecordingUrl: REC_URL,
  RecordingSid: 'REb719a56ceca43b2d06967983570e658a',
  RecordingDuration: '42',
};

// --- REAL voicemail callback bodies ----------------------------------------
// TWO DIFFERENT CALLBACKS land on voicemails/{RecordingSid}, and the difference
// between them is the whole bug. Both tables are on twilio.com/docs/voice/twiml/record.
//
//   VOICEMAIL_RECORDING_CALLBACK — recordingStatusCallback. Parameters:
//     AccountSid, CallSid, RecordingSid, RecordingUrl, RecordingStatus,
//     RecordingDuration, RecordingChannels, RecordingStartTime, RecordingSource,
//     RecordingTrack. It is the ONLY one carrying RecordingDuration, and it
//     carries NO From, NO Caller and NO TranscriptionText.
//
//   VOICEMAIL_TRANSCRIPTION_CALLBACK — transcribeCallback, which Twilio
//     describes as carrying "the standard TwiML request parameters as well as
//     transcription specific ones": TranscriptionSid, TranscriptionText,
//     TranscriptionStatus, TranscriptionUrl, RecordingSid, RecordingUrl,
//     CallSid, AccountSid, From, To, CallStatus, ApiVersion, Direction,
//     ForwardedFrom. It is the ONLY one carrying TranscriptionText, and there is
//     NO RecordingDuration anywhere in that table.
//
// So each callback is the sole source of a field the other one never mentions:
// the recording callback owns the duration, the transcription callback owns the
// text and the caller's number. Neither may speak for the other, and Twilio
// guarantees no ordering between separate webhook requests, so both arrival
// orders are exercised below.
const VM_CALL_SID = 'CAaa1e6f7c9b3d4e5f8a0b1c2d3e4f5a6b';
const VM_REC_SID = 'RE9f2c4b8a1d6e3f5c7b9a0d2e4f6a8b1c';
const VM_REC_URL = 'https://api.twilio.com/2010-04-01/Accounts/AC18d5/Recordings/RE9f2c';
const VM_CALLER = '+12015550188';
const VM_TRANSCRIPT = 'Hi Auntie, it is Ada. Could we move Tuesday to Thursday please?';

const VOICEMAIL_RECORDING_CALLBACK: Record<string, string> = {
  AccountSid: 'AC18d5c6f2003e8710de63b2f9c412b145',
  CallSid: VM_CALL_SID,
  RecordingSid: VM_REC_SID,
  RecordingUrl: VM_REC_URL,
  RecordingStatus: 'completed',
  RecordingDuration: '31',
  RecordingChannels: '1',
  RecordingStartTime: 'Tue, 28 May 2019 02:18:02 +0000',
  RecordingSource: 'RecordVerb',
  RecordingTrack: 'both',
  ErrorCode: '0',
};

const VOICEMAIL_TRANSCRIPTION_CALLBACK: Record<string, string> = {
  TranscriptionSid: 'TR7d3e1a95c2b84f60ae1d7f2c8b9a0e34',
  TranscriptionText: VM_TRANSCRIPT,
  TranscriptionStatus: 'completed',
  TranscriptionUrl: 'https://api.twilio.com/2010-04-01/Accounts/AC18d5/Transcriptions/TR7d3e',
  RecordingSid: VM_REC_SID,
  RecordingUrl: VM_REC_URL,
  CallSid: VM_CALL_SID,
  AccountSid: 'AC18d5c6f2003e8710de63b2f9c412b145',
  From: VM_CALLER,
  To: '+12015550199',
  CallStatus: 'completed',
  ApiVersion: '2010-04-01',
  Direction: 'inbound',
};

// "The status of the transcription attempt: either `completed` or `failed`."
// A failed attempt produces no text — which is not a statement that the
// transcript is empty, still less a licence to erase one already stored.
const VOICEMAIL_FAILED_TRANSCRIPTION_CALLBACK: Record<string, string> = (() => {
  const { TranscriptionText: _drop, ...rest } = VOICEMAIL_TRANSCRIPTION_CALLBACK;
  return { ...rest, TranscriptionStatus: 'failed' };
})();

// --- REAL inbound SMS/MMS callback body ------------------------------------
// twilio.com/docs/messaging/guides/webhook-request: MessageSid, SmsSid,
// SmsMessageSid, AccountSid, MessagingServiceSid, From, To, Body, NumMedia,
// NumSegments (+ MediaContentType{N}/MediaUrl{N} and the From*/To* geo fields).
//
// Only ONE callback is wired here (the number's "A MESSAGE COMES IN" webhook),
// so the second writer is Twilio itself: the webhook retry policy retries "on
// any 5xx response from your web server", "on TCP connect or TLS handshake
// failure" and "on no response received within read timeout", up to 5 attempts,
// and a retry is the SAME request — same MessageSid, same body — replayed.
const SMS_SID = 'SM1a2b3c4d5e6f708192a3b4c5d6e7f809';
const SMS_FROM = '+12015550123';
const SMS_BODY = 'Can Auntie come Thursday instead of Tuesday?';

const INBOUND_SMS_CALLBACK: Record<string, string> = {
  MessageSid: SMS_SID,
  SmsSid: SMS_SID,
  SmsMessageSid: SMS_SID,
  AccountSid: 'AC18d5c6f2003e8710de63b2f9c412b145',
  MessagingServiceSid: 'MG9752274e9e519418a7406176694466fa',
  From: SMS_FROM,
  To: '+12015550199',
  Body: SMS_BODY,
  NumMedia: '0',
  NumSegments: '1',
  SmsStatus: 'received',
  ApiVersion: '2010-04-01',
  FromCity: 'NEWARK',
  FromState: 'NJ',
  FromZip: '07102',
  FromCountry: 'US',
  ToCity: '',
  ToState: 'NJ',
  ToZip: '',
  ToCountry: 'US',
};

describe.each(HANDLERS)('$name — guard (WARNING-8)', ({ name, sidKey }) => {
  it('FAILS CLOSED 403 when TWILIO_AUTH_TOKEN is unset', async () => {
    // token unset -> twilioVerify returns false WITHOUT consulting validateRequest
    const handler = await loadHandler(name);
    const { res, captured } = captureRes();
    await handler(makeReq({ headers: { 'x-twilio-signature': 'sig' }, body: { [sidKey]: 'SID1' } }), res);
    expect(captured.status).toBe(403);
    expect(mocks.validateRequest).not.toHaveBeenCalled();
    expect(mocks.sets.length).toBe(0);
  });

  it('REJECTS 403 on a bad signature', async () => {
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    mocks.validateRequest.mockReturnValue(false);
    const handler = await loadHandler(name);
    const { res, captured } = captureRes();
    await handler(makeReq({ headers: { 'x-twilio-signature': 'bad' }, body: { [sidKey]: 'SID1' } }), res);
    expect(captured.status).toBe(403);
    expect(mocks.sets.length).toBe(0);
  });

  it('REJECTS 405 on non-POST before any verification', async () => {
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    const handler = await loadHandler(name);
    const { res, captured } = captureRes();
    await handler(makeReq({ method: 'GET', body: { [sidKey]: 'SID1' } }), res);
    expect(captured.status).toBe(405);
    expect(mocks.validateRequest).not.toHaveBeenCalled();
  });

  it('passes the per-webhook env URL override to validateRequest', async () => {
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    const envName = name === 'twilioInboundSms'
      ? 'TWILIO_INBOUND_SMS_URL'
      : name === 'twilioInboundVoicemail'
        ? 'TWILIO_INBOUND_VOICEMAIL_URL'
        : 'TWILIO_INBOUND_CALL_URL';
    process.env[envName] = 'https://public.example.com/exact';
    mocks.validateRequest.mockReturnValue(true);
    const handler = await loadHandler(name);
    const { res } = captureRes();
    await handler(makeReq({ headers: { 'x-twilio-signature': 'sig' }, body: { [sidKey]: 'SID1' } }), res);
    // validateRequest(token, sig, url, params): the url arg is the env override.
    expect(mocks.validateRequest).toHaveBeenCalledWith('tok', 'sig', 'https://public.example.com/exact', expect.any(Object));
  });
});

describe('twilioInboundSms — valid signed request', () => {
  beforeEach(() => {
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    mocks.validateRequest.mockReturnValue(true);
  });

  it('writes sms_messages/{MessageSid} with the exact android schema', async () => {
    const handler = await loadHandler('twilioInboundSms');
    const { res, captured } = captureRes();
    // Twilio's documented inbound MMS body, not a hand-trimmed one.
    await handler(
      makeReq({
        headers: { 'x-twilio-signature': 'sig' },
        body: {
          ...INBOUND_SMS_CALLBACK,
          NumMedia: '2',
          MediaContentType0: 'image/jpeg',
          MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/AC18d5/Messages/SM1a2b/Media/ME01',
          MediaContentType1: 'image/png',
          MediaUrl1: 'https://api.twilio.com/2010-04-01/Accounts/AC18d5/Messages/SM1a2b/Media/ME02',
        },
      }),
      res,
    );
    expect(mocks.sets.length).toBe(1);
    const w = mocks.sets[0];
    expect(w.collection).toBe('sms_messages');
    expect(w.id).toBe(SMS_SID); // doc id == SID
    expect(w.options).toEqual({ merge: true });
    // The DOCUMENT, not one payload in isolation — asserting the payload alone
    // is how the write shape this file now guards survived review on calls_log.
    const stored = storedDoc('sms_messages', SMS_SID)!;
    expect(stored).toMatchObject({
      counterpartNumber: SMS_FROM, // phone in the right field
      direction: 'inbound',
      subType: 'sms',
      body: SMS_BODY,
      mediaUrls: [
        'https://api.twilio.com/2010-04-01/Accounts/AC18d5/Messages/SM1a2b/Media/ME01',
        'https://api.twilio.com/2010-04-01/Accounts/AC18d5/Messages/SM1a2b/Media/ME02',
      ],
      status: 'received',
      twilioMessageSid: SMS_SID,
      kinfolkId: null,
      kinfolkName: '',
      threadId: '',
      reconcileStatus: 'pending', // reconcile queries on this
      reconciledAt: '',
      reconcileNotes: '',
    });
    expect(typeof stored.timestamp).toBe('string');
    expect(stored.timestamp).not.toBe(''); // sortable ISO timestamp set
    // empty TwiML, text/xml, 200
    expect(captured.status).toBe(200);
    expect(captured.headers['Content-Type']).toBe('text/xml');
    expect(captured.text).toBe('<Response></Response>');
  });

  it('SEEDS an empty mediaUrls array when NumMedia is absent — and never re-blanks it', async () => {
    // REWRITTEN. This used to assert `mocks.sets[0].data.mediaUrls` equalled []
    // for a body with no NumMedia — i.e. that the handler manufactures "no
    // media" out of a request that never mentioned media, the same move that
    // blanked recordings and transcripts on calls_log. [] on a fresh document
    // is a SEED (the android SmsMessage shape wants the key); it is not a fact
    // a later silent request may restate.
    const handler = await loadHandler('twilioInboundSms');
    const { res } = captureRes();
    const { NumMedia: _drop, ...noNumMedia } = INBOUND_SMS_CALLBACK;
    await handler(makeReq({ headers: { 'x-twilio-signature': 'sig' }, body: noNumMedia }), res);
    expect(storedDoc('sms_messages', SMS_SID)).toMatchObject({ mediaUrls: [] });

    // Now a request that DOES carry media, then one that is silent about it.
    mocks.docs.clear();
    await handler(
      makeReq({
        headers: { 'x-twilio-signature': 'sig' },
        body: { ...INBOUND_SMS_CALLBACK, NumMedia: '1', MediaUrl0: 'https://m/0' },
      }),
      captureRes().res,
    );
    await handler(makeReq({ headers: { 'x-twilio-signature': 'sig' }, body: noNumMedia }), captureRes().res);
    expect(storedDoc('sms_messages', SMS_SID)).toMatchObject({ mediaUrls: ['https://m/0'] });
  });

  it('is idempotent: same MessageSid merge-upserts (no duplicate id)', async () => {
    const handler = await loadHandler('twilioInboundSms');
    const body = { From: '+1', Body: 'x', MessageSid: 'SMDUP' };
    await handler(makeReq({ headers: { 'x-twilio-signature': 'sig' }, body }), captureRes().res);
    await handler(makeReq({ headers: { 'x-twilio-signature': 'sig' }, body }), captureRes().res);
    expect(mocks.sets.length).toBe(2);
    expect(mocks.sets.every((s) => s.id === 'SMDUP')).toBe(true); // same doc id both times
    expect(mocks.sets.every((s) => s.options?.merge === true)).toBe(true);
  });

  it('400s (no write) when MessageSid is missing — cannot dedupe', async () => {
    const handler = await loadHandler('twilioInboundSms');
    const { res, captured } = captureRes();
    await handler(makeReq({ headers: { 'x-twilio-signature': 'sig' }, body: { From: '+1', Body: 'x' } }), res);
    expect(captured.status).toBe(400);
    expect(mocks.sets.length).toBe(0);
  });
});

describe('twilioInboundVoicemail — valid signed request', () => {
  beforeEach(() => {
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    mocks.validateRequest.mockReturnValue(true);
  });

  it('writes voicemails/{RecordingSid} with the exact android schema', async () => {
    // REWRITTEN. The old version drove a hand-trimmed body and asserted
    // `durationSec: 0` on the write payload — a request carrying no
    // RecordingDuration (the transcribe callback never does) reported as a
    // zero-second voicemail. That assertion pinned the defect rather than
    // guarding against it. The fixture is now Twilio's documented
    // transcribeCallback body, the assertion is on the stored DOCUMENT, and the
    // 0 is labelled as what it is: a seed, raised by the recording callback.
    const handler = await loadHandler('twilioInboundVoicemail');
    const { res, captured } = captureRes();
    await handler(makeReq({ headers: { 'x-twilio-signature': 'sig' }, body: VOICEMAIL_TRANSCRIPTION_CALLBACK }), res);
    expect(mocks.sets.length).toBe(1);
    const w = mocks.sets[0];
    expect(w.collection).toBe('voicemails');
    expect(w.id).toBe(VM_REC_SID);
    expect(w.options).toEqual({ merge: true });
    const stored = storedDoc('voicemails', VM_REC_SID)!;
    expect(stored).toMatchObject({
      callerNumber: VM_CALLER, // voicemails match by callerNumber
      transcript: VM_TRANSCRIPT,
      audioUrl: VM_REC_URL,
      direction: 'inbound',
      replyStatus: 'unread',
      twilioCallSid: VM_CALL_SID,
      durationSec: 0, // SEED only — see the ordering suite for the real 31
      kinfolkId: null,
      kinfolkName: '',
      repliedAt: '',
      replyLogId: '',
      reconcileStatus: 'pending',
      reconciledAt: '',
      reconcileNotes: '',
    });
    expect(stored.timestamp).not.toBe('');
    expect(captured.status).toBe(200);
    expect(captured.body).toMatchObject({ ok: true });
  });

  it('falls back to Caller when From is absent', async () => {
    const handler = await loadHandler('twilioInboundVoicemail');
    const { res } = captureRes();
    await handler(makeReq({ headers: { 'x-twilio-signature': 'sig' }, body: { Caller: '+1444', RecordingSid: 'RE9' } }), res);
    expect(mocks.sets[0].data.callerNumber).toBe('+1444');
  });

  it('is idempotent on RecordingSid', async () => {
    const handler = await loadHandler('twilioInboundVoicemail');
    const body = { From: '+1', RecordingSid: 'REDUP', RecordingUrl: 'u' };
    await handler(makeReq({ headers: { 'x-twilio-signature': 'sig' }, body }), captureRes().res);
    await handler(makeReq({ headers: { 'x-twilio-signature': 'sig' }, body }), captureRes().res);
    expect(mocks.sets.every((s) => s.id === 'REDUP' && s.options?.merge === true)).toBe(true);
  });

  it('400s (no write) when RecordingSid is missing', async () => {
    const handler = await loadHandler('twilioInboundVoicemail');
    const { res, captured } = captureRes();
    await handler(makeReq({ headers: { 'x-twilio-signature': 'sig' }, body: { From: '+1' } }), res);
    expect(captured.status).toBe(400);
    expect(mocks.sets.length).toBe(0);
  });
});

describe('twilioInboundCall — valid signed request', () => {
  beforeEach(() => {
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    mocks.validateRequest.mockReturnValue(true);
  });

  it('writes calls_log/{CallSid} with the exact android schema', async () => {
    const handler = await loadHandler('twilioInboundCall');
    const { res, captured } = captureRes();
    // A documented `completed` call status callback for a call recorded via
    // record on <Dial> — the one callback that carries BOTH the caller's number
    // and a RecordingUrl, so every schema field lands from a single request.
    await handler(makeReq({ headers: { 'x-twilio-signature': 'sig' }, body: COMPLETED_STATUS_CALLBACK_WITH_RECORDING }), res);
    expect(mocks.sets.length).toBe(1);
    const w = mocks.sets[0];
    expect(w.collection).toBe('calls_log');
    expect(w.id).toBe('CA5987df4d600665d67f53e1bd4cec76d6');
    expect(w.options).toEqual({ merge: true });
    const stored = storedDoc('calls_log', 'CA5987df4d600665d67f53e1bd4cec76d6')!;
    expect(stored).toMatchObject({
      counterpartNumber: '+12015550123', // calls match by counterpartNumber
      direction: 'inbound',
      status: 'completed',
      recordingUrl: 'https://api.twilio.com/2010-04-01/Accounts/AC18d5/Recordings/REb719',
      durationSec: 42, // Number(CallDuration)
      twilioCallSid: 'CA5987df4d600665d67f53e1bd4cec76d6',
      voicemailLogId: '',
      kinfolkId: null,
      kinfolkName: '',
      reconcileStatus: 'pending',
      reconciledAt: '',
      reconcileNotes: '',
    });
    expect(stored.timestamp).not.toBe('');
    // `transcript` is NOT in this list and that is deliberate: no callback
    // reaching this endpoint carries one, so the server never writes the field.
    expect(Object.prototype.hasOwnProperty.call(stored, 'transcript')).toBe(false);
    expect(captured.status).toBe(200);
    expect(captured.body).toMatchObject({ ok: true });
  });

  it('writes NO status and NO duration when the callback asserts neither', async () => {
    // A recording callback carries no CallStatus. Defaulting to "completed"
    // would state as fact something Twilio did not say — and would overwrite a
    // real `no-answer` (see the ordering suite below). A non-numeric duration
    // is likewise not a reason to claim the call lasted zero seconds.
    const handler = await loadHandler('twilioInboundCall');
    const { res } = captureRes();
    await handler(makeReq({ headers: { 'x-twilio-signature': 'sig' }, body: { From: '+12015550123', CallSid: 'CA0', RecordingDuration: 'notanumber' } }), res);
    const stored = storedDoc('calls_log', 'CA0')!;
    expect(Object.prototype.hasOwnProperty.call(stored, 'status')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(stored, 'durationSec')).toBe(false);
  });

  it('is idempotent on CallSid (merge-upsert)', async () => {
    const handler = await loadHandler('twilioInboundCall');
    const body = { From: '+1', CallSid: 'CADUP' };
    await handler(makeReq({ headers: { 'x-twilio-signature': 'sig' }, body }), captureRes().res);
    await handler(makeReq({ headers: { 'x-twilio-signature': 'sig' }, body }), captureRes().res);
    expect(mocks.sets.every((s) => s.id === 'CADUP' && s.options?.merge === true)).toBe(true);
  });

  it('400s (no write) when CallSid is missing', async () => {
    const handler = await loadHandler('twilioInboundCall');
    const { res, captured } = captureRes();
    await handler(makeReq({ headers: { 'x-twilio-signature': 'sig' }, body: { From: '+1' } }), res);
    expect(captured.status).toBe(400);
    expect(mocks.sets.length).toBe(0);
  });

  it('uses CallDuration when present (status callback)', async () => {
    const handler = await loadHandler('twilioInboundCall');
    const { res } = captureRes();
    await handler(makeReq({ headers: { 'x-twilio-signature': 'sig' }, body: { From: '+1', CallSid: 'CADUR', CallDuration: '17' } }), res);
    expect(mocks.sets[0].data.durationSec).toBe(17);
  });
});

describe('voicemail doc id falls back to CallSid', () => {
  beforeEach(() => {
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    mocks.validateRequest.mockReturnValue(true);
  });

  it('keys on CallSid when RecordingSid is absent (still idempotent)', async () => {
    const handler = await loadHandler('twilioInboundVoicemail');
    const { res, captured } = captureRes();
    await handler(makeReq({ headers: { 'x-twilio-signature': 'sig' }, body: { From: '+1', CallSid: 'CAVM', RecordingUrl: 'u' } }), res);
    expect(mocks.sets.length).toBe(1);
    expect(mocks.sets[0].collection).toBe('voicemails');
    expect(mocks.sets[0].id).toBe('CAVM');
    expect(captured.status).toBe(200);
  });

  it('400s only when BOTH RecordingSid and CallSid are absent', async () => {
    const handler = await loadHandler('twilioInboundVoicemail');
    const { res, captured } = captureRes();
    await handler(makeReq({ headers: { 'x-twilio-signature': 'sig' }, body: { From: '+1' } }), res);
    expect(captured.status).toBe(400);
    expect(mocks.sets.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Several callbacks, one calls_log document. A callback that does not mention a
// field is SILENT about it — it is not asserting the field is empty. Every case
// below replays real Twilio bodies in sequence and asserts what SURVIVED.
// ---------------------------------------------------------------------------
describe('twilioInboundCall — a later callback must not erase an earlier one', () => {
  beforeEach(() => {
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    mocks.validateRequest.mockReturnValue(true);
  });

  async function post(body: Record<string, string>) {
    const handler = await loadHandler('twilioInboundCall');
    const { res, captured } = captureRes();
    await handler(makeReq({ headers: { 'x-twilio-signature': 'sig' }, body }), res);
    return captured;
  }

  it('a status callback carrying no RecordingUrl does NOT erase the recording URL', async () => {
    // recordingStatusCallback lands the only link to the audio…
    await post(RECORDING_STATUS_CALLBACK);
    expect(storedDoc('calls_log', CALL_SID)).toMatchObject({ recordingUrl: REC_URL });
    // …then the call's own `completed` status callback arrives. It carries no
    // RecordingUrl (a <Record>-verb recording never appears on it), so it has
    // nothing to say about the recording and must leave it alone.
    await post(COMPLETED_STATUS_CALLBACK);
    expect(storedDoc('calls_log', CALL_SID)).toMatchObject({
      recordingUrl: REC_URL,
      status: 'completed',
      durationSec: 42,
    });
  });

  it('a recording callback arriving AFTER the status callback still lands the URL', async () => {
    // Twilio: events "are made as separate HTTP requests, and there is no
    // guarantee they will arrive in the same order". Neither order may lose.
    await post(COMPLETED_STATUS_CALLBACK);
    await post(RECORDING_STATUS_CALLBACK);
    expect(storedDoc('calls_log', CALL_SID)).toMatchObject({
      recordingUrl: REC_URL,
      status: 'completed',
      counterpartNumber: CALLER,
    });
  });

  it('a ringing status callback does not erase a recording URL or blank the duration', async () => {
    await post(RECORDING_STATUS_CALLBACK);
    await post(RINGING_STATUS_CALLBACK); // no CallDuration, no RecordingUrl
    expect(storedDoc('calls_log', CALL_SID)).toMatchObject({
      recordingUrl: REC_URL,
      durationSec: 42, // from RecordingDuration, not reset to 0
      status: 'ringing',
    });
  });

  it('NEVER writes `transcript` — the app owns that field', async () => {
    // The phone writes the push's transcript (AuntieRepository.upsertInboundCallLog).
    mocks.docs.set(`calls_log/${CALL_SID}`, {
      transcript: 'caller asked to move Tuesday to Thursday',
      counterpartNumber: CALLER,
      direction: 'inbound',
      status: 'ringing',
      timestamp: '2026-08-01T10:00:00.000Z',
    });
    await post(RECORDING_STATUS_CALLBACK);
    await post(COMPLETED_STATUS_CALLBACK);
    expect(storedDoc('calls_log', CALL_SID)).toMatchObject({
      transcript: 'caller asked to move Tuesday to Thursday',
    });
    // Not merely "wrote the same value back" — the key is never in a payload.
    for (const w of mocks.sets) {
      expect(Object.prototype.hasOwnProperty.call(w.data, 'transcript')).toBe(false);
    }
  });

  it('a recording callback (which carries no From) does not blank the caller or the kinfolk match', async () => {
    mocks.kinfolk.push({ id: 'kin1', firstName: 'Ada', lastName: 'Lovelace', phoneNumber: CALLER });
    await post(RINGING_STATUS_CALLBACK); // carries From -> matches kin1
    expect(storedDoc('calls_log', CALL_SID)).toMatchObject({
      counterpartNumber: CALLER,
      kinfolkId: 'kin1',
      kinfolkName: 'Ada Lovelace',
    });
    await post(RECORDING_STATUS_CALLBACK); // no From at all
    expect(storedDoc('calls_log', CALL_SID)).toMatchObject({
      counterpartNumber: CALLER,
      kinfolkId: 'kin1',
      kinfolkName: 'Ada Lovelace',
    });
  });

  it('a recording callback does not overwrite a real CallStatus with "completed"', async () => {
    await post({ ...RINGING_STATUS_CALLBACK, CallStatus: 'no-answer', SequenceNumber: '2' });
    await post(RECORDING_STATUS_CALLBACK); // carries RecordingStatus, never CallStatus
    expect(storedDoc('calls_log', CALL_SID)).toMatchObject({ status: 'no-answer' });
  });

  it('does not resurrect a reconciled call back to pending or wipe its notes', async () => {
    // reconcile_comms.py claims a doc by flipping pending -> in_progress inside
    // a transaction, then writes the outcome. Restating 'pending' un-claims it
    // and lets a second worker fold the same call into the dossier twice.
    mocks.docs.set(`calls_log/${CALL_SID}`, {
      counterpartNumber: CALLER,
      reconcileStatus: 'done',
      reconciledAt: '2026-08-02T09:00:00.000Z',
      reconcileNotes: 'folded into dossier kin1',
      timestamp: '2026-08-01T10:00:00.000Z',
    });
    await post(RECORDING_STATUS_CALLBACK);
    await post(COMPLETED_STATUS_CALLBACK);
    expect(storedDoc('calls_log', CALL_SID)).toMatchObject({
      reconcileStatus: 'done',
      reconciledAt: '2026-08-02T09:00:00.000Z',
      reconcileNotes: 'folded into dossier kin1',
    });
  });

  it('does not un-claim a doc reconcile has moved to in_progress', async () => {
    mocks.docs.set(`calls_log/${CALL_SID}`, {
      reconcileStatus: 'in_progress',
      reconcileClaimedAt: '2026-08-02T09:00:00.000Z',
    });
    await post(COMPLETED_STATUS_CALLBACK);
    expect(storedDoc('calls_log', CALL_SID)).toMatchObject({ reconcileStatus: 'in_progress' });
  });

  it('does not move the timestamp the first writer set', async () => {
    mocks.docs.set(`calls_log/${CALL_SID}`, { timestamp: '2026-08-01T10:00:00.000Z' });
    await post(COMPLETED_STATUS_CALLBACK);
    expect(storedDoc('calls_log', CALL_SID)).toMatchObject({ timestamp: '2026-08-01T10:00:00.000Z' });
  });

  it('SEEDS reconcileStatus + timestamp when the stored doc lacks them — including on a doc the phone created', async () => {
    // reconcile_comms.py finds work with .where('reconcileStatus','==','pending'),
    // so that key MUST exist. The phone's upsert never writes it, so seeding
    // only on a doc this handler created would leave phone-first calls invisible
    // to reconcile forever. The seed is per-KEY, not per-document.
    mocks.docs.set(`calls_log/${CALL_SID}`, {
      counterpartNumber: CALLER,
      direction: 'inbound',
      transcript: 'from the push',
      twilioCallSid: CALL_SID,
      status: 'ringing',
      timestamp: '2026-08-01T10:00:00.000Z',
    });
    await post(RECORDING_STATUS_CALLBACK);
    expect(storedDoc('calls_log', CALL_SID)).toMatchObject({
      reconcileStatus: 'pending',
      reconciledAt: '',
      reconcileNotes: '',
      timestamp: '2026-08-01T10:00:00.000Z', // seeded key added, existing one untouched
    });
  });

  it('reads and writes inside ONE transaction so a concurrent writer cannot be reverted', async () => {
    await post(RECORDING_STATUS_CALLBACK);
    expect(mocks.transactions).toBe(1);
    expect(mocks.sets.every((w) => w.viaTransaction)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Two callbacks, one voicemails document. The recording status callback and the
// transcribeCallback each carry a field the other never mentions, so whichever
// lands second used to erase the first one's work.
// ---------------------------------------------------------------------------
describe('twilioInboundVoicemail — a later callback must not erase an earlier one', () => {
  beforeEach(() => {
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    mocks.validateRequest.mockReturnValue(true);
  });

  async function post(body: Record<string, string>) {
    const handler = await loadHandler('twilioInboundVoicemail');
    const { res, captured } = captureRes();
    await handler(makeReq({ headers: { 'x-twilio-signature': 'sig' }, body }), res);
    return captured;
  }

  it('a recording status callback does NOT blank the transcript', async () => {
    // transcribeCallback is the ONLY source of TranscriptionText on this system.
    await post(VOICEMAIL_TRANSCRIPTION_CALLBACK);
    expect(storedDoc('voicemails', VM_REC_SID)).toMatchObject({ transcript: VM_TRANSCRIPT });
    // The recording status callback's parameter table has no TranscriptionText
    // in it at all, so it is silent about the transcript, not asserting it away.
    await post(VOICEMAIL_RECORDING_CALLBACK);
    expect(storedDoc('voicemails', VM_REC_SID)).toMatchObject({
      transcript: VM_TRANSCRIPT,
      audioUrl: VM_REC_URL,
      durationSec: 31,
    });
  });

  it('a transcription callback does NOT zero the duration', async () => {
    // The other order. RecordingDuration appears ONLY on the recording status
    // callback; the transcribeCallback table has no duration field, so
    // `Number(body.RecordingDuration || 0)` reported a 31-second voicemail as 0.
    await post(VOICEMAIL_RECORDING_CALLBACK);
    expect(storedDoc('voicemails', VM_REC_SID)).toMatchObject({ durationSec: 31 });
    await post(VOICEMAIL_TRANSCRIPTION_CALLBACK);
    expect(storedDoc('voicemails', VM_REC_SID)).toMatchObject({
      durationSec: 31,
      transcript: VM_TRANSCRIPT,
      callerNumber: VM_CALLER,
    });
  });

  it('a recording status callback (no From, no Caller) does not blank the caller or the kinfolk match', async () => {
    mocks.kinfolk.push({ id: 'kinVm', firstName: 'Ada', lastName: 'Lovelace', phoneNumber: VM_CALLER });
    await post(VOICEMAIL_TRANSCRIPTION_CALLBACK);
    expect(storedDoc('voicemails', VM_REC_SID)).toMatchObject({
      callerNumber: VM_CALLER,
      kinfolkId: 'kinVm',
      kinfolkName: 'Ada Lovelace',
    });
    await post(VOICEMAIL_RECORDING_CALLBACK);
    expect(storedDoc('voicemails', VM_REC_SID)).toMatchObject({
      callerNumber: VM_CALLER,
      kinfolkId: 'kinVm',
      kinfolkName: 'Ada Lovelace',
    });
  });

  it('a FAILED transcription attempt does not erase a transcript already stored', async () => {
    await post(VOICEMAIL_TRANSCRIPTION_CALLBACK);
    await post(VOICEMAIL_FAILED_TRANSCRIPTION_CALLBACK); // no TranscriptionText
    expect(storedDoc('voicemails', VM_REC_SID)).toMatchObject({ transcript: VM_TRANSCRIPT });
  });

  it('does not re-mark a replied voicemail unread or wipe the reply it points at', async () => {
    // replyStatus/repliedAt/replyLogId are the APP's: an Auntie listens, replies,
    // and the phone records which outbound log answered this voicemail. A late
    // Twilio callback restating `replyStatus: 'unread'` puts the voicemail back
    // in the unread queue and drops the link to the reply.
    mocks.docs.set(`voicemails/${VM_REC_SID}`, {
      callerNumber: VM_CALLER,
      replyStatus: 'replied',
      repliedAt: '2026-08-02T09:00:00.000Z',
      replyLogId: 'log_7742',
      timestamp: '2026-08-01T10:00:00.000Z',
    });
    await post(VOICEMAIL_RECORDING_CALLBACK);
    expect(storedDoc('voicemails', VM_REC_SID)).toMatchObject({
      replyStatus: 'replied',
      repliedAt: '2026-08-02T09:00:00.000Z',
      replyLogId: 'log_7742',
    });
  });

  it('does not resurrect a reconciled voicemail back to pending or wipe its notes', async () => {
    mocks.docs.set(`voicemails/${VM_REC_SID}`, {
      callerNumber: VM_CALLER,
      reconcileStatus: 'done',
      reconciledAt: '2026-08-02T09:00:00.000Z',
      reconcileNotes: 'folded into dossier kinVm',
      timestamp: '2026-08-01T10:00:00.000Z',
    });
    await post(VOICEMAIL_RECORDING_CALLBACK);
    await post(VOICEMAIL_TRANSCRIPTION_CALLBACK);
    expect(storedDoc('voicemails', VM_REC_SID)).toMatchObject({
      reconcileStatus: 'done',
      reconciledAt: '2026-08-02T09:00:00.000Z',
      reconcileNotes: 'folded into dossier kinVm',
    });
  });

  it('does not un-claim a voicemail reconcile has moved to in_progress', async () => {
    mocks.docs.set(`voicemails/${VM_REC_SID}`, { reconcileStatus: 'in_progress' });
    await post(VOICEMAIL_TRANSCRIPTION_CALLBACK);
    expect(storedDoc('voicemails', VM_REC_SID)).toMatchObject({ reconcileStatus: 'in_progress' });
  });

  it('does not move the timestamp the first writer set', async () => {
    mocks.docs.set(`voicemails/${VM_REC_SID}`, { timestamp: '2026-08-01T10:00:00.000Z' });
    await post(VOICEMAIL_RECORDING_CALLBACK);
    expect(storedDoc('voicemails', VM_REC_SID)).toMatchObject({ timestamp: '2026-08-01T10:00:00.000Z' });
  });

  it('a fail-soft kinfolk read error on a later callback does not wipe the match', async () => {
    mocks.kinfolk.push({ id: 'kinVm', firstName: 'Ada', lastName: 'Lovelace', phoneNumber: VM_CALLER });
    await post(VOICEMAIL_TRANSCRIPTION_CALLBACK);
    mocks.kinfolkQueryThrows = true;
    await post(VOICEMAIL_TRANSCRIPTION_CALLBACK); // Twilio retry; kinfolk read now throws
    expect(storedDoc('voicemails', VM_REC_SID)).toMatchObject({ kinfolkId: 'kinVm', kinfolkName: 'Ada Lovelace' });
  });

  it('SEEDS reconcileStatus + timestamp when the stored doc lacks them — including on a doc the phone created', async () => {
    // reconcile_comms.py finds work with .where('reconcileStatus','==','pending').
    // createInboundVoicemailLog on the phone can create the document first, so
    // the seed must be per-KEY: a per-document seed would leave every
    // phone-first voicemail invisible to reconcile forever.
    mocks.docs.set(`voicemails/${VM_REC_SID}`, {
      callerNumber: VM_CALLER,
      direction: 'inbound',
      transcript: 'from the push',
      timestamp: '2026-08-01T10:00:00.000Z',
    });
    await post(VOICEMAIL_RECORDING_CALLBACK);
    expect(storedDoc('voicemails', VM_REC_SID)).toMatchObject({
      reconcileStatus: 'pending',
      reconciledAt: '',
      reconcileNotes: '',
      replyStatus: 'unread',
      timestamp: '2026-08-01T10:00:00.000Z', // seeded key added, existing one untouched
      transcript: 'from the push', // and the push's transcript survives
    });
  });

  it('reads and writes inside ONE transaction so a concurrent writer cannot be reverted', async () => {
    await post(VOICEMAIL_RECORDING_CALLBACK);
    expect(mocks.transactions).toBe(1);
    expect(mocks.sets.every((w) => w.viaTransaction)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// One callback, one sms_messages document — and Twilio's own retry policy
// replaying it. A retry is not new information; it must not undo anything that
// happened between the first delivery and the replay.
// ---------------------------------------------------------------------------
describe('twilioInboundSms — a Twilio retry must not erase what happened since', () => {
  beforeEach(() => {
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    mocks.validateRequest.mockReturnValue(true);
  });

  async function post(body: Record<string, string>) {
    const handler = await loadHandler('twilioInboundSms');
    const { res, captured } = captureRes();
    await handler(makeReq({ headers: { 'x-twilio-signature': 'sig' }, body }), res);
    return captured;
  }

  it('does not resurrect a reconciled SMS back to pending or wipe its notes', async () => {
    // The read timeout is the ordinary case: reconcile_comms.py claims and folds
    // the message while Twilio is still waiting, then Twilio retries and the
    // handler restated `reconcileStatus: 'pending'` with blank notes over it.
    await post(INBOUND_SMS_CALLBACK);
    const stored = storedDoc('sms_messages', SMS_SID)!;
    expect(stored.reconcileStatus).toBe('pending');
    mocks.docs.set(`sms_messages/${SMS_SID}`, {
      ...stored,
      reconcileStatus: 'done',
      reconciledAt: '2026-08-02T09:00:00.000Z',
      reconcileNotes: 'folded into dossier kin1',
    });
    await post(INBOUND_SMS_CALLBACK); // byte-identical retry
    expect(storedDoc('sms_messages', SMS_SID)).toMatchObject({
      reconcileStatus: 'done',
      reconciledAt: '2026-08-02T09:00:00.000Z',
      reconcileNotes: 'folded into dossier kin1',
    });
  });

  it('does not un-claim an SMS reconcile has moved to in_progress', async () => {
    mocks.docs.set(`sms_messages/${SMS_SID}`, { reconcileStatus: 'in_progress' });
    await post(INBOUND_SMS_CALLBACK);
    expect(storedDoc('sms_messages', SMS_SID)).toMatchObject({ reconcileStatus: 'in_progress' });
  });

  it('does not move the timestamp the first delivery set', async () => {
    // The Inbox sorts on it. A retry seconds or minutes later is not a new
    // message and must not reorder the thread.
    mocks.docs.set(`sms_messages/${SMS_SID}`, { timestamp: '2026-08-01T10:00:00.000Z' });
    await post(INBOUND_SMS_CALLBACK);
    expect(storedDoc('sms_messages', SMS_SID)).toMatchObject({ timestamp: '2026-08-01T10:00:00.000Z' });
  });

  it('does not wipe the threadId something else assigned', async () => {
    await post(INBOUND_SMS_CALLBACK);
    mocks.docs.set(`sms_messages/${SMS_SID}`, { ...storedDoc('sms_messages', SMS_SID)!, threadId: 'thread_kin1' });
    await post(INBOUND_SMS_CALLBACK);
    expect(storedDoc('sms_messages', SMS_SID)).toMatchObject({ threadId: 'thread_kin1' });
  });

  it('a fail-soft kinfolk read error on the retry does not wipe the match', async () => {
    mocks.kinfolk.push({ id: 'kin1', firstName: 'Ada', lastName: 'Lovelace', phoneNumber: SMS_FROM });
    await post(INBOUND_SMS_CALLBACK);
    expect(storedDoc('sms_messages', SMS_SID)).toMatchObject({ kinfolkId: 'kin1' });
    mocks.kinfolkQueryThrows = true; // transient kinfolk read fault on the retry
    await post(INBOUND_SMS_CALLBACK);
    expect(storedDoc('sms_messages', SMS_SID)).toMatchObject({ kinfolkId: 'kin1', kinfolkName: 'Ada Lovelace' });
  });

  it('SEEDS reconcileStatus + timestamp when the stored doc lacks them — including on a doc the phone created', async () => {
    mocks.docs.set(`sms_messages/${SMS_SID}`, {
      counterpartNumber: SMS_FROM,
      direction: 'inbound',
      subType: 'sms',
      body: SMS_BODY,
      timestamp: '2026-08-01T10:00:00.000Z',
    });
    await post(INBOUND_SMS_CALLBACK);
    expect(storedDoc('sms_messages', SMS_SID)).toMatchObject({
      reconcileStatus: 'pending',
      reconciledAt: '',
      reconcileNotes: '',
      threadId: '',
      timestamp: '2026-08-01T10:00:00.000Z',
    });
  });

  it('reads and writes inside ONE transaction so a concurrent writer cannot be reverted', async () => {
    await post(INBOUND_SMS_CALLBACK);
    expect(mocks.transactions).toBe(1);
    expect(mocks.sets.every((w) => w.viaTransaction)).toBe(true);
  });
});

// Requirement 4: kinfolk match by phone (exact E.164), fail-soft on miss/error.
describe('kinfolk phone match (WARNING-8 req 4)', () => {
  beforeEach(() => {
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    mocks.validateRequest.mockReturnValue(true);
  });

  it('SMS: sets kinfolkId + kinfolkName on a phoneNumber match', async () => {
    // E.164 must be a valid number — libphonenumber rejects 555 exchanges, so
    // the stored kinfolk phone is normalized to the same value the inbound From
    // normalizes to.
    mocks.kinfolk.push({ id: 'kin1', firstName: 'Ada', lastName: 'Lovelace', phoneNumber: '+12015550123' });
    const handler = await loadHandler('twilioInboundSms');
    const { res } = captureRes();
    await handler(makeReq({ headers: { 'x-twilio-signature': 'sig' }, body: { From: '+12015550123', Body: 'hi', MessageSid: 'SMK' } }), res);
    expect(mocks.sets[0].data.kinfolkId).toBe('kin1');
    expect(mocks.sets[0].data.kinfolkName).toBe('Ada Lovelace');
  });

  it('matches even when inbound From is loosely formatted (normalized to E.164)', async () => {
    mocks.kinfolk.push({ id: 'kinFmt', firstName: 'Loose', lastName: 'Fmt', phoneNumber: '+12015550123' });
    const handler = await loadHandler('twilioInboundSms');
    const { res } = captureRes();
    // Twilio normally sends E.164, but prove the normalize step bridges any drift.
    await handler(makeReq({ headers: { 'x-twilio-signature': 'sig' }, body: { From: '(201) 555-0123', Body: 'hi', MessageSid: 'SMFMT' } }), res);
    expect(mocks.sets[0].data.kinfolkId).toBe('kinFmt');
  });

  it('call: matches on secondaryPhone too', async () => {
    mocks.kinfolk.push({ id: 'kin2', firstName: 'Grace', lastName: '', secondaryPhone: '+14155552671' });
    const handler = await loadHandler('twilioInboundCall');
    const { res } = captureRes();
    await handler(makeReq({ headers: { 'x-twilio-signature': 'sig' }, body: { From: '+14155552671', CallSid: 'CAK' } }), res);
    expect(mocks.sets[0].data.kinfolkId).toBe('kin2');
    expect(mocks.sets[0].data.kinfolkName).toBe('Grace');
  });

  it('no-match: kinfolkId null, kinfolkName empty, still writes + 200', async () => {
    const handler = await loadHandler('twilioInboundSms');
    const { res, captured } = captureRes();
    await handler(makeReq({ headers: { 'x-twilio-signature': 'sig' }, body: { From: '+15550000000', Body: 'x', MessageSid: 'SMNM' } }), res);
    expect(mocks.sets.length).toBe(1);
    expect(mocks.sets[0].data.kinfolkId).toBeNull();
    expect(mocks.sets[0].data.kinfolkName).toBe('');
    expect(captured.status).toBe(200);
  });

  it('fail-soft: kinfolk read error does NOT fail the webhook (still writes, 200)', async () => {
    mocks.kinfolkQueryThrows = true; // valid number so we reach the query, which throws
    const handler = await loadHandler('twilioInboundCall');
    const { res, captured } = captureRes();
    await handler(makeReq({ headers: { 'x-twilio-signature': 'sig' }, body: { From: '+12015550123', CallSid: 'CAERR' } }), res);
    expect(mocks.sets.length).toBe(1);
    // A failed lookup is not evidence there is no kinfolk, so it writes nothing
    // to kinfolkId — reconcile_comms.py does the authoritative match later.
    expect(storedDoc('calls_log', 'CAERR')).toMatchObject({ kinfolkId: null });
    expect(captured.status).toBe(200);
  });

  it('unparseable number: no match, no throw, still writes', async () => {
    const handler = await loadHandler('twilioInboundSms');
    const { res, captured } = captureRes();
    await handler(makeReq({ headers: { 'x-twilio-signature': 'sig' }, body: { From: 'not-a-number', Body: 'x', MessageSid: 'SMBAD' } }), res);
    expect(mocks.sets.length).toBe(1);
    expect(mocks.sets[0].data.kinfolkId).toBeNull();
    expect(captured.status).toBe(200);
  });
});
