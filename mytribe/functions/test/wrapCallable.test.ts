import { describe, it, expect, vi, beforeEach } from 'vitest';

const captureMock = vi.fn().mockReturnValue('sentry-id-1');
const logEventMock = vi.fn();
const mocks = vi.hoisted(() => ({
  writeAuditEntryMock: vi.fn().mockResolvedValue('a1'),
  // #557: the real check calls auth().getUser(). This spy stands in for it so
  // the wrapper's own contract — that it runs the check, ahead of the handler,
  // and reports the outcome — is assertable without a network dependency. The
  // check's own behavior is pinned in test/sessionRevocation.test.ts.
  assertSessionNotRevokedMock: vi.fn(),
}));
vi.mock('../src/lib/sentry', () => ({ captureFunctionError: captureMock, initSentry: () => {} }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryMock }));
vi.mock('../src/lib/logger', () => ({ logEvent: logEventMock }));
vi.mock('../src/lib/sessionRevocation', () => ({
  assertSessionNotRevoked: mocks.assertSessionNotRevokedMock,
  forgetSession: vi.fn(),
}));
const writeAuditEntryMock = mocks.writeAuditEntryMock;
const assertSessionNotRevokedMock = mocks.assertSessionNotRevokedMock;

describe('wrapCallable', () => {
  beforeEach(() => {
    logEventMock.mockClear();
    writeAuditEntryMock.mockClear();
    captureMock.mockClear();
    assertSessionNotRevokedMock.mockReset();
    assertSessionNotRevokedMock.mockResolvedValue({ outcome: 'miss', durationMs: 7 });
  });

  it('O-3 L1 telemetry: logs appCheck="absent" + no origin field when req.app/origin are missing', async () => {
    const { wrapCallable } = await import('../src/lib/wrapCallable');
    const wrapped = wrapCallable('test', async () => ({ ok: true }));
    await wrapped({ auth: { uid: 'u1' } } as any);
    expect(logEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'test.success', appCheck: 'absent' }),
    );
    expect(logEventMock.mock.calls[0]![0]).not.toHaveProperty('origin');
  });

  it('O-3 L1 telemetry: logs appCheck="valid" + origin when req.app + request origin are present', async () => {
    const { wrapCallable } = await import('../src/lib/wrapCallable');
    const wrapped = wrapCallable('test', async () => ({ ok: true }));
    await wrapped({
      auth: { uid: 'u1' },
      app: { appId: 'app-1' },
      rawRequest: { headers: { origin: 'https://mytribe-kinfolk-beta.web.app' } },
    } as any);
    expect(logEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'test.success',
        appCheck: 'valid',
        origin: 'https://mytribe-kinfolk-beta.web.app',
      }),
    );
  });

  it('O-3 L1 telemetry: failure path also logs appCheck/origin', async () => {
    const { wrapCallable } = await import('../src/lib/wrapCallable');
    const wrapped = wrapCallable('test', async () => {
      throw new Error('boom');
    });
    await expect(
      wrapped({ auth: { uid: 'u1' }, rawRequest: { headers: { origin: 'https://legacy.example' } } } as any),
    ).rejects.toBeTruthy();
    expect(logEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'test.failure', appCheck: 'absent', origin: 'https://legacy.example' }),
    );
  });

  it('returns handler result on success', async () => {
    const { wrapCallable } = await import('../src/lib/wrapCallable');
    const wrapped = wrapCallable('test', async () => ({ ok: true }));
    const result = await wrapped({ auth: { uid: 'u1' } } as any);
    expect(result.ok).toBe(true);
  });

  it('captures error and throws opaque HttpsError on failure', async () => {
    const { wrapCallable } = await import('../src/lib/wrapCallable');
    const wrapped = wrapCallable('test', async () => {
      throw new Error('secret detail');
    });
    await expect(wrapped({ auth: { uid: 'u1' } } as any)).rejects.toMatchObject({
      code: 'internal',
      message: expect.stringMatching(/error occurred/i),
    });
    expect(captureMock).toHaveBeenCalled();
  });

  // A4 audit (2026-08): the ERROR_FUNCTION_FAILURE entry written here carried
  // severity: 'warn' and no explicit status. writeAuditEntry's old default
  // guessed status from severity ('critical' -> FAILURE, else SUCCESS), so
  // every audited callable failure was silently recorded as SUCCESS. This
  // pins the audit entry's status to FAILURE so a regression trips a test,
  // not just a stale-looking activity log.
  it('audits a failing callable with status FAILURE, not SUCCESS', async () => {
    const { wrapCallable } = await import('../src/lib/wrapCallable');
    const wrapped = wrapCallable('test', async () => {
      throw new Error('boom');
    });
    await expect(wrapped({ auth: { uid: 'u1' } } as any)).rejects.toBeTruthy();
    expect(writeAuditEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'FAILURE', event: 'ERROR_FUNCTION_FAILURE' }),
    );
  });

  // -------------------------------------------------------------------------
  // #557 session revocation
  // -------------------------------------------------------------------------

  it('#557: runs the revocation check BEFORE the handler', async () => {
    const order: string[] = [];
    assertSessionNotRevokedMock.mockImplementation(async () => {
      order.push('check');
      return { outcome: 'miss', durationMs: 3 };
    });
    const { wrapCallable } = await import('../src/lib/wrapCallable');
    const wrapped = wrapCallable('getMyHome', async () => {
      order.push('handler');
      return { ok: true };
    });
    await wrapped({ auth: { uid: 'u1' } } as any);
    expect(order).toEqual(['check', 'handler']);
    expect(assertSessionNotRevokedMock).toHaveBeenCalledWith(
      expect.objectContaining({ auth: { uid: 'u1' } }),
      'getMyHome',
    );
  });

  it('#557: a revoked session is refused and the handler never runs', async () => {
    const { HttpsError } = await import('firebase-functions/v2/https');
    const handler = vi.fn();
    assertSessionNotRevokedMock.mockRejectedValue(
      new HttpsError('unauthenticated', 'Your session was ended (session-revoked). Sign in again.', {
        reason: 'session-revoked',
      }),
    );
    const { wrapCallable } = await import('../src/lib/wrapCallable');
    const wrapped = wrapCallable('getMyHome', handler);
    await expect(wrapped({ auth: { uid: 'u1' } } as any)).rejects.toMatchObject({
      code: 'unauthenticated',
      details: { reason: 'session-revoked' },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('#557: the refusal keeps its details across the wrapper, so clients can branch on reason', async () => {
    const { HttpsError } = await import('firebase-functions/v2/https');
    assertSessionNotRevokedMock.mockRejectedValue(
      new HttpsError('unauthenticated', 'This account is turned off (user-disabled). Contact Auntie.', {
        reason: 'user-disabled',
      }),
    );
    const { wrapCallable } = await import('../src/lib/wrapCallable');
    const wrapped = wrapCallable('getMyHome', async () => ({ ok: true }));
    await expect(wrapped({ auth: { uid: 'u1' } } as any)).rejects.toMatchObject({
      details: { reason: 'user-disabled' },
      message: expect.stringContaining('user-disabled'),
    });
    // A refused session is a user fault, not a server bug: it must not land in
    // the Sentry feed alongside real defects.
    expect(captureMock).not.toHaveBeenCalled();
    expect(logEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'getMyHome.failure', errorCode: 'unauthenticated' }),
    );
  });

  // A refusal must not be logged as 'skipped', which means "unauthenticated
  // caller, no lookup performed". Getting that wrong would put refusals into
  // the bucket the cost aggregation reads as "cost nothing".
  it('#557: a refusal is logged as authCheck="revoked", not "skipped"', async () => {
    const { HttpsError } = await import('firebase-functions/v2/https');
    assertSessionNotRevokedMock.mockRejectedValue(
      new HttpsError('unauthenticated', 'ended (session-revoked)', { reason: 'session-revoked' }),
    );
    const { wrapCallable } = await import('../src/lib/wrapCallable');
    const wrapped = wrapCallable('getMyHome', async () => ({ ok: true }));
    await expect(wrapped({ auth: { uid: 'u1' } } as any)).rejects.toBeTruthy();
    expect(logEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'getMyHome.failure', authCheck: 'revoked' }),
    );
  });

  it('#557: reports the check outcome + cost on the success log line', async () => {
    assertSessionNotRevokedMock.mockResolvedValue({ outcome: 'hit', durationMs: 0 });
    const { wrapCallable } = await import('../src/lib/wrapCallable');
    const wrapped = wrapCallable('getMyHome', async () => ({ ok: true }));
    await wrapped({ auth: { uid: 'u1' } } as any);
    expect(logEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'getMyHome.success', authCheck: 'hit', authCheckMs: 0 }),
    );
  });

  it('#557: reports the check outcome on the failure log line too', async () => {
    assertSessionNotRevokedMock.mockResolvedValue({ outcome: 'error', durationMs: 42 });
    const { wrapCallable } = await import('../src/lib/wrapCallable');
    const wrapped = wrapCallable('getMyHome', async () => {
      throw new Error('boom');
    });
    await expect(wrapped({ auth: { uid: 'u1' } } as any)).rejects.toBeTruthy();
    expect(logEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'getMyHome.failure', authCheck: 'error', authCheckMs: 42 }),
    );
  });
});
