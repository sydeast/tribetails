/**
 * Tests for confirmSecureResetHandler.
 *
 * Covers:
 *   - Input validation (method, required fields, password length)
 *   - Missing WEB_API_KEY: 503
 *   - Per-IP limit before any Identity Toolkit call, keyed on the entry Google
 *     appended to X-Forwarded-For, never the forgeable first entry (#892 review)
 *   - The email is DERIVED from the oobCode (#892): a verify-only Identity
 *     Toolkit call runs first, and a client-sent email is never trusted
 *   - The verified code must be a PASSWORD_RESET code (#892 review)
 *   - The 3-per-24h account limit counts only resets that were applied, and a
 *     pending attempt holds a slot so concurrent calls cannot exceed it
 *   - Identity Toolkit unreachable: 502, rejects oobCode: 400
 *   - Happy path: incident doc written, alert enqueued under the key for the
 *     account's role (kinfolk or staff), 200
 *   - Notification failure does NOT block the 200 response (fail-loud log only)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  /** Every Firestore doc the fake transaction reads or writes, by path. */
  store: new Map<string, Record<string, unknown>>(),
  incidentSet: vi.fn(),
  incidentId: 'incident-abc',
  getFirestore: vi.fn(),
  getUserByEmail: vi.fn(),
  enqueueNotification: vi.fn(),
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
vi.mock('firebase-admin/auth', () => ({ getAuth: () => ({ getUserByEmail: mocks.getUserByEmail }) }));
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

const CLIENT_IP = '203.0.113.9';

function makeReq(body: unknown, opts: { method?: string; xff?: string } = {}) {
  return {
    method: opts.method ?? 'POST',
    body,
    headers: { 'x-forwarded-for': opts.xff ?? CLIENT_IP } as Record<string, string | undefined>,
    socket: { remoteAddress: '10.0.0.1' },
  };
}

const hash32 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);
const emailDoc = (email: string) => `securityRateLimits/secureReset_${hash32(email)}`;
const ipDoc = (ip: string) => `securityRateLimits/secureResetIp_${hash32(ip)}`;

/**
 * A Firestore fake with real state: transactions read and merge-write the docs
 * in `mocks.store`, so a test can seed prior attempts and read back exactly
 * what the handler recorded.
 */
function installFakeDb() {
  mocks.incidentSet.mockResolvedValue(undefined);
  const fakeDb: any = {
    collection: vi.fn((name: string) => ({
      doc: vi.fn((id?: string) =>
        name === 'securityIncidents' ? { id: mocks.incidentId, set: mocks.incidentSet } : { path: `${name}/${id}` },
      ),
    })),
    runTransaction: vi.fn(async (fn: (tx: any) => Promise<unknown>) =>
      fn({
        get: async (ref: { path: string }) => ({ data: () => mocks.store.get(ref.path) }),
        set: (ref: { path: string }, data: Record<string, unknown>) => {
          mocks.store.set(ref.path, { ...(mocks.store.get(ref.path) ?? {}), ...data });
        },
      }),
    ),
  };
  mocks.getFirestore.mockReturnValue(fakeDb);
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
  };
}

/**
 * Identity Toolkit as the handler sees it: the first resetPassword (oobCode
 * only) verifies and names the account, the second (with newPassword)
 * consumes the code.
 */
function identityToolkit(
  opts: { email?: string; requestType?: string; verifyStatus?: number; consumeStatus?: number } = {},
) {
  const email = opts.email ?? OWNER_EMAIL;
  const requestType = opts.requestType ?? 'PASSWORD_RESET';
  const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    const sent = JSON.parse(init.body) as { oobCode: string; newPassword?: string };
    if (sent.newPassword === undefined) {
      const status = opts.verifyStatus ?? 200;
      return status === 200
        ? jsonResponse(200, { email, requestType })
        : jsonResponse(status, { error: { message: 'EXPIRED_OOB_CODE' } });
    }
    const status = opts.consumeStatus ?? 200;
    return status === 200
      ? jsonResponse(200, { email, requestType })
      : jsonResponse(status, { error: { message: 'WEAK_PASSWORD' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function run(body: unknown = VALID_BODY, opts: { method?: string; xff?: string } = {}) {
  const { confirmSecureResetHandler } = await import('../src/security/confirmSecureReset.js');
  const { res, captured } = captureRes();
  await confirmSecureResetHandler(makeReq(body, opts), res);
  return captured;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.resetModules();
  mocks.store.clear();
  mocks.incidentSet.mockReset();
  mocks.getFirestore.mockReset();
  mocks.getUserByEmail.mockReset();
  mocks.getUserByEmail.mockResolvedValue({ uid: 'kf-uid', customClaims: { kinfolkId: 'kf-1' } });
  mocks.enqueueNotification.mockReset();
  mocks.enqueueNotification.mockResolvedValue(['notif-1']);
  mocks.logEvent.mockReset();
  installFakeDb();
  process.env.WEB_API_KEY = 'test-api-key';
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.WEB_API_KEY;
});

// ── Input validation ──────────────────────────────────────────────────────────

describe('confirmSecureResetHandler: input validation', () => {
  it('rejects non-POST with 405', async () => {
    const captured = await run(VALID_BODY, { method: 'GET' });
    expect(captured.status).toBe(405);
    expect(captured.body.error).toBe('method_not_allowed');
  });

  it('rejects missing oobCode with 400', async () => {
    const captured = await run({ newPassword: 'abc12345' });
    expect(captured.status).toBe(400);
    expect(captured.body.error).toBe('missing_required');
  });

  it('rejects missing newPassword with 400', async () => {
    const captured = await run({ oobCode: 'abc' });
    expect(captured.status).toBe(400);
    expect(captured.body.error).toBe('missing_required');
  });

  it('does NOT require an email: the server derives it from the oobCode (#892)', async () => {
    identityToolkit();
    expect((await run()).status).toBe(200);
  });

  it('rejects password shorter than 8 chars with 400', async () => {
    const captured = await run({ oobCode: 'abc', newPassword: 'short' });
    expect(captured.status).toBe(400);
    expect(captured.body.error).toBe('password_too_short');
  });
});

// ── Missing API key ───────────────────────────────────────────────────────────

describe('confirmSecureResetHandler: missing WEB_API_KEY', () => {
  it('returns 503 server_misconfigured when WEB_API_KEY is unset, before any Identity Toolkit call', async () => {
    delete process.env.WEB_API_KEY;
    const fetchMock = identityToolkit();
    const captured = await run();
    expect(captured.status).toBe(503);
    expect(captured.body.error).toBe('server_misconfigured');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── Per-IP limit ──────────────────────────────────────────────────────────────

describe('confirmSecureResetHandler: per-IP limit before verify (#892 review)', () => {
  const tenRecent = () => Array.from({ length: 10 }, (_, i) => Date.now() - (i + 1) * 1000);

  it('refuses with 429 and never calls Identity Toolkit once the IP has used its window', async () => {
    mocks.store.set(ipDoc(CLIENT_IP), { timestamps: tenRecent() });
    const fetchMock = identityToolkit();
    const captured = await run();
    expect(captured.status).toBe(429);
    expect(captured.body).toEqual({ ok: false, reason: 'rate_limited' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('records one attempt per call against the client IP, including a call whose code is bad', async () => {
    identityToolkit({ verifyStatus: 400 });
    await run();
    expect((mocks.store.get(ipDoc(CLIENT_IP))?.timestamps as number[]).length).toBe(1);
  });

  it('keys on the entry Google appended, so rotating the first X-Forwarded-For entry does not reset it', async () => {
    mocks.store.set(ipDoc(CLIENT_IP), { timestamps: tenRecent() });
    const fetchMock = identityToolkit();
    for (const forged of ['198.51.100.1', '198.51.100.2', '1.1.1.1']) {
      const captured = await run(VALID_BODY, { xff: `${forged}, ${CLIENT_IP}` });
      expect(captured.status, forged).toBe(429);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.store.has(ipDoc('198.51.100.1'))).toBe(false);
  });

  it('names the trusted IP in the incident, not the forged first entry', async () => {
    identityToolkit();
    await run(VALID_BODY, { xff: `6.6.6.6, ${CLIENT_IP}` });
    expect((mocks.incidentSet.mock.calls[0]![0] as Record<string, unknown>).ip).toBe(CLIENT_IP);
  });
});

// ── Derived email ─────────────────────────────────────────────────────────────

describe('confirmSecureResetHandler: email comes from the oobCode, never the client (#892)', () => {
  it('verifies the code first with oobCode ONLY, then consumes it with the new password', async () => {
    const fetchMock = identityToolkit();
    await run();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [verifyUrl, verifyInit] = fetchMock.mock.calls[0]!;
    expect(verifyUrl).toBe('https://identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=test-api-key');
    expect(JSON.parse(verifyInit.body)).toEqual({ oobCode: VALID_BODY.oobCode });
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({
      oobCode: VALID_BODY.oobCode,
      newPassword: VALID_BODY.newPassword,
    });
  });

  it('names the oobCode owner in the incident and notification even when the client sends another email', async () => {
    identityToolkit({ email: OWNER_EMAIL });
    const captured = await run({ ...VALID_BODY, email: 'someone-else@example.com' });

    expect(captured.status).toBe(200);
    const incident = mocks.incidentSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(incident.kinfolkEmail).toBe(OWNER_EMAIL);
    expect(mocks.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ kinfolkEmail: OWNER_EMAIL }) }),
    );
  });

  it('keys the account limit on the DERIVED email hash, not the client-sent one', async () => {
    identityToolkit({ email: OWNER_EMAIL });
    await run({ ...VALID_BODY, email: 'rotating-alias@example.com' });
    expect(mocks.store.has(emailDoc(OWNER_EMAIL))).toBe(true);
    expect(mocks.store.has(emailDoc('rotating-alias@example.com'))).toBe(false);
  });

  it('calls the Auth emulator when FIREBASE_AUTH_EMULATOR_HOST is set', async () => {
    process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9499';
    const fetchMock = identityToolkit();
    await run();
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'http://127.0.0.1:9499/identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=test-api-key',
    );
  });

  it('returns 400 reset_failed and consumes nothing when the verify call names no email', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { requestType: 'PASSWORD_RESET' }));
    vi.stubGlobal('fetch', fetchMock);
    const captured = await run();
    expect(captured.status).toBe(400);
    expect(captured.body.error).toBe('reset_failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.incidentSet).not.toHaveBeenCalled();
  });
});

// ── Code type ─────────────────────────────────────────────────────────────────

describe('confirmSecureResetHandler: only a password reset code is accepted (#892 review)', () => {
  it.each(['VERIFY_EMAIL', 'RECOVER_EMAIL', 'VERIFY_AND_CHANGE_EMAIL', ''])(
    'returns 400 for a %s code, before the account limit and without consuming it',
    async (requestType) => {
      const fetchMock = identityToolkit({ requestType });
      const captured = await run();
      expect(captured.status).toBe(400);
      expect(captured.body).toEqual({ error: 'reset_failed', detail: 'wrong_code_type' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(mocks.store.has(emailDoc(OWNER_EMAIL))).toBe(false);
      expect(mocks.incidentSet).not.toHaveBeenCalled();
    },
  );
});

// ── Account limit ─────────────────────────────────────────────────────────────

describe('confirmSecureResetHandler: account limit (3 applied resets per 24h)', () => {
  it('HAPPY: 2 prior resets in window, the third is applied and recorded', async () => {
    const now = Date.now();
    mocks.store.set(emailDoc(OWNER_EMAIL), { timestamps: [now - 1000, now - 2000] });
    identityToolkit();
    expect((await run()).status).toBe(200);
    const doc = mocks.store.get(emailDoc(OWNER_EMAIL))!;
    expect((doc.timestamps as number[]).length).toBe(3);
    expect(doc.pending).toEqual([]);
  });

  it('SAD: 3 prior resets in window, 429 and the code is NOT consumed', async () => {
    const now = Date.now();
    mocks.store.set(emailDoc(OWNER_EMAIL), { timestamps: [now - 1000, now - 2000, now - 3000] });
    const fetchMock = identityToolkit();
    const captured = await run();
    expect(captured.status).toBe(429);
    expect(captured.body).toEqual({ ok: false, reason: 'rate_limited' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueNotification).not.toHaveBeenCalled();
  });

  it('a rejected apply (weak password, a code used in another tab) does not use up a slot', async () => {
    identityToolkit({ consumeStatus: 400 });
    const captured = await run();
    expect(captured.status).toBe(400);
    const doc = mocks.store.get(emailDoc(OWNER_EMAIL))!;
    expect(doc.timestamps ?? []).toEqual([]);
    expect(doc.pending).toEqual([]);
  });

  it('an unreachable apply does not use up a slot either', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) return jsonResponse(200, { email: OWNER_EMAIL, requestType: 'PASSWORD_RESET' });
        throw new Error('network down');
      }),
    );
    expect((await run()).status).toBe(502);
    const doc = mocks.store.get(emailDoc(OWNER_EMAIL))!;
    expect(doc.timestamps ?? []).toEqual([]);
    expect(doc.pending).toEqual([]);
  });

  it('attempts still in flight hold their slots, so concurrent calls cannot exceed the limit', async () => {
    const now = Date.now();
    mocks.store.set(emailDoc(OWNER_EMAIL), {
      timestamps: [now - 5000],
      pending: [
        { id: 'a', atMs: now - 1000 },
        { id: 'b', atMs: now - 2000 },
      ],
    });
    const fetchMock = identityToolkit();
    expect((await run()).status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a pending slot older than its lease is ignored, so a crashed call cannot hold it forever', async () => {
    const now = Date.now();
    mocks.store.set(emailDoc(OWNER_EMAIL), {
      timestamps: [now - 5000],
      pending: [
        { id: 'a', atMs: now - 10 * 60 * 1000 },
        { id: 'b', atMs: now - 11 * 60 * 1000 },
      ],
    });
    identityToolkit();
    expect((await run()).status).toBe(200);
  });

  it('EDGE: resets older than 24h do not count', async () => {
    const expired = Array.from({ length: 5 }, (_, i) => Date.now() - 25 * 60 * 60 * 1000 - i * 1000);
    mocks.store.set(emailDoc(OWNER_EMAIL), { timestamps: expired });
    identityToolkit();
    expect((await run()).status).toBe(200);
  });

  it('rate-limited request logs warn event', async () => {
    const now = Date.now();
    mocks.store.set(emailDoc(OWNER_EMAIL), { timestamps: [now - 1000, now - 2000, now - 3000] });
    identityToolkit();
    await run();
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'warn', event: 'security.secureResetRateLimited' }),
    );
  });
});

// ── Identity Toolkit failures ─────────────────────────────────────────────────

describe('confirmSecureResetHandler: Identity Toolkit errors', () => {
  it('returns 502 when fetch throws (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const captured = await run();
    expect(captured.status).toBe(502);
    expect(captured.body.error).toBe('auth_unreachable');
  });

  it('returns 400 when Identity Toolkit rejects the oobCode at verify (expired or used)', async () => {
    const fetchMock = identityToolkit({ verifyStatus: 400 });
    const captured = await run();
    expect(captured.status).toBe(400);
    expect(captured.body.error).toBe('reset_failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.store.has(emailDoc(OWNER_EMAIL))).toBe(false);
  });

  it('returns 400 when Identity Toolkit rejects the consume call', async () => {
    identityToolkit({ consumeStatus: 400 });
    const captured = await run();
    expect(captured.status).toBe(400);
    expect(captured.body.error).toBe('reset_failed');
    expect(mocks.incidentSet).not.toHaveBeenCalled();
  });
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe('confirmSecureResetHandler: happy path', () => {
  it('writes incident doc, enqueues the kinfolk alert, returns 200 with incidentId', async () => {
    identityToolkit();
    const captured = await run();

    expect(captured.status).toBe(200);
    expect(captured.body.ok).toBe(true);
    expect(captured.body.incidentId).toBe(mocks.incidentId);

    expect(mocks.incidentSet).toHaveBeenCalledOnce();
    const incidentData = mocks.incidentSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(incidentData.type).toBe('unsolicited_password_reset');
    expect(incidentData.accountRole).toBe('kinfolk');
    expect(incidentData.accountEmail).toBe(OWNER_EMAIL);
    expect(incidentData.kinfolkEmail).toBe(OWNER_EMAIL);
    expect(incidentData.oobCodePrefix).toBe(VALID_BODY.oobCode.slice(0, 8));

    expect(mocks.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'security.breach_attempt.kinfolk',
        data: expect.objectContaining({ kinfolkEmail: OWNER_EMAIL, incidentId: mocks.incidentId }),
      }),
    );
  });

  it('alerts under the staff key, labelled as a staff account, when the account holds the admin claim (#892 review)', async () => {
    mocks.getUserByEmail.mockResolvedValue({ uid: 'op-1', customClaims: { admin: true } });
    identityToolkit({ email: 'ops@tribetails.com' });
    expect((await run()).status).toBe(200);

    expect(mocks.getUserByEmail).toHaveBeenCalledWith('ops@tribetails.com');
    const call = mocks.enqueueNotification.mock.calls[0]![0] as { key: string; data: Record<string, unknown> };
    expect(call.key).toBe('security.breach_attempt.staff');
    expect(call.data).toEqual(expect.objectContaining({ staffEmail: 'ops@tribetails.com', incidentId: mocks.incidentId }));
    expect(call.data).not.toHaveProperty('kinfolkEmail');

    const incident = mocks.incidentSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(incident.accountRole).toBe('staff');
    expect(incident.kinfolkEmail).toBeNull();
    expect(incident.staffEmail).toBe('ops@tribetails.com');
  });

  it('still alerts, under the kinfolk key with a warning logged, when the role lookup fails', async () => {
    mocks.getUserByEmail.mockRejectedValue(new Error('auth unavailable'));
    identityToolkit();
    expect((await run()).status).toBe(200);
    expect(mocks.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'security.breach_attempt.kinfolk' }),
    );
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'warn', event: 'security.roleLookupFailed' }),
    );
  });

  it('returns 200 even when notification dispatch throws (fail-loud log)', async () => {
    identityToolkit();
    mocks.enqueueNotification.mockRejectedValue(new Error('smtp2go down'));
    const captured = await run();

    expect(captured.status).toBe(200);
    expect(captured.body.ok).toBe(true);
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'error', event: 'security.notificationDispatchFailed' }),
    );
  });
});
