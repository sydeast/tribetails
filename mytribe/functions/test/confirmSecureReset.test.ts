/**
 * Tests for confirmSecureResetHandler.
 *
 * Covers:
 *   - Input validation (method, required fields, password length, email format)
 *   - Email-based rate-limit guard (429 before Identity Toolkit call)
 *   - Missing WEB_API_KEY → 503
 *   - Identity Toolkit unreachable → 502
 *   - Identity Toolkit rejects oobCode → 400
 *   - Happy-path: incident doc written + notification enqueued → 200
 *   - Notification failure does NOT block 200 response (fail-loud log only)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  // Firestore transaction internals
  txGet: vi.fn(),
  txSet: vi.fn(),
  // Doc ref for the securityIncidents collection
  incidentSet: vi.fn(),
  incidentId: 'incident-abc',
  // Top-level fakeDb reference — replaced per-test
  fakeDb: null as any,
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
      doc: vi.fn((_id?: string) => {
        if (name === 'securityRateLimits') {
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

const VALID_BODY = {
  oobCode: 'oobCode-abc12345',
  newPassword: 'hunter2hunter',
  email: 'pepper@tribetails.com',
};

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.resetModules();
  mocks.txGet.mockReset();
  mocks.txSet.mockReset();
  mocks.incidentSet.mockReset();
  mocks.getFirestore.mockReset();
  mocks.enqueueNotification.mockReset();
  mocks.logEvent.mockReset();
  delete process.env.WEB_API_KEY;
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
    await confirmSecureResetHandler(makeReq({ newPassword: 'abc12345', email: 'a@b.com' }), res);
    expect(captured.status).toBe(400);
    expect(captured.body.error).toBe('missing_required');
  });

  it('rejects missing newPassword with 400', async () => {
    const { confirmSecureResetHandler } = await import('../src/security/confirmSecureReset.js');
    const { res, captured } = captureRes();
    await confirmSecureResetHandler(makeReq({ oobCode: 'abc', email: 'a@b.com' }), res);
    expect(captured.status).toBe(400);
    expect(captured.body.error).toBe('missing_required');
  });

  it('rejects missing email with 400', async () => {
    const { confirmSecureResetHandler } = await import('../src/security/confirmSecureReset.js');
    const { res, captured } = captureRes();
    await confirmSecureResetHandler(makeReq({ oobCode: 'abc', newPassword: 'abc12345' }), res);
    expect(captured.status).toBe(400);
    expect(captured.body.error).toBe('missing_required');
  });

  it('rejects password shorter than 8 chars with 400', async () => {
    const { confirmSecureResetHandler } = await import('../src/security/confirmSecureReset.js');
    const { res, captured } = captureRes();
    await confirmSecureResetHandler(makeReq({ oobCode: 'abc', newPassword: 'short', email: 'a@b.com' }), res);
    expect(captured.status).toBe(400);
    expect(captured.body.error).toBe('password_too_short');
  });

  it('rejects invalid email (no @) with 400', async () => {
    const { confirmSecureResetHandler } = await import('../src/security/confirmSecureReset.js');
    const { res, captured } = captureRes();
    await confirmSecureResetHandler(makeReq({ oobCode: 'abc', newPassword: 'abc12345', email: 'notanemail' }), res);
    expect(captured.status).toBe(400);
    expect(captured.body.error).toBe('invalid_email');
  });
});

// ── Rate-limit guard ──────────────────────────────────────────────────────────

describe('confirmSecureResetHandler — email rate-limit (3 per 24h)', () => {
  it('HAPPY: under limit (0 prior attempts) — passes through to WEB_API_KEY check', async () => {
    // Rate-limit passes; no WEB_API_KEY set → expect 503 (proves we got past rate-limit)
    buildFakeDb({ existingTimestamps: [] });
    process.env.WEB_API_KEY = ''; // clear so it hits the key-check branch
    const { confirmSecureResetHandler } = await import('../src/security/confirmSecureReset.js');
    const { res, captured } = captureRes();
    await confirmSecureResetHandler(makeReq(VALID_BODY), res);
    // Got past rate-limit; hits missing-key guard
    expect(captured.status).toBe(503);
    expect(captured.body.error).toBe('server_misconfigured');
  });

  it('HAPPY: exactly 2 prior attempts in window — third is allowed', async () => {
    const now = Date.now();
    const priorTwo = [now - 1000, now - 2000]; // 2 recent, within 24h
    buildFakeDb({ existingTimestamps: priorTwo });
    process.env.WEB_API_KEY = ''; // key missing → 503 proves rate-limit passed
    const { confirmSecureResetHandler } = await import('../src/security/confirmSecureReset.js');
    const { res, captured } = captureRes();
    await confirmSecureResetHandler(makeReq(VALID_BODY), res);
    expect(captured.status).toBe(503);
    expect(captured.body.error).toBe('server_misconfigured');
    // The transaction set should have been called to record this third attempt
    expect(mocks.txSet).toHaveBeenCalledOnce();
  });

  it('SAD: 3 prior attempts in 24h window → 429 rate_limited', async () => {
    const now = Date.now();
    const priorThree = [now - 1000, now - 2000, now - 3000];
    buildFakeDb({ existingTimestamps: priorThree });
    const { confirmSecureResetHandler } = await import('../src/security/confirmSecureReset.js');
    const { res, captured } = captureRes();
    await confirmSecureResetHandler(makeReq(VALID_BODY), res);
    expect(captured.status).toBe(429);
    expect(captured.body).toEqual({ ok: false, reason: 'rate_limited' });
    // Identity Toolkit must NOT have been called
    expect(mocks.enqueueNotification).not.toHaveBeenCalled();
  });

  it('SAD: 5 prior attempts (abuse) → 429 rate_limited', async () => {
    const now = Date.now();
    const many = Array.from({ length: 5 }, (_, i) => now - (i + 1) * 1000);
    buildFakeDb({ existingTimestamps: many });
    const { confirmSecureResetHandler } = await import('../src/security/confirmSecureReset.js');
    const { res, captured } = captureRes();
    await confirmSecureResetHandler(makeReq(VALID_BODY), res);
    expect(captured.status).toBe(429);
    expect(captured.body.reason).toBe('rate_limited');
    // When limited, txSet must NOT be called (no unbounded array growth)
    expect(mocks.txSet).not.toHaveBeenCalled();
  });

  it('EDGE: expired timestamps (>24h old) do not count — request is allowed', async () => {
    const expired = Array.from(
      { length: 5 },
      (_, i) => Date.now() - 25 * 60 * 60 * 1000 - i * 1000, // > 24h ago
    );
    buildFakeDb({ existingTimestamps: expired });
    process.env.WEB_API_KEY = ''; // key missing → 503 proves rate-limit passed
    const { confirmSecureResetHandler } = await import('../src/security/confirmSecureReset.js');
    const { res, captured } = captureRes();
    await confirmSecureResetHandler(makeReq(VALID_BODY), res);
    expect(captured.status).toBe(503); // got past rate-limit check
    expect(captured.body.error).toBe('server_misconfigured');
  });

  it('rate-limited request logs warn event', async () => {
    const now = Date.now();
    buildFakeDb({ existingTimestamps: [now - 1000, now - 2000, now - 3000] });
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

// ── Missing API key ───────────────────────────────────────────────────────────

describe('confirmSecureResetHandler — missing WEB_API_KEY', () => {
  it('returns 503 server_misconfigured when WEB_API_KEY is unset', async () => {
    buildFakeDb({ existingTimestamps: [] });
    delete process.env.WEB_API_KEY; // ensure unset
    const { confirmSecureResetHandler } = await import('../src/security/confirmSecureReset.js');
    const { res, captured } = captureRes();
    await confirmSecureResetHandler(makeReq(VALID_BODY), res);
    expect(captured.status).toBe(503);
    expect(captured.body.error).toBe('server_misconfigured');
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
    vi.unstubAllGlobals();
  });

  it('returns 400 when Identity Toolkit rejects oobCode', async () => {
    buildFakeDb({ existingTimestamps: [] });
    process.env.WEB_API_KEY = 'test-api-key';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { message: 'INVALID_OOB_CODE' } }),
    }));

    const { confirmSecureResetHandler } = await import('../src/security/confirmSecureReset.js');
    const { res, captured } = captureRes();
    await confirmSecureResetHandler(makeReq(VALID_BODY), res);
    expect(captured.status).toBe(400);
    expect(captured.body.error).toBe('reset_failed');
    vi.unstubAllGlobals();
  });
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe('confirmSecureResetHandler — happy path', () => {
  it('writes incident doc + enqueues notification + returns 200 with incidentId', async () => {
    buildFakeDb({ existingTimestamps: [] });
    process.env.WEB_API_KEY = 'test-api-key';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    mocks.enqueueNotification.mockResolvedValue(['notif-1']);

    const { confirmSecureResetHandler } = await import('../src/security/confirmSecureReset.js');
    const { res, captured } = captureRes();
    await confirmSecureResetHandler(makeReq(VALID_BODY), res);

    expect(captured.status).toBe(200);
    expect(captured.body.ok).toBe(true);
    expect(captured.body.incidentId).toBe(mocks.incidentId);

    // incident doc was written
    expect(mocks.incidentSet).toHaveBeenCalledOnce();
    const incidentData = mocks.incidentSet.mock.calls[0][0] as Record<string, unknown>;
    expect(incidentData.type).toBe('unsolicited_password_reset');
    expect(incidentData.kinfolkEmail).toBe(VALID_BODY.email);
    expect(incidentData.oobCodePrefix).toBe(VALID_BODY.oobCode.slice(0, 8));

    // notification was dispatched
    expect(mocks.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'security.breach_attempt.kinfolk',
        data: expect.objectContaining({
          kinfolkEmail: VALID_BODY.email,
          incidentId: mocks.incidentId,
        }),
      }),
    );

    vi.unstubAllGlobals();
  });

  it('returns 200 even when notification dispatch throws (fail-loud log)', async () => {
    buildFakeDb({ existingTimestamps: [] });
    process.env.WEB_API_KEY = 'test-api-key';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    mocks.enqueueNotification.mockRejectedValue(new Error('sendgrid down'));

    const { confirmSecureResetHandler } = await import('../src/security/confirmSecureReset.js');
    const { res, captured } = captureRes();
    await confirmSecureResetHandler(makeReq(VALID_BODY), res);

    // Still 200 — notification failure must not block the reset response
    expect(captured.status).toBe(200);
    expect(captured.body.ok).toBe(true);

    // Fail-loud log: notification dispatch error was recorded
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'error',
        event: 'security.notificationDispatchFailed',
      }),
    );

    vi.unstubAllGlobals();
  });
});
