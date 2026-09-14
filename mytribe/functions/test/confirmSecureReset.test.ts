/**
 * Tests for confirmSecureResetHandler.
 *
 * Covers:
 *   - Input validation (method, required fields, password length)
 *   - Missing WEB_API_KEY → 503
 *   - The email is DERIVED from the oobCode (#892): a verify-only Identity
 *     Toolkit call runs first, and a client-sent email is never trusted
 *   - Email-based rate-limit guard keyed on the derived email (429 before the
 *     oobCode is consumed)
 *   - Identity Toolkit unreachable → 502, rejects oobCode → 400
 *   - Happy-path: incident doc written + notification enqueued → 200
 *   - Notification failure does NOT block 200 response (fail-loud log only)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  // Firestore transaction internals
  txGet: vi.fn(),
  txSet: vi.fn(),
  // Doc ref for the securityIncidents collection
  incidentSet: vi.fn(),
  incidentId: 'incident-abc',
  // Rate-limit doc ids requested, so a test can see which email was hashed
  rateLimitDocIds: [] as string[],
  // getFirestore mock
  getFirestore: vi.fn(),
  // Notification dispatcher
  enqueueNotification: vi.fn(),
  // Logger
  logEvent: vi.fn(),
}));

vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return {
    ...actual,
    FieldValue: { serverTimestamp: () => '__SERVER_TS__', delete: () => '__DELETE__' },
    getFirestore: mocks.getFirestore,
  };
});
vi.mock('../src/notifications/dispatcher.js', () => ({ enqueueNotification: mocks.enqueueNotification }));
vi.mock('../src/lib/logger.js', () => ({ logEvent: mocks.logEvent }));

// ── Helpers ───────────────────────────────────────────────────────────────────

interface CapturedRes {
  status: number;
  body: Record<string, unknown>;
}

function captureRes(): { res: import('../src/security/confirmSecureReset.js').MinimalRes; captured: CapturedRes } {
  const captured: CapturedRes = { status: 0, body: {} };
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(payload: Record<string, unknown>) {
      captured.body = payload;
    },
  };
  return { res, captured };
}

function makeReq(body: unknown, method = 'POST') {
  return {
    method,
    body,
    headers: {},
    socket: { remoteAddress: '1.2.3.4' },
  };
}

/** Build a fake Firestore db that simulates the rate-limit transaction. */
function buildFakeDb(opts: {
  /** Timestamps already stored for this email's rate-limit doc. */
  existingTimestamps?: number[];
}) {
  const existingTimestamps = opts.existingTimestamps ?? [];

  mocks.txGet.mockResolvedValue({
    data: () => ({ timestamps: existingTimestamps }),
  });
  mocks.txSet.mockResolvedValue(undefined);
  mocks.incidentSet.mockResolvedValue(undefined);

  const fakeIncidentRef = {
    id: mocks.incidentId,
    set: mocks.incidentSet,
  };

  const fakeDb: any = {
    collection: vi.fn((name: string) => ({
      doc: vi.fn((id?: string) => {
        if (name === 'securityRateLimits') {
          mocks.rateLimitDocIds.push(id ?? '');
          return 'rateLimitDocRef'; // will be used as ref in transaction
        }
        // securityIncidents auto-id doc
        return fakeIncidentRef;
      }),
    })),
    runTransaction: vi.fn(async (fn: (tx: any) => Promise<void>) => {
      const tx = { get: mocks.txGet, set: mocks.txSet };
      return fn(tx);
    }),
  };

  mocks.getFirestore.mockReturnValue(fakeDb);
  return fakeDb;
}

/** The account the oobCode belongs to, as Identity Toolkit reports it. */
const OWNER_EMAIL = 'pepper@tribetails.com';

const VALID_BODY = {
  oobCode: 'oobCode-abc12345',
  newPassword: 'hunter2hunter',
};

function jsonResponse(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    clone() {
      return this;
    },
  };
}

/**
 * Identity Toolkit as the handler sees it: the first resetPassword (oobCode
 * only) verifies and names the account, the second (with newPassword)
 * consumes the code.
 */
function identityToolkit(opts: { email?: string; verifyStatus?: number; consumeStatus?: number } = {}) {
  const email = opts.email ?? OWNER_EMAIL;
  const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    const sent = JSON.parse(init.body) as { oobCode: string; newPassword?: string };
    if (sent.newPassword === undefined) {
      const status = opts.verifyStatus ?? 200;
      return status === 200
        ? jsonResponse(200, { email, requestType: 'PASSWORD_RESET' })
        : jsonResponse(status, { error: { message: 'EXPIRED_OOB_CODE' } });
    }
    const status = opts.consumeStatus ?? 200;
    return status === 200
      ? jsonResponse(200, { email, requestType: 'PASSWORD_RESET' })
      : jsonResponse(status, { error: { message: 'INVALID_OOB_CODE' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** sha256(email) prefix the handler keys its rate-limit doc on. */
async function hashOf(email: string): Promise<string> {
  const { createHash } = await import('crypto');
  return createHash('sha256').update(email).digest('hex').slice(0, 32);
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.resetModules();
  mocks.txGet.mockReset();
  mocks.txSet.mockReset();
  mocks.incidentSet.mockReset();
  mocks.getFirestore.mockReset();
  mocks.enqueueNotification.mockReset();
  mocks.logEvent.mockReset();
  mocks.rateLimitDocIds.length = 0;
  delete process.env.WEB_API_KEY;
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Input validation ──────────────────────────────────────────────────────────

describe('confirmSecureResetHandler — input validation', () => {
  it('rejects non-POST with 405', async () => {
    const { confirmSecureResetHandler } = await import('../src/security/confirmSecureReset.js');
    const { res, captured } = captureRes();
    await confirmSecureResetHandler(makeReq(VALID_BODY, 'GET'), res);
    expect(captured.status).toBe(405);
    expect(captured.body.error).toBe('method_not_allowed');
  });

  it('rejects missing oobCode with 400', async () => {
    const { confirmSecureResetHandler } = await import('../src/security/confirmSecureReset.js');
    const { res, captured } = captureRes();
    await confirmSecureResetHandler(makeReq({ newPassword: 'abc12345' }), res);
    expect(captured.status).toBe(400);
    expect(captured.body.error).toBe('missing_required');
  });

  it('rejects missing newPassword with 400', async () => {
    const { confirmSecureResetHandler } = await import('../src/security/confirmSecureReset.js');
    const { res, captured } = captureRes();
    await confirmSecureResetHandler(makeReq({ oobCode: 'abc' }), res);
    expect(captured.status).toBe(400);
    expect(captured.body.error).toBe('missing_required');
  });

  it('does NOT require an email: the server derives it from the oobCode (#892)', async () => {
    buildFakeDb({ existingTimestamps: [] });
    process.env.WEB_API_KEY = 'test-api-key';
    identityToolkit();
    mocks.enqueueNotification.mockResolvedValue(['notif-1']);
    const { confirmSecureResetHandler } = await import('../src/security/confirmSecureReset.js');
    const { res, captured } = captureRes();
    await confirmSecureResetHandler(makeReq(VALID_BODY), res);
    expect(captured.status).toBe(200);
  });

  it('rejects password shorter than 8 chars with 400', async () => {
    const { confirmSecureResetHandler } = await import('../src/security/confirmSecureReset.js');
    const { res, captured } = captureRes();
    await confirmSecureResetHandler(makeReq({ oobCode: 'abc', newPassword: 'short' }), res);
    expect(captured.status).toBe(400);
    expect(captured.body.error).toBe('password_too_short');
  });
});

// ── Missing API key ───────────────────────────────────────────────────────────

describe('confirmSecureResetHandler — missing WEB_API_KEY', () => {
  it('returns 503 server_misconfigured when WEB_API_KEY is unset, before any Identity Toolkit call', async () => {
    buildFakeDb({ existingTimestamps: [] });
    const fetchMock = identityToolkit();
    const { confirmSecureResetHandler } = await import('../src/security/confirmSecureReset.js');
    const { res, captured } = captureRes();
    await confirmSecureResetHandler(makeReq(VALID_BODY), res);
    expect(captured.status).toBe(503);
    expect(captured.body.error).toBe('server_misconfigured');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── Derived email ─────────────────────────────────────────────────────────────

describe('confirmSecureResetHandler — email comes from the oobCode, never the client (#892)', () => {
  it('verifies the code first with oobCode ONLY, then consumes it with the new password', async () => {
    buildFakeDb({ existingTimestamps: [] });
    process.env.WEB_API_KEY = 'test-api-key';
    const fetchMock = identityToolkit();
    mocks.enqueueNotification.mockResolvedValue(['notif-1']);
    const { confirmSecureResetHandler } = await import('../src/security/confirmSecureReset.js');
    const { res } = captureRes();
    await confirmSecureResetHandler(makeReq(VALID_BODY), res);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [verifyUrl, verifyInit] = fetchMock.mock.calls[0];
    expect(verifyUrl).toBe('https://identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=test-api-key');
    expect(JSON.parse(verifyInit.body)).toEqual({ oobCode: VALID_BODY.oobCode });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      oobCode: VALID_BODY.oobCode,
      newPassword: VALID_BODY.newPassword,
    });
  });

  it('names the oobCode owner in the incident and notification even when the client sends another email', async () => {
    buildFakeDb({ existingTimestamps: [] });
    process.env.WEB_API_KEY = 'test-api-key';
    identityToolkit({ email: OWNER_EMAIL });
    mocks.enqueueNotification.mockResolvedValue(['notif-1']);
    const { confirmSecureResetHandler } = await import('../src/security/confirmSecureReset.js');
    const { res, captured } = captureRes();
    await confirmSecureResetHandler(makeReq({ ...VALID_BODY, email: 'someone-else@example.com' }), res);

    expect(captured.status).toBe(200);
    const incident = mocks.incidentSet.mock.calls[0][0] as Record<string, unknown>;
    expect(incident.kinfolkEmail).toBe(OWNER_EMAIL);
    expect(mocks.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ kinfolkEmail: OWNER_EMAIL }) }),
    );
  });

  it('keys the rate limit on the DERIVED email hash, not the client-sent one', async () => {
    buildFakeDb({ existingTimestamps: [] });
    process.env.WEB_API_KEY = 'test-api-key';
    identityToolkit({ email: OWNER_EMAIL });
    mocks.enqueueNotification.mockResolvedValue(['notif-1']);
    const { confirmSecureResetHandler } = await import('../src/security/confirmSecureReset.js');
    const { res } = captureRes();
    await confirmSecureResetHandler(makeReq({ ...VALID_BODY, email: 'rotating-alias@example.com' }), res);

    expect(mocks.rateLimitDocIds).toEqual([`secureReset_${await hashOf(OWNER_EMAIL)}`]);
  });

  it('calls the Auth emulator when FIREBASE_AUTH_EMULATOR_HOST is set', async () => {
    buildFakeDb({ existingTimestamps: [] });
    process.env.WEB_API_KEY = 'test-api-key';
    process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9499';
    const fetchMock = identityToolkit();
    mocks.enqueueNotification.mockResolvedValue(['notif-1']);
    const { confirmSecureResetHandler } = await import('../src/security/confirmSecureReset.js');
    const { res } = captureRes();
    await confirmSecureResetHandler(makeReq(VALID_BODY), res);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://127.0.0.1:9499/identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=test-api-key',
    );
  });

  it('returns 400 reset_failed and consumes nothing when the verify call names no email', async () => {
    buildFakeDb({ existingTimestamps: [] });
    process.env.WEB_API_KEY = 'test-api-key';
    const fetchMock = vi.fn(async () => jsonResponse(200, { requestType: 'PASSWORD_RESET' }));
    vi.stubGlobal('fetch', fetchMock);
    const { confirmSecureResetHandler } = await import('../src/security/confirmSecureReset.js');
    const { res, captured } = captureRes();
    await confirmSecureResetHandler(makeReq(VALID_BODY), res);
    expect(captured.status).toBe(400);
    expect(captured.body.error).toBe('reset_failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.incidentSet).not.toHaveBeenCalled();
  });
});

// ── Rate-limit guard ──────────────────────────────────────────────────────────

describe('confirmSecureResetHandler — email rate-limit (3 per 24h)', () => {
  it('HAPPY: exactly 2 prior attempts in window — third is allowed and recorded', async () => {
    const now = Date.now();
    buildFakeDb({ existingTimestamps: [now - 1000, now - 2000] });
    process.env.WEB_API_KEY = 'test-api-key';
    identityToolkit();
    mocks.enqueueNotification.mockResolvedValue(['notif-1']);
    const { confirmSecureResetHandler } = await import('../src/security/confirmSecureReset.js');
    const { res, captured } = captureRes();
    await confirmSecureResetHandler(makeReq(VALID_BODY), res);
    expect(captured.status).toBe(200);
    expect(mocks.txSet).toHaveBeenCalledOnce();
  });

  it('SAD: 3 prior attempts in 24h window → 429 rate_limited, and the code is NOT consumed', async () => {
    const now = Date.now();
    buildFakeDb({ existingTimestamps: [now - 1000, now - 2000, now - 3000] });
    process.env.WEB_API_KEY = 'test-api-key';
    const fetchMock = identityToolkit();
    const { confirmSecureResetHandler } = await import('../src/security/confirmSecureReset.js');
    const { res, captured } = captureRes();
    await confirmSecureResetHandler(makeReq(VALID_BODY), res);
    expect(captured.status).toBe(429);
    expect(captured.body).toEqual({ ok: false, reason: 'rate_limited' });
    // Only the verify call ran; the password was not changed.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueNotification).not.toHaveBeenCalled();
  });

  it('SAD: 5 prior attempts (abuse) → 429 rate_limited without growing the array', async () => {
    const now = Date.now();
    const many = Array.from({ length: 5 }, (_, i) => now - (i + 1) * 1000);
    buildFakeDb({ existingTimestamps: many });
    process.env.WEB_API_KEY = 'test-api-key';
    identityToolkit();
    const { confirmSecureResetHandler } = await import('../src/security/confirmSecureReset.js');
    const { res, captured } = captureRes();
    await confirmSecureResetHandler(makeReq(VALID_BODY), res);
    expect(captured.status).toBe(429);
    expect(captured.body.reason).toBe('rate_limited');
    expect(mocks.txSet).not.toHaveBeenCalled();
  });

  it('EDGE: expired timestamps (>24h old) do not count — request is allowed', async () => {
    const expired = Array.from({ length: 5 }, (_, i) => Date.now() - 25 * 60 * 60 * 1000 - i * 1000);
    buildFakeDb({ existingTimestamps: expired });
    process.env.WEB_API_KEY = 'test-api-key';
    identityToolkit();
    mocks.enqueueNotification.mockResolvedValue(['notif-1']);
    const { confirmSecureResetHandler } = await import('../src/security/confirmSecureReset.js');
    const { res, captured } = captureRes();
    await confirmSecureResetHandler(makeReq(VALID_BODY), res);
    expect(captured.status).toBe(200);
  });

  it('rate-limited request logs warn event', async () => {
    const now = Date.now();
    buildFakeDb({ existingTimestamps: [now - 1000, now - 2000, now - 3000] });
    process.env.WEB_API_KEY = 'test-api-key';
    identityToolkit();
    const { confirmSecureResetHandler } = await import('../src/security/confirmSecureReset.js');
    const { res } = captureRes();
    await confirmSecureResetHandler(makeReq(VALID_BODY), res);
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'warn',
        event: 'security.secureResetRateLimited',
      }),
    );
  });
});

// ── Identity Toolkit failures ─────────────────────────────────────────────────

describe('confirmSecureResetHandler — Identity Toolkit errors', () => {
  it('returns 502 when fetch throws (network error)', async () => {
    buildFakeDb({ existingTimestamps: [] });
    process.env.WEB_API_KEY = 'test-api-key';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const { confirmSecureResetHandler } = await import('../src/security/confirmSecureReset.js');
    const { res, captured } = captureRes();
    await confirmSecureResetHandler(makeReq(VALID_BODY), res);
    expect(captured.status).toBe(502);
    expect(captured.body.error).toBe('auth_unreachable');
  });

  it('returns 400 when Identity Toolkit rejects the oobCode at verify (expired or used)', async () => {
    buildFakeDb({ existingTimestamps: [] });
    process.env.WEB_API_KEY = 'test-api-key';
    const fetchMock = identityToolkit({ verifyStatus: 400 });

    const { confirmSecureResetHandler } = await import('../src/security/confirmSecureReset.js');
    const { res, captured } = captureRes();
    await confirmSecureResetHandler(makeReq(VALID_BODY), res);
    expect(captured.status).toBe(400);
    expect(captured.body.error).toBe('reset_failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.txSet).not.toHaveBeenCalled();
  });

  it('returns 400 when Identity Toolkit rejects the consume call', async () => {
    buildFakeDb({ existingTimestamps: [] });
    process.env.WEB_API_KEY = 'test-api-key';
    identityToolkit({ consumeStatus: 400 });

    const { confirmSecureResetHandler } = await import('../src/security/confirmSecureReset.js');
    const { res, captured } = captureRes();
    await confirmSecureResetHandler(makeReq(VALID_BODY), res);
    expect(captured.status).toBe(400);
    expect(captured.body.error).toBe('reset_failed');
    expect(mocks.incidentSet).not.toHaveBeenCalled();
  });
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe('confirmSecureResetHandler — happy path', () => {
  it('writes incident doc + enqueues notification + returns 200 with incidentId', async () => {
    buildFakeDb({ existingTimestamps: [] });
    process.env.WEB_API_KEY = 'test-api-key';
    identityToolkit();
    mocks.enqueueNotification.mockResolvedValue(['notif-1']);

    const { confirmSecureResetHandler } = await import('../src/security/confirmSecureReset.js');
    const { res, captured } = captureRes();
    await confirmSecureResetHandler(makeReq(VALID_BODY), res);

    expect(captured.status).toBe(200);
    expect(captured.body.ok).toBe(true);
    expect(captured.body.incidentId).toBe(mocks.incidentId);

    expect(mocks.incidentSet).toHaveBeenCalledOnce();
    const incidentData = mocks.incidentSet.mock.calls[0][0] as Record<string, unknown>;
    expect(incidentData.type).toBe('unsolicited_password_reset');
    expect(incidentData.kinfolkEmail).toBe(OWNER_EMAIL);
    expect(incidentData.oobCodePrefix).toBe(VALID_BODY.oobCode.slice(0, 8));

    expect(mocks.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'security.breach_attempt.kinfolk',
        data: expect.objectContaining({
          kinfolkEmail: OWNER_EMAIL,
          incidentId: mocks.incidentId,
        }),
      }),
    );
  });

  it('returns 200 even when notification dispatch throws (fail-loud log)', async () => {
    buildFakeDb({ existingTimestamps: [] });
    process.env.WEB_API_KEY = 'test-api-key';
    identityToolkit();
    mocks.enqueueNotification.mockRejectedValue(new Error('smtp2go down'));

    const { confirmSecureResetHandler } = await import('../src/security/confirmSecureReset.js');
    const { res, captured } = captureRes();
    await confirmSecureResetHandler(makeReq(VALID_BODY), res);

    expect(captured.status).toBe(200);
    expect(captured.body.ok).toBe(true);
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'error',
        event: 'security.notificationDispatchFailed',
      }),
    );
  });
});
