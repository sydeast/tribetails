import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The business phone line.
 *
 * These tests exist in the shape they do because of HOW the thing they replace
 * failed. A Studio flow told every caller the business was closed, at every
 * hour, for months, and nothing noticed, because the HTTP call it depended on
 * returned 200 while answering the wrong question. There was no test that could
 * have caught it, and no diff to review.
 *
 * So the assertions here are about WHAT THE CALLER HEARS at a given instant, not
 * about which functions were invoked. Two of them replay the exact timestamps of
 * real calls that were misrouted.
 */

interface SetCall {
  collection: string;
  id: string;
  data: Record<string, unknown>;
  options: { merge?: boolean } | undefined;
}

const mocks = vi.hoisted(() => ({
  sets: [] as SetCall[],
  docs: new Map<string, Record<string, unknown>>(),
  /** Documents addressed by full path via db().doc(path), e.g. business_settings. */
  pathDocs: new Map<string, Record<string, unknown>>(),
  /** Make the settings read throw, to exercise the fail-open path. */
  settingsReadThrows: false,
  validateRequest: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock('../src/lib/logger', () => ({ logEvent: (...args: unknown[]) => mocks.logEvent(...args) }));
vi.mock('twilio', () => ({
  default: { validateRequest: (...args: unknown[]) => mocks.validateRequest(...args) },
}));

vi.mock('../src/lib/firestoreAdmin', () => {
  const write = (
    collection: string,
    id: string,
    data: Record<string, unknown>,
    options: { merge?: boolean } | undefined,
  ) => {
    mocks.sets.push({ collection, id, data, options });
    const key = `${collection}/${id}`;
    const prior = mocks.docs.get(key);
    mocks.docs.set(key, options?.merge && prior ? { ...prior, ...data } : { ...data });
  };
  const makeDocRef = (collection: string, id: string) => ({ __collection: collection, __id: id });
  const snapshotOf = (collection: string, id: string) => {
    const stored = mocks.docs.get(`${collection}/${id}`);
    return { exists: stored !== undefined, data: () => (stored ? { ...stored } : undefined) };
  };
  type Ref = ReturnType<typeof makeDocRef>;
  return {
    db: () => ({
      doc: (path: string) => ({
        get: () => {
          if (mocks.settingsReadThrows) return Promise.reject(new Error('firestore boom'));
          const stored = mocks.pathDocs.get(path);
          return Promise.resolve({
            exists: stored !== undefined,
            data: () => (stored ? { ...stored } : undefined),
          });
        },
      }),
      collection: (collection: string) => ({ doc: (id: string) => makeDocRef(collection, id) }),
      runTransaction: async <T>(fn: (txn: unknown) => Promise<T>): Promise<T> =>
        fn({
          get: (ref: Ref) => Promise.resolve(snapshotOf(ref.__collection, ref.__id)),
          set: (ref: Ref, data: Record<string, unknown>, options?: { merge?: boolean }) => {
            write(ref.__collection, ref.__id, data, options);
          },
        }),
    }),
  };
});

const SETTINGS_PATH = 'business_settings/business_settings';
const LEGACY_SETTINGS_PATH = 'business_settings/singleton';
const BASE = 'https://us-central1-test.cloudfunctions.net/twilioVoice';
const VOICEMAIL_CB = 'https://us-central1-test.cloudfunctions.net/twilioInboundVoicemail';

/** The live hours document, verbatim. */
const LIVE_SETTINGS = {
  businessHours: {
    Monday: '08:00-18:00',
    Tuesday: '08:00-18:00',
    Wednesday: '08:00-18:00',
    Thursday: '08:00-18:00',
    Friday: '08:00-18:00',
    Saturday: '08:00-18:00',
    Sunday: '08:00-16:00',
  },
  timeZone: 'America/Chicago',
  companyHolidays: [],
  specialHours: [],
};

/** 2026-08-11 19:01:20 UTC = 14:01 Tuesday, Central. A real misrouted call. */
const OPEN_INSTANT = Date.UTC(2026, 7, 11, 19, 1, 20);
/** 2026-08-11 04:00 UTC = 23:00 Monday, Central. Genuinely after hours. */
const CLOSED_INSTANT = Date.UTC(2026, 7, 11, 4, 0, 0);

const CALL_SID = 'CA9ed4347c31f54d4edd35660ea98ef8fb';

beforeEach(() => {
  mocks.sets.length = 0;
  mocks.docs.clear();
  mocks.pathDocs.clear();
  mocks.settingsReadThrows = false;
  mocks.validateRequest.mockReset();
  mocks.logEvent.mockReset();
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_VOICE_BASE_URL;
  delete process.env.TWILIO_INBOUND_VOICEMAIL_URL;
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
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

function makeReq(
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: Record<string, string> } = {},
): any {
  const headers = opts.headers ?? {};
  const path = opts.path ?? '/';
  return {
    method: opts.method ?? 'POST',
    hostname: 'us-central1-test.cloudfunctions.net',
    path,
    originalUrl: path,
    header: (name: string) => headers[name.toLowerCase()],
    body: opts.body ?? {},
  };
}

async function loadHandler() {
  const mod = await import('../src/twilio/twilioVoice');
  return mod.twilioVoiceHandler;
}

/**
 * A spoken phrase as it appears INSIDE the TwiML, apostrophes and all.
 *
 * Written out rather than reusing the handler's own escaper on purpose: a test
 * that escapes with the same function it is checking would pass even if that
 * function stopped escaping. This is a second, independent statement of what
 * the caller's TwiML should literally contain.
 */
function spoken(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** An authentic, signed request with the line configured the way production is. */
function configureAuthentic(): void {
  process.env.TWILIO_AUTH_TOKEN = 'tok';
  process.env.TWILIO_VOICE_BASE_URL = BASE;
  process.env.TWILIO_INBOUND_VOICEMAIL_URL = VOICEMAIL_CB;
  mocks.validateRequest.mockReturnValue(true);
  mocks.pathDocs.set(SETTINGS_PATH, { ...LIVE_SETTINGS });
}

async function call(
  path: string,
  body: Record<string, string> = {},
  at?: number,
): Promise<CapturedRes> {
  if (at !== undefined) vi.setSystemTime(at);
  const handler = await loadHandler();
  const { res, captured } = captureRes();
  await handler(makeReq({ path, headers: { 'x-twilio-signature': 'sig' }, body }), res);
  return captured;
}

// ---------------------------------------------------------------------------

describe('twilioVoice — guard', () => {
  it('FAILS CLOSED with no auth token, and refuses in TwiML so the caller is not stranded', async () => {
    process.env.TWILIO_VOICE_BASE_URL = BASE;
    const captured = await call('/');
    expect(captured.status).toBe(403);
    expect(captured.headers['Content-Type']).toBe('text/xml');
    expect(captured.text).toBe('<Response><Reject/></Response>');
    expect(mocks.sets).toHaveLength(0);
  });

  it('REJECTS a bad signature', async () => {
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    process.env.TWILIO_VOICE_BASE_URL = BASE;
    mocks.validateRequest.mockReturnValue(false);
    const captured = await call('/');
    expect(captured.status).toBe(403);
    expect(mocks.sets).toHaveLength(0);
  });

  it('REJECTS a non-POST', async () => {
    configureAuthentic();
    const handler = await loadHandler();
    const { res, captured } = captureRes();
    await handler(makeReq({ method: 'GET', path: '/' }), res);
    expect(captured.status).toBe(405);
    expect(captured.ended).toBe(true);
  });

  it('signs against the BASE plus this request path, not the base alone', async () => {
    // The whole reason this handler needs its own verifier: a single pinned URL
    // would 403 every route except the one it named.
    configureAuthentic();
    await call('/route', { Digits: '4' });
    expect(mocks.validateRequest).toHaveBeenCalledWith('tok', 'sig', `${BASE}/route`, { Digits: '4' });
  });

  it('signs the entry path as the bare base', async () => {
    configureAuthentic();
    await call('/', {}, OPEN_INSTANT);
    expect(mocks.validateRequest).toHaveBeenCalledWith('tok', 'sig', `${BASE}/`, {});
  });

  it('tolerates a trailing slash on the configured base', async () => {
    configureAuthentic();
    process.env.TWILIO_VOICE_BASE_URL = `${BASE}/`;
    await call('/route', { Digits: '4' });
    expect(mocks.validateRequest).toHaveBeenCalledWith('tok', 'sig', `${BASE}/route`, { Digits: '4' });
  });
});

describe('twilioVoice — entry, the outage this replaces', () => {
  it('THE REGRESSION: a Tuesday 14:01 caller is greeted as OPEN', async () => {
    configureAuthentic();
    const captured = await call('/', { CallSid: CALL_SID, From: '+16195001530' }, OPEN_INSTANT);
    expect(captured.status).toBe(200);
    expect(captured.headers['Content-Type']).toBe('text/xml');
    expect(captured.text).toContain(spoken("this is Auntie's line"));
    expect(captured.text).not.toContain(spoken("We're closed right now"));
  });

  it('THE REGRESSION: a Saturday caller is greeted as OPEN', async () => {
    configureAuthentic();
    // 2026-08-01 21:32 UTC = 16:32 Saturday Central. A real misrouted call.
    const captured = await call('/', { CallSid: 'CAsat' }, Date.UTC(2026, 7, 1, 21, 32));
    expect(captured.text).toContain(spoken("this is Auntie's line"));
  });

  it('genuinely after hours still says closed', async () => {
    configureAuthentic();
    const captured = await call('/', { CallSid: CALL_SID }, CLOSED_INSTANT);
    expect(captured.text).toContain(spoken("We're closed right now"));
  });

  it('gathers exactly one digit and posts it back to /route', async () => {
    configureAuthentic();
    const captured = await call('/', {}, OPEN_INSTANT);
    expect(captured.text).toContain('<Gather numDigits="1"');
    expect(captured.text).toContain(`action="${BASE}/route"`);
    expect(captured.text).toContain('method="POST"');
  });

  it('REDIRECTS after the gather, so a silent caller is not hung up on mid-greeting', async () => {
    // TwiML falls through to the next verb when a gather times out. A Response
    // that ends at </Gather> disconnects without a word.
    configureAuthentic();
    const open = await call('/', {}, OPEN_INSTANT);
    expect(open.text).toContain(`<Redirect method="POST">${BASE}/retry</Redirect>`);
    const closed = await call('/', {}, CLOSED_INSTANT);
    expect(closed.text).toContain(`<Redirect method="POST">${BASE}/goodbye</Redirect>`);
  });

  it('closes on a company holiday during business hours', async () => {
    configureAuthentic();
    mocks.pathDocs.set(SETTINGS_PATH, { ...LIVE_SETTINGS, companyHolidays: ['2026-08-11|Staff day'] });
    const captured = await call('/', {}, OPEN_INSTANT);
    expect(captured.text).toContain(spoken("We're closed right now"));
  });

  it('reads the legacy singleton doc when the modern id is absent', async () => {
    configureAuthentic();
    mocks.pathDocs.clear();
    mocks.pathDocs.set(LEGACY_SETTINGS_PATH, { ...LIVE_SETTINGS });
    const captured = await call('/', {}, OPEN_INSTANT);
    expect(captured.text).toContain(spoken("this is Auntie's line"));
  });

  it('FAILS OPEN when the settings document is missing', async () => {
    configureAuthentic();
    mocks.pathDocs.clear();
    const captured = await call('/', {}, OPEN_INSTANT);
    expect(captured.text).toContain(spoken("this is Auntie's line"));
  });

  it('FAILS OPEN when the settings read throws', async () => {
    configureAuthentic();
    mocks.settingsReadThrows = true;
    const captured = await call('/', {}, OPEN_INSTANT);
    expect(captured.status).toBe(200);
    expect(captured.text).toContain(spoken("this is Auntie's line"));
  });

  it('LOGS an uncertain hours answer at error, so a silent outage cannot repeat', async () => {
    configureAuthentic();
    mocks.pathDocs.clear();
    await call('/', {}, OPEN_INSTANT);
    const logged = mocks.logEvent.mock.calls.map((c) => c[0]);
    expect(logged).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        event: 'twilioVoice.hours.uncertain',
        extra: expect.objectContaining({ open: true, reason: 'settings-unavailable' }),
      }),
    );
  });

  it('logs a confident answer at info, naming the day and local time', async () => {
    configureAuthentic();
    await call('/', { CallSid: CALL_SID }, OPEN_INSTANT);
    const logged = mocks.logEvent.mock.calls.map((c) => c[0]);
    expect(logged).toContainEqual(
      expect.objectContaining({
        severity: 'info',
        event: 'twilioVoice.hours.resolved',
        extra: expect.objectContaining({
          open: true,
          reason: 'open',
          dayName: 'Tuesday',
          localTime: '14:01',
          timeZone: 'America/Chicago',
        }),
      }),
    );
  });
});

describe('twilioVoice — calls_log', () => {
  it('seeds the call document with the schema reconcile and the Inbox expect', async () => {
    configureAuthentic();
    await call('/', { CallSid: CALL_SID, From: '+16195001530' }, OPEN_INSTANT);
    const stored = mocks.docs.get(`calls_log/${CALL_SID}`);
    expect(stored).toMatchObject({
      direction: 'inbound',
      twilioCallSid: CALL_SID,
      counterpartNumber: '+16195001530',
      kinfolkId: null,
      reconcileStatus: 'pending',
    });
    expect(mocks.sets[0]?.options).toEqual({ merge: true });
  });

  it('NEVER overwrites a status callback that already landed', async () => {
    // twilioInboundCall owns status, duration and recordingUrl. PR #345 exists
    // because a callback that restated fields it had no news about erased them.
    configureAuthentic();
    mocks.docs.set(`calls_log/${CALL_SID}`, {
      direction: 'inbound',
      twilioCallSid: CALL_SID,
      status: 'completed',
      durationSec: 18,
      recordingUrl: 'https://api.twilio.com/rec',
      reconcileStatus: 'skipped',
      counterpartNumber: '+16195001530',
      kinfolkId: 'KF1',
      kinfolkName: 'Wren',
      timestamp: '2026-08-11T19:01:39.471Z',
      reconciledAt: '2026-08-11T20:00:00Z',
      reconcileNotes: 'matched',
      voicemailLogId: '',
    });
    await call('/', { CallSid: CALL_SID, From: '+16195001530' }, OPEN_INSTANT);
    const stored = mocks.docs.get(`calls_log/${CALL_SID}`);
    expect(stored).toMatchObject({
      status: 'completed',
      durationSec: 18,
      recordingUrl: 'https://api.twilio.com/rec',
      reconcileStatus: 'skipped',
      kinfolkId: 'KF1',
    });
    // Nothing to add means nothing written at all.
    expect(mocks.sets).toHaveLength(0);
  });

  it('writes nothing when Twilio sent no CallSid', async () => {
    configureAuthentic();
    await call('/', { From: '+16195001530' }, OPEN_INSTANT);
    expect(mocks.sets).toHaveLength(0);
  });

  it('still greets the caller when the calls_log write fails', async () => {
    configureAuthentic();
    mocks.pathDocs.set(SETTINGS_PATH, { ...LIVE_SETTINGS });
    const handler = await loadHandler();
    vi.setSystemTime(OPEN_INSTANT);
    const { res, captured } = captureRes();
    // A transaction that throws must not cost the caller the greeting.
    const mod = await import('../src/lib/firestoreAdmin');
    const spy = vi.spyOn(mod, 'db').mockReturnValue({
      doc: () => ({ get: () => Promise.resolve({ exists: true, data: () => LIVE_SETTINGS }) }),
      collection: () => ({ doc: () => ({}) }),
      runTransaction: () => Promise.reject(new Error('txn boom')),
    } as never);
    await handler(makeReq({ path: '/', headers: { 'x-twilio-signature': 'sig' }, body: { CallSid: CALL_SID } }), res);
    spy.mockRestore();
    expect(captured.status).toBe(200);
    expect(captured.text).toContain(spoken("this is Auntie's line"));
  });
});

describe('twilioVoice — routing', () => {
  it('sends 4 to voicemail', async () => {
    configureAuthentic();
    const captured = await call('/route', { Digits: '4', CallSid: CALL_SID });
    expect(captured.text).toContain(`<Redirect method="POST">${BASE}/voicemail</Redirect>`);
  });

  it('sends 3 to voicemail too, because a live connect does not exist yet', async () => {
    configureAuthentic();
    const captured = await call('/route', { Digits: '3', CallSid: CALL_SID });
    expect(captured.text).toContain(`<Redirect method="POST">${BASE}/voicemail</Redirect>`);
  });

  it('sends any other digit to the retry', async () => {
    configureAuthentic();
    for (const Digits of ['1', '9', '#', '']) {
      const captured = await call('/route', { Digits });
      expect(captured.text).toContain(`<Redirect method="POST">${BASE}/retry</Redirect>`);
    }
  });

  it('retry gathers once more, then gives up to the text nudge', async () => {
    configureAuthentic();
    const captured = await call('/retry', {});
    expect(captured.text).toContain(spoken("Sorry, I didn't catch that"));
    expect(captured.text).toContain(`action="${BASE}/route"`);
    expect(captured.text).toContain(`<Redirect method="POST">${BASE}/goodbye</Redirect>`);
  });

  it('goodbye suggests a text and hangs up', async () => {
    configureAuthentic();
    const captured = await call('/goodbye', {});
    expect(captured.text).toContain('quickest way to reach me is by text');
    expect(captured.text).toContain('<Hangup/>');
  });

  it('an unknown path says something useful instead of a Twilio error tone', async () => {
    configureAuthentic();
    const captured = await call('/nope', { CallSid: CALL_SID });
    expect(captured.status).toBe(200);
    expect(captured.text).toContain('quickest way to reach me is by text');
    const logged = mocks.logEvent.mock.calls.map((c) => c[0]);
    expect(logged).toContainEqual(
      expect.objectContaining({ severity: 'error', event: 'twilioVoice.unknown-path' }),
    );
  });
});

describe('twilioVoice — voicemail', () => {
  it('THE DURATION FIX: sets BOTH the transcription and recording-status callbacks', async () => {
    // The Studio widget carried only the transcription callback, and Twilio's
    // transcription callback has no RecordingDuration, so every voicemail this
    // business ever took landed with durationSec: 0.
    configureAuthentic();
    const captured = await call('/voicemail', {});
    expect(captured.text).toContain(`transcribeCallback="${VOICEMAIL_CB}"`);
    expect(captured.text).toContain(`recordingStatusCallback="${VOICEMAIL_CB}"`);
    expect(captured.text).toContain('recordingStatusCallbackEvent="completed"');
    expect(captured.text).toContain('recordingStatusCallbackMethod="POST"');
  });

  it('uses the attribute Twilio actually reads', async () => {
    // The serverless voicemail this replaces wrote `transcriptionCallback`,
    // which is not a <Record> attribute; Twilio ignored it and the transcript
    // never arrived.
    configureAuthentic();
    const captured = await call('/voicemail', {});
    expect(captured.text).toContain('transcribeCallback=');
    expect(captured.text).not.toContain('transcriptionCallback=');
  });

  it('keeps the recording limits the flow used', async () => {
    configureAuthentic();
    const captured = await call('/voicemail', {});
    expect(captured.text).toContain('maxLength="180"');
    expect(captured.text).toContain('finishOnKey="#"');
    expect(captured.text).toContain('playBeep="true"');
    expect(captured.text).toContain('transcribe="true"');
  });

  it('thanks the caller and hangs up after the beep', async () => {
    configureAuthentic();
    const captured = await call('/voicemail', {});
    expect(captured.text).toContain('Please leave your message after the beep');
    expect(captured.text).toContain(spoken("I'll listen to your message"));
    expect(captured.text).toContain('<Hangup/>');
  });

  it('still takes the message with no callback configured, and says so LOUDLY', async () => {
    configureAuthentic();
    delete process.env.TWILIO_INBOUND_VOICEMAIL_URL;
    const captured = await call('/voicemail', {});
    expect(captured.text).toContain('<Record ');
    expect(captured.text).not.toContain('transcribeCallback=');
    const logged = mocks.logEvent.mock.calls.map((c) => c[0]);
    expect(logged).toContainEqual(
      expect.objectContaining({ severity: 'error', event: 'twilioVoice.voicemail.no-callback-url' }),
    );
  });
});

describe('twilioVoice — TwiML shape', () => {
  it('every route answers well-formed TwiML with an XML declaration', async () => {
    configureAuthentic();
    for (const path of ['/', '/route', '/retry', '/voicemail', '/goodbye']) {
      const captured = await call(path, {}, OPEN_INSTANT);
      expect(captured.status).toBe(200);
      expect(captured.headers['Content-Type']).toBe('text/xml');
      expect(captured.text).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?><Response>/);
      expect(captured.text).toMatch(/<\/Response>$/);
    }
  });

  it('escapes the apostrophes in the greeting rather than emitting raw text', async () => {
    configureAuthentic();
    const captured = await call('/', {}, OPEN_INSTANT);
    expect(captured.text).toContain('&apos;');
    expect(captured.text).not.toMatch(/<Say>[^<]*'[^<]*<\/Say>/);
  });

  it('falls back to the request host when no base URL is configured', async () => {
    configureAuthentic();
    delete process.env.TWILIO_VOICE_BASE_URL;
    const captured = await call('/', {}, OPEN_INSTANT);
    expect(captured.text).toContain('action="https://us-central1-test.cloudfunctions.net/route"');
  });
});
