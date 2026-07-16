import { describe, it, expect, vi, beforeEach } from 'vitest';

// WARNING-8: server-authoritative inbound comms webhooks. Each handler must
// FAIL CLOSED when TWILIO_AUTH_TOKEN is unset (403), reject a bad signature
// (403) and non-POST (405), and on a valid signed request write the EXACT
// camelCase schema the Android client writes today — keyed by the Twilio SID so
// a retry upserts (idempotent), with reconcileStatus="pending" + a sortable
// timestamp so reconcile_comms.py and the Inbox readers keep working.

// --- in-memory Firestore double: records set() calls keyed by collection/id ---
interface SetCall {
  collection: string;
  id: string;
  data: Record<string, unknown>;
  options: { merge?: boolean } | undefined;
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
  validateRequest: vi.fn(),
  // rows the mocked kinfolk collection holds; matched by exact field equality
  kinfolk: [] as KinfolkRow[],
  // throw on the kinfolk query to exercise the fail-soft path
  kinfolkQueryThrows: false,
}));

vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({
    collection: (collection: string) => {
      if (collection === 'kinfolk') {
        // Supports .where(field,'==',value).limit(n).get() used by the phone match.
        const makeQuery = (field: string, value: unknown) => ({
          limit: (_n: number) => ({
            get: () => {
              if (mocks.kinfolkQueryThrows) return Promise.reject(new Error('kinfolk read boom'));
              const hit = mocks.kinfolk.find((r) => (r as Record<string, unknown>)[field] === value);
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
      return {
        doc: (id: string) => ({
          set: (data: Record<string, unknown>, options?: { merge?: boolean }) => {
            mocks.sets.push({ collection, id, data, options });
            return Promise.resolve();
          },
        }),
      };
    },
  }),
}));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('twilio', () => ({
  default: { validateRequest: (...args: unknown[]) => mocks.validateRequest(...args) },
}));

beforeEach(() => {
  mocks.sets.length = 0;
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
    await handler(
      makeReq({
        headers: { 'x-twilio-signature': 'sig' },
        body: { From: '+15551234567', To: '+15559990000', Body: 'hi there', MessageSid: 'SM123', NumMedia: '2', MediaUrl0: 'https://m/0', MediaUrl1: 'https://m/1' },
      }),
      res,
    );
    expect(mocks.sets.length).toBe(1);
    const w = mocks.sets[0];
    expect(w.collection).toBe('sms_messages');
    expect(w.id).toBe('SM123'); // doc id == SID
    expect(w.options).toEqual({ merge: true });
    expect(w.data).toMatchObject({
      counterpartNumber: '+15551234567', // phone in the right field
      direction: 'inbound',
      subType: 'sms',
      body: 'hi there',
      mediaUrls: ['https://m/0', 'https://m/1'],
      status: 'received',
      twilioMessageSid: 'SM123',
      kinfolkId: null,
      kinfolkName: '',
      threadId: '',
      reconcileStatus: 'pending', // reconcile queries on this
      reconciledAt: '',
      reconcileNotes: '',
    });
    expect(typeof w.data.timestamp).toBe('string');
    expect(w.data.timestamp).not.toBe(''); // sortable ISO timestamp set
    // empty TwiML, text/xml, 200
    expect(captured.status).toBe(200);
    expect(captured.headers['Content-Type']).toBe('text/xml');
    expect(captured.text).toBe('<Response></Response>');
  });

  it('writes an empty mediaUrls array when NumMedia is 0/absent', async () => {
    const handler = await loadHandler('twilioInboundSms');
    const { res } = captureRes();
    await handler(makeReq({ headers: { 'x-twilio-signature': 'sig' }, body: { From: '+1', Body: 'x', MessageSid: 'SM0' } }), res);
    expect(mocks.sets[0].data.mediaUrls).toEqual([]);
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
    const handler = await loadHandler('twilioInboundVoicemail');
    const { res, captured } = captureRes();
    await handler(
      makeReq({
        headers: { 'x-twilio-signature': 'sig' },
        body: { From: '+15551112222', TranscriptionText: 'call me back', RecordingSid: 'RE123', RecordingUrl: 'https://rec/1', CallSid: 'CA999' },
      }),
      res,
    );
    expect(mocks.sets.length).toBe(1);
    const w = mocks.sets[0];
    expect(w.collection).toBe('voicemails');
    expect(w.id).toBe('RE123');
    expect(w.options).toEqual({ merge: true });
    expect(w.data).toMatchObject({
      callerNumber: '+15551112222', // voicemails match by callerNumber
      transcript: 'call me back',
      audioUrl: 'https://rec/1',
      direction: 'inbound',
      replyStatus: 'unread',
      twilioCallSid: 'CA999',
      durationSec: 0,
      kinfolkId: null,
      kinfolkName: '',
      repliedAt: '',
      replyLogId: '',
      reconcileStatus: 'pending',
      reconciledAt: '',
      reconcileNotes: '',
    });
    expect(w.data.timestamp).not.toBe('');
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
    await handler(
      makeReq({
        headers: { 'x-twilio-signature': 'sig' },
        body: { From: '+15553334444', CallSid: 'CA123', RecordingUrl: 'https://rec/c', RecordingDuration: '42', CallStatus: 'completed' },
      }),
      res,
    );
    expect(mocks.sets.length).toBe(1);
    const w = mocks.sets[0];
    expect(w.collection).toBe('calls_log');
    expect(w.id).toBe('CA123');
    expect(w.options).toEqual({ merge: true });
    expect(w.data).toMatchObject({
      counterpartNumber: '+15553334444', // calls match by counterpartNumber
      direction: 'inbound',
      status: 'completed',
      transcript: '',
      recordingUrl: 'https://rec/c',
      durationSec: 42, // Number(RecordingDuration)
      twilioCallSid: 'CA123',
      voicemailLogId: '',
      kinfolkId: null,
      kinfolkName: '',
      reconcileStatus: 'pending',
      reconciledAt: '',
      reconcileNotes: '',
    });
    expect(w.data.timestamp).not.toBe('');
    expect(captured.status).toBe(200);
    expect(captured.body).toMatchObject({ ok: true });
  });

  it('defaults status to "completed" and duration to 0 when absent/non-numeric', async () => {
    const handler = await loadHandler('twilioInboundCall');
    const { res } = captureRes();
    await handler(makeReq({ headers: { 'x-twilio-signature': 'sig' }, body: { From: '+1', CallSid: 'CA0', RecordingDuration: 'notanumber' } }), res);
    expect(mocks.sets[0].data.status).toBe('completed');
    expect(mocks.sets[0].data.durationSec).toBe(0);
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

  it('uses CallDuration when present (status callback), else 0', async () => {
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

  it('fail-soft: kinfolk read error does NOT fail the webhook (writes null, 200)', async () => {
    mocks.kinfolkQueryThrows = true; // valid number so we reach the query, which throws
    const handler = await loadHandler('twilioInboundCall');
    const { res, captured } = captureRes();
    await handler(makeReq({ headers: { 'x-twilio-signature': 'sig' }, body: { From: '+12015550123', CallSid: 'CAERR' } }), res);
    expect(mocks.sets.length).toBe(1);
    expect(mocks.sets[0].data.kinfolkId).toBeNull();
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
