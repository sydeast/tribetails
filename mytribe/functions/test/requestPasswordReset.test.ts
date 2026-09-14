import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { callableRequest } from './_helpers/callableRequest';

const getUserByEmailMock = vi.fn();
const generateLinkMock = vi.fn();
const enqueueMock = vi.fn();
const logEventMock = vi.fn();
const checkIpRateLimitMock = vi.fn().mockResolvedValue(undefined);
const writeAuditEntryMock = vi.fn().mockResolvedValue('audit-id');

// `db` mock supports the inline per-email rate-limit transaction added 2026-05-19.
// The tx callback receives a fake transaction with no-op get/set; the rate-limit
// helper sees an empty timestamps array and writes one entry — never throws.
const txGetMock = vi.fn().mockResolvedValue({ data: () => undefined });
const txSetMock = vi.fn();
const dbMock = {
  collection: () => ({ doc: () => ({}) }),
  runTransaction: async (cb: (tx: { get: typeof txGetMock; set: typeof txSetMock }) => Promise<unknown>) =>
    cb({ get: txGetMock, set: txSetMock }),
};
vi.mock('../src/lib/firestoreAdmin', () => ({
  auth: () => ({
    getUserByEmail: getUserByEmailMock,
    generatePasswordResetLink: generateLinkMock,
  }),
  db: () => dbMock,
}));
vi.mock('../src/notifications', () => ({ enqueueNotification: enqueueMock }));
vi.mock('../src/lib/logger', () => ({ logEvent: logEventMock }));
vi.mock('../src/auth/loginSecurity', () => ({
  checkIpRateLimit: checkIpRateLimitMock,
  // #891: no account in this file is locked; requestPasswordResetLocked.test.ts covers locks.
  activeLockStartedAtMs: vi.fn(async () => null),
}));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: writeAuditEntryMock }));

const TEST_EMAIL = 'pepper@tribetails.com';
const GHOST_EMAIL = 'ghost@example.com';
const TEST_UID = 'uid-pepper';
const TEST_LINK = 'https://kinfolk.tribetails.com/account/secure-reset?oobCode=abc123';

beforeEach(() => {
  vi.clearAllMocks();
  // Default to 0ms constant-work floor so functional tests stay fast; the
  // timing-equality tests below override to a measurable value.
  vi.stubEnv('PASSWORD_RESET_CONSTANT_WORK_MS', '0');
  checkIpRateLimitMock.mockResolvedValue(undefined);
  getUserByEmailMock.mockResolvedValue({ uid: TEST_UID, displayName: 'Pepper Tuck' });
  generateLinkMock.mockResolvedValue(TEST_LINK);
  enqueueMock.mockResolvedValue(['notif-id-1']);
  writeAuditEntryMock.mockResolvedValue('audit-id');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe('requestPasswordResetHandler', () => {
  it('generates link + enqueues notification for known email', async () => {
    const { requestPasswordResetHandler } = await import('../src/auth/requestPasswordReset');
    const result = await requestPasswordResetHandler(callableRequest({ email: TEST_EMAIL }));

    expect(result).toEqual({ ok: true });
    expect(generateLinkMock).toHaveBeenCalledWith(
      TEST_EMAIL,
      expect.objectContaining({ url: expect.stringContaining('secure-reset') }),
    );
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'auth.password.reset',
        recipientUid: TEST_UID,
        data: expect.objectContaining({ link: TEST_LINK, email: TEST_EMAIL }),
      }),
    );
    expect(writeAuditEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'AUTH_PASSWORD_RESET_REQUESTED',
        actorUid: TEST_UID,
        severity: 'info',
      }),
    );
  });

  it('skips audit emit when email not found', async () => {
    getUserByEmailMock.mockRejectedValue(new Error('auth/user-not-found'));
    const { requestPasswordResetHandler } = await import('../src/auth/requestPasswordReset');
    await requestPasswordResetHandler(callableRequest({ email: 'ghost@example.com' }));
    expect(writeAuditEntryMock).not.toHaveBeenCalled();
  });

  it('returns ok=true silently when email not found (no leak)', async () => {
    getUserByEmailMock.mockRejectedValue(new Error('auth/user-not-found'));
    const { requestPasswordResetHandler } = await import('../src/auth/requestPasswordReset');
    const result = await requestPasswordResetHandler(callableRequest({ email: 'ghost@example.com' }));

    expect(result).toEqual({ ok: true });
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('rejects missing email with invalid-argument', async () => {
    const { requestPasswordResetHandler } = await import('../src/auth/requestPasswordReset');
    await expect(
      requestPasswordResetHandler(callableRequest({})),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects malformed email with invalid-argument', async () => {
    const { requestPasswordResetHandler } = await import('../src/auth/requestPasswordReset');
    await expect(
      requestPasswordResetHandler(callableRequest({ email: 'not-an-email' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('propagates rate-limit error from checkIpRateLimit', async () => {
    const { HttpsError } = await import('firebase-functions/v2/https');
    checkIpRateLimitMock.mockRejectedValue(
      new HttpsError('resource-exhausted', 'Too many requests. Try again later.'),
    );
    const { requestPasswordResetHandler } = await import('../src/auth/requestPasswordReset');
    await expect(
      requestPasswordResetHandler(callableRequest({ email: TEST_EMAIL })),
    ).rejects.toMatchObject({ code: 'resource-exhausted' });
    expect(generateLinkMock).not.toHaveBeenCalled();
  });

  it('uses email as displayName fallback when displayName is null', async () => {
    getUserByEmailMock.mockResolvedValue({ uid: TEST_UID, displayName: null });
    const { requestPasswordResetHandler } = await import('../src/auth/requestPasswordReset');
    await requestPasswordResetHandler(callableRequest({ email: TEST_EMAIL }));

    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ displayName: TEST_EMAIL }),
      }),
    );
  });

  it('link continueUrl encodes email param', async () => {
    const plusEmail = 'pepper+pet@tribetails.com';
    getUserByEmailMock.mockResolvedValue({ uid: TEST_UID, displayName: null });
    const { requestPasswordResetHandler } = await import('../src/auth/requestPasswordReset');
    await requestPasswordResetHandler(callableRequest({ email: plusEmail }));

    const callArgs = generateLinkMock.mock.calls[0];
    expect(callArgs[1].url).toContain(encodeURIComponent(plusEmail));
  });

  // ----- C-B: timing-oracle closure (constant-work floor) -----
  //
  // These assertions used to read the real clock and compare the result to a
  // hardcoded budget, most sharply `|hit - miss| <= 15`. That flakes. A single
  // `Date.now()` delta carries GC pauses, JIT warm-up and worker-pool
  // preemption on its tail, so the budget sat inside the measurement noise:
  // against a 100ms floor, single samples were observed at 113ms on an idle
  // machine, and the two samples are taken at different moments in the
  // worker's life, so nothing forces their overhead to match. It went red once
  // in a full-suite run and would have gone red again in CI.
  //
  // They now run on the fake clock, so what gets measured is how long the
  // handler makes the caller wait by its own reckoning. That is the quantity
  // an attacker samples, it is deterministic here, and it still goes red when
  // the oracle is put back.

  /**
   * Runs the handler on a fake clock and returns the virtual milliseconds the
   * caller waits for an answer.
   *
   * The timestamp is taken when the handler's promise settles, not after the
   * clock is drained, so a constant-work pad that gets scheduled but not
   * awaited still reads as 0 rather than passing by accident.
   *
   * Everything the handler awaits (auth, db, notifications) is mocked and
   * settles in a microtask, so virtual time only moves when the handler's own
   * constant-work timer fires. That makes the floor exactly measurable.
   *
   * What this proves: the handler pads to the same latency whether or not the
   * account exists. What it does NOT prove: that real Firebase round trips
   * stay under that floor in production. With the SDK mocked, no unit test can
   * see that. It is what the 600ms CONSTANT_WORK_MS_DEFAULT is sized for.
   */
  async function measureVirtualLatency(email: string): Promise<number> {
    const { requestPasswordResetHandler } = await import('../src/auth/requestPasswordReset');
    vi.useFakeTimers();
    try {
      const startMs = Date.now();
      let settledAtMs = -1;
      const pending = requestPasswordResetHandler(callableRequest({ email })).then((result) => {
        settledAtMs = Date.now();
        return result;
      });
      await vi.runAllTimersAsync();
      await pending;
      return settledAtMs - startMs;
    } finally {
      vi.useRealTimers();
    }
  }

  function stubUnknownEmail(): void {
    getUserByEmailMock.mockRejectedValue(new Error('auth/user-not-found'));
    generateLinkMock.mockRejectedValue(new Error('auth/user-not-found'));
  }

  it('does the same auth work for a known and an unknown email', async () => {
    const { requestPasswordResetHandler } = await import('../src/auth/requestPasswordReset');

    const hitResult = await requestPasswordResetHandler(callableRequest({ email: TEST_EMAIL }));
    const hitLookups = getUserByEmailMock.mock.calls.length;
    const hitLinks = generateLinkMock.mock.calls.length;

    stubUnknownEmail();
    const missResult = await requestPasswordResetHandler(callableRequest({ email: GHOST_EMAIL }));
    const missLookups = getUserByEmailMock.mock.calls.length - hitLookups;
    const missLinks = generateLinkMock.mock.calls.length - hitLinks;

    // The miss path must not short-circuit: it looks the user up AND asks for
    // a reset link, same as the hit path, even though both throw. Skipping
    // either call is the fast-throw oracle this handler exists to avoid.
    expect(hitLookups).toBe(1);
    expect(hitLinks).toBe(1);
    expect(missLookups).toBe(hitLookups);
    expect(missLinks).toBe(hitLinks);
    expect(generateLinkMock).toHaveBeenLastCalledWith(
      GHOST_EMAIL,
      expect.objectContaining({ url: expect.stringContaining('secure-reset') }),
    );
    expect(missResult).toEqual(hitResult);
  });

  it('hit path floors caller latency at CONSTANT_WORK_MS', async () => {
    vi.stubEnv('PASSWORD_RESET_CONSTANT_WORK_MS', '120');
    expect(await measureVirtualLatency(TEST_EMAIL)).toBe(120);
  });

  it('miss path floors caller latency at CONSTANT_WORK_MS (closes timing oracle)', async () => {
    vi.stubEnv('PASSWORD_RESET_CONSTANT_WORK_MS', '120');
    stubUnknownEmail();
    expect(await measureVirtualLatency(GHOST_EMAIL)).toBe(120);
  });

  it('hit and miss caller latencies are identical, to the millisecond', async () => {
    vi.stubEnv('PASSWORD_RESET_CONSTANT_WORK_MS', '100');

    const hitMs = await measureVirtualLatency(TEST_EMAIL);
    stubUnknownEmail();
    const missMs = await measureVirtualLatency(GHOST_EMAIL);

    // No tolerance to tune: on the fake clock these are equal or the handler
    // has an existence oracle.
    expect(missMs).toBe(hitMs);
    expect(hitMs).toBe(100);
  });

  it('rejects negative or non-numeric env override (falls back to default 600)', async () => {
    vi.stubEnv('PASSWORD_RESET_CONSTANT_WORK_MS', 'bogus');
    stubUnknownEmail();
    expect(await measureVirtualLatency(GHOST_EMAIL)).toBe(600);
  });
});
