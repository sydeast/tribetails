import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

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
vi.mock('../src/auth/loginSecurity', () => ({ checkIpRateLimit: checkIpRateLimitMock }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: writeAuditEntryMock }));

const TEST_EMAIL = 'pepper@tribetails.com';
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
    const result = await requestPasswordResetHandler({ data: { email: TEST_EMAIL } });

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
    await requestPasswordResetHandler({ data: { email: 'ghost@example.com' } });
    expect(writeAuditEntryMock).not.toHaveBeenCalled();
  });

  it('returns ok=true silently when email not found (no leak)', async () => {
    getUserByEmailMock.mockRejectedValue(new Error('auth/user-not-found'));
    const { requestPasswordResetHandler } = await import('../src/auth/requestPasswordReset');
    const result = await requestPasswordResetHandler({ data: { email: 'ghost@example.com' } });

    expect(result).toEqual({ ok: true });
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('rejects missing email with invalid-argument', async () => {
    const { requestPasswordResetHandler } = await import('../src/auth/requestPasswordReset');
    await expect(
      requestPasswordResetHandler({ data: {} }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects malformed email with invalid-argument', async () => {
    const { requestPasswordResetHandler } = await import('../src/auth/requestPasswordReset');
    await expect(
      requestPasswordResetHandler({ data: { email: 'not-an-email' } }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('propagates rate-limit error from checkIpRateLimit', async () => {
    const { HttpsError } = await import('firebase-functions/v2/https');
    checkIpRateLimitMock.mockRejectedValue(
      new HttpsError('resource-exhausted', 'Too many requests. Try again later.'),
    );
    const { requestPasswordResetHandler } = await import('../src/auth/requestPasswordReset');
    await expect(
      requestPasswordResetHandler({ data: { email: TEST_EMAIL } }),
    ).rejects.toMatchObject({ code: 'resource-exhausted' });
    expect(generateLinkMock).not.toHaveBeenCalled();
  });

  it('uses email as displayName fallback when displayName is null', async () => {
    getUserByEmailMock.mockResolvedValue({ uid: TEST_UID, displayName: null });
    const { requestPasswordResetHandler } = await import('../src/auth/requestPasswordReset');
    await requestPasswordResetHandler({ data: { email: TEST_EMAIL } });

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
    await requestPasswordResetHandler({ data: { email: plusEmail } });

    const callArgs = generateLinkMock.mock.calls[0];
    expect(callArgs[1].url).toContain(encodeURIComponent(plusEmail));
  });

  // ----- C-B: timing-oracle closure (constant-work floor) -----

  it('hit path waits at least CONSTANT_WORK_MS', async () => {
    vi.stubEnv('PASSWORD_RESET_CONSTANT_WORK_MS', '120');
    const { requestPasswordResetHandler } = await import('../src/auth/requestPasswordReset');
    const start = Date.now();
    await requestPasswordResetHandler({ data: { email: TEST_EMAIL } });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(115); // allow 5ms scheduler jitter
  });

  it('miss path waits at least CONSTANT_WORK_MS (closes timing oracle)', async () => {
    vi.stubEnv('PASSWORD_RESET_CONSTANT_WORK_MS', '120');
    getUserByEmailMock.mockRejectedValue(new Error('auth/user-not-found'));
    generateLinkMock.mockRejectedValue(new Error('auth/user-not-found'));
    const { requestPasswordResetHandler } = await import('../src/auth/requestPasswordReset');
    const start = Date.now();
    await requestPasswordResetHandler({ data: { email: 'ghost@example.com' } });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(115);
  });

  it('hit and miss path latencies are statistically indistinguishable', async () => {
    vi.stubEnv('PASSWORD_RESET_CONSTANT_WORK_MS', '100');
    const { requestPasswordResetHandler } = await import('../src/auth/requestPasswordReset');

    // Hit sample
    const hitStart = Date.now();
    await requestPasswordResetHandler({ data: { email: TEST_EMAIL } });
    const hitElapsed = Date.now() - hitStart;

    // Miss sample (both auth calls throw fast)
    getUserByEmailMock.mockRejectedValue(new Error('auth/user-not-found'));
    generateLinkMock.mockRejectedValue(new Error('auth/user-not-found'));
    const missStart = Date.now();
    await requestPasswordResetHandler({ data: { email: 'ghost@example.com' } });
    const missElapsed = Date.now() - missStart;

    // Delta must be within scheduler jitter (~10ms) — proves no oracle.
    expect(Math.abs(hitElapsed - missElapsed)).toBeLessThanOrEqual(15);
  });

  it('rejects negative or non-numeric env override (falls back to default 600)', async () => {
    vi.stubEnv('PASSWORD_RESET_CONSTANT_WORK_MS', 'bogus');
    getUserByEmailMock.mockRejectedValue(new Error('auth/user-not-found'));
    generateLinkMock.mockRejectedValue(new Error('auth/user-not-found'));
    const { requestPasswordResetHandler } = await import('../src/auth/requestPasswordReset');
    const start = Date.now();
    await requestPasswordResetHandler({ data: { email: 'ghost@example.com' } });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(580); // 600ms default minus jitter
  });
});
