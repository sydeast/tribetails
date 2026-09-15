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
 *     pending attempt holds a slot so concurrent calls cannot exceed it, even
 *     when Firestore re-runs a transaction (#892 review 2)
 *   - Limit docs carry a TTL `expiresAt` (#892 review 2)
 *   - A consume call that throws after the change landed still files the
 *     incident and the alert (#892 review 2)
 *   - Identity Toolkit unreachable: 502, rejects oobCode: 400
 *   - Happy path: incident doc written, alert enqueued under the key for the
 *     account's role (kinfolk, staff, or unknown), 200
 *   - Notification failure does NOT block the 200 response (fail-loud log only)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  /** Every Firestore doc the fake transaction reads or writes, by path. */
  store: new Map<string, Record<string, unknown>>(),
  /** Write count per doc path, for the fake's optimistic concurrency check. */
  versions: new Map<string, number>(),
  /** How many upcoming transaction attempts fail with contention and are re-run. */
  contendNext: 0,
  /** Transaction attempts made, including re-runs. */
  attempts: 0,
  /**
   * When set, the first `parties` reads of a doc whose path starts with `prefix`
   * wait for each other, so concurrent transactions genuinely overlap: every one
   * of them reads before any of them commits.
   */
  gate: null as null | { prefix: string; parties: number; seen: number; open: Promise<void>; release: () => void },
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
// The handler takes `clientIpOf` and `ipRateLimitKey` from auth/loginSecurity.ts
// (#908). That module also imports the notification stack, Sentry, the audit log
// and firestoreAdmin; none of them is exercised here, so they are stubbed rather
// than loaded.
// The handler reaches Firestore and Auth only through this module's lazy `db()`
// and `auth()` (#903 review: no bare admin getters). confirmSecureResetAppInit.test.ts
// covers the real module in a process with no initialized app.
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => mocks.getFirestore(),
  auth: () => ({ getUserByEmail: mocks.getUserByEmail }),
  getAdmin: vi.fn(),
}));
vi.mock('../src/notifications', () => ({ enqueueNotification: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ captureFunctionError: vi.fn(), initSentry: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn() }));

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

/** Yields to the event loop, so two concurrent handler calls interleave their reads. */
const tick = () => new Promise<void>((r) => setImmediate(r));

/**
 * A Firestore fake with real state and real transaction semantics: reads are
 * recorded, writes are buffered, and a commit whose read docs changed since the
 * read is discarded and the callback re-run, as Firestore does. `contendNext`
 * forces that re-run on demand. The callback's resolved value is what
 * `runTransaction` returns, exactly like the SDK.
 */
function installFakeDb() {
  mocks.incidentSet.mockResolvedValue(undefined);
  const fakeDb: any = {
    collection: vi.fn((name: string) => ({
      doc: vi.fn((id?: string) =>
        name === 'securityIncidents' ? { id: mocks.incidentId, set: mocks.incidentSet } : { path: `${name}/${id}` },
      ),
    })),
    runTransaction: vi.fn(async (fn: (tx: any) => Promise<unknown>) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        mocks.attempts += 1;
        const reads = new Map<string, number>();
        const writes: Array<[string, Record<string, unknown>]> = [];
        const result = await fn({
          get: async (ref: { path: string }) => {
            reads.set(ref.path, mocks.versions.get(ref.path) ?? 0);
            const data = mocks.store.get(ref.path);
            const gate = mocks.gate;
            if (gate && ref.path.startsWith(gate.prefix) && gate.seen < gate.parties) {
              gate.seen += 1;
              if (gate.seen === gate.parties) gate.release();
              await gate.open;
            }
            await tick();
            return { data: () => data };
          },
          set: (ref: { path: string }, data: Record<string, unknown>) => {
            writes.push([ref.path, data]);
          },
        });
        if (mocks.contendNext > 0) {
          mocks.contendNext -= 1;
          continue; // ABORTED: the attempt's writes are discarded and the callback runs again
        }
        const stale = [...reads].some(([path, v]) => (mocks.versions.get(path) ?? 0) !== v);
        if (stale) continue;
        for (const [path, data] of writes) {
          mocks.store.set(path, { ...(mocks.store.get(path) ?? {}), ...data });
          mocks.versions.set(path, (mocks.versions.get(path) ?? 0) + 1);
        }
        return result;
      }
      throw new Error('10 ABORTED: Too much contention on these documents.');
    }),
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

/** Calls that carried a new password, which is the one that changes it. */
const consumeCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter((c) => JSON.parse((c[1] as { body: string }).body).newPassword !== undefined);

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
  mocks.versions.clear();
  mocks.contendNext = 0;
  mocks.attempts = 0;
  mocks.gate = null;
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
  vi.useRealTimers();
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

  it('keys IPv6 on its /64, so rotating addresses inside one /64 does not reset it (#908 key)', async () => {
    mocks.store.set(ipDoc('2001:db8:1:2::/64'), { timestamps: tenRecent() });
    const fetchMock = identityToolkit();
    for (const rotated of ['2001:db8:1:2::1', '2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:db8:1:2:abcd::9']) {
      const captured = await run(VALID_BODY, { xff: rotated });
      expect(captured.status, rotated).toBe(429);
    }
    expect(fetchMock).not.toHaveBeenCalled();

    // A different /64 has its own budget.
    expect((await run(VALID_BODY, { xff: '2001:db8:1:3::1' })).status).toBe(200);
    expect((mocks.store.get(ipDoc('2001:db8:1:3::/64'))?.timestamps as number[]).length).toBe(1);
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

// ── Transaction re-runs ───────────────────────────────────────────────────────

describe('confirmSecureResetHandler: Firestore re-running a transaction (#892 review 2)', () => {
  it('a contended first attempt is re-run, and the slot is held and recorded exactly once', async () => {
    identityToolkit();
    mocks.contendNext = 2; // the IP ledger attempt and the hold attempt each fail once
    expect((await run()).status).toBe(200);
    expect(mocks.attempts).toBeGreaterThan(3);
    const doc = mocks.store.get(emailDoc(OWNER_EMAIL))!;
    expect((doc.timestamps as number[]).length).toBe(1);
    expect(doc.pending).toEqual([]);
  });

  it('two calls starting at 2 of 3: exactly one changes the password, the other is refused', async () => {
    const now = Date.now();
    mocks.store.set(emailDoc(OWNER_EMAIL), { timestamps: [now - 1000, now - 2000] });
    const fetchMock = identityToolkit();
    // Both holds read the account at 2 before either commits. One commits; the
    // other's commit is stale, so its callback re-runs, finds 3, and must refuse.
    let release!: () => void;
    const open = new Promise<void>((r) => (release = r));
    mocks.gate = { prefix: 'securityRateLimits/secureReset_', parties: 2, seen: 0, open, release };

    const [a, b] = await Promise.all([run(), run()]);

    expect([a.status, b.status].sort()).toEqual([200, 429]);
    expect(consumeCalls(fetchMock)).toHaveLength(1);
    expect((mocks.store.get(emailDoc(OWNER_EMAIL))!.timestamps as number[]).length).toBe(3);
    expect(mocks.incidentSet).toHaveBeenCalledTimes(1);
  });
});

// ── TTL ───────────────────────────────────────────────────────────────────────

describe('confirmSecureResetHandler: limit docs expire (#892 review 2)', () => {
  it('writes expiresAt as the window plus one hour on both limit docs', async () => {
    const NOW = Date.UTC(2026, 8, 14, 21, 0, 0);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    identityToolkit();
    expect((await run()).status).toBe(200);

    const HOUR = 60 * 60 * 1000;
    const ipExpires = mocks.store.get(ipDoc(CLIENT_IP))!.expiresAt as { toMillis(): number };
    const emailExpires = mocks.store.get(emailDoc(OWNER_EMAIL))!.expiresAt as { toMillis(): number };
    expect(ipExpires.toMillis()).toBe(NOW + 15 * 60 * 1000 + HOUR);
    expect(emailExpires.toMillis()).toBe(NOW + 24 * HOUR + HOUR);
  });

  it('declares the TTL policy on securityRateLimits.expiresAt', () => {
    const indexes = JSON.parse(readFileSync(resolve(__dirname, '..', '..', 'firestore.indexes.json'), 'utf8')) as {
      fieldOverrides: Array<{ collectionGroup: string; fieldPath: string; ttl?: boolean }>;
    };
    expect(indexes.fieldOverrides).toContainEqual(
      expect.objectContaining({ collectionGroup: 'securityRateLimits', fieldPath: 'expiresAt', ttl: true }),
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

// ── Consume throws ────────────────────────────────────────────────────────────

describe('confirmSecureResetHandler: the consume call throws (#892 review 2)', () => {
  /** verify ok, consume throws, then the re-check answers with `recheck`. */
  function consumeThrows(recheck: 'still-valid' | 'used' | 'unreachable') {
    let consumeSeen = false;
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const sent = JSON.parse(init.body) as { newPassword?: string };
      if (sent.newPassword !== undefined) {
        consumeSeen = true;
        throw new Error('socket hang up');
      }
      if (!consumeSeen) return jsonResponse(200, { email: OWNER_EMAIL, requestType: 'PASSWORD_RESET' });
      if (recheck === 'still-valid') return jsonResponse(200, { email: OWNER_EMAIL, requestType: 'PASSWORD_RESET' });
      if (recheck === 'used') return jsonResponse(400, { error: { message: 'INVALID_OOB_CODE' } });
      throw new Error('socket hang up again');
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('the code still verifies, so nothing changed: 502, slot released, no incident, no alert', async () => {
    consumeThrows('still-valid');
    const captured = await run();
    expect(captured.status).toBe(502);
    expect(captured.body.error).toBe('auth_unreachable');
    const doc = mocks.store.get(emailDoc(OWNER_EMAIL))!;
    expect(doc.timestamps ?? []).toEqual([]);
    expect(doc.pending).toEqual([]);
    expect(mocks.incidentSet).not.toHaveBeenCalled();
    expect(mocks.enqueueNotification).not.toHaveBeenCalled();
  });

  it('the code is gone and validSince moved, so the change landed: incident, alert, slot counted, 200', async () => {
    consumeThrows('used');
    mocks.getUserByEmail.mockResolvedValue({
      uid: 'kf-uid',
      customClaims: {},
      tokensValidAfterTime: new Date(Date.now() + 2000).toUTCString(),
    });
    const captured = await run();
    expect(captured.status).toBe(200);
    expect((mocks.incidentSet.mock.calls[0]![0] as Record<string, unknown>).outcome).toBe('applied');
    expect(mocks.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'security.breach_attempt.kinfolk' }),
    );
    expect((mocks.store.get(emailDoc(OWNER_EMAIL))!.timestamps as number[]).length).toBe(1);
  });

  it('nothing can confirm either way: incident marked unknown, alert sent, slot counted, 502 with the incident id', async () => {
    consumeThrows('unreachable');
    mocks.getUserByEmail.mockRejectedValue(new Error('auth unavailable'));
    const captured = await run();
    expect(captured.status).toBe(502);
    expect(captured.body).toEqual({ error: 'outcome_unknown', incidentId: mocks.incidentId });
    expect((mocks.incidentSet.mock.calls[0]![0] as Record<string, unknown>).outcome).toBe('unknown');
    expect(mocks.enqueueNotification).toHaveBeenCalledOnce();
    expect((mocks.store.get(emailDoc(OWNER_EMAIL))!.timestamps as number[]).length).toBe(1);
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
    expect(incidentData.outcome).toBe('applied');
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

  it('records the role as unknown when the lookup fails, and still alerts under the kinfolk key (#892 review 2)', async () => {
    mocks.getUserByEmail.mockRejectedValue(new Error('auth unavailable'));
    identityToolkit();
    expect((await run()).status).toBe(200);

    const incident = mocks.incidentSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(incident.accountRole).toBe('unknown');
    expect(incident.accountEmail).toBe(OWNER_EMAIL);
    expect(incident.kinfolkEmail).toBeNull();
    expect(mocks.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'security.breach_attempt.kinfolk',
        data: expect.objectContaining({ kinfolkEmail: OWNER_EMAIL }),
      }),
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
