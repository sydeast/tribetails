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
const securityDocGet = vi.fn().mockResolvedValue({ data: () => ({ appCheckMode: 'off' }) });
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({ collection: () => ({ doc: () => ({ get: securityDocGet }) }) }),
}));

/** The one callable in cohort 1 — see src/lib/appCheckPolicy.ts. */
const COHORT_FN = 'getBusinessClosures';

async function setMode(mode: 'off' | 'log' | 'enforce'): Promise<void> {
  securityDocGet.mockResolvedValue({ data: () => ({ appCheckMode: mode }) });
  const { resetAppCheckModeCache } = await import('../src/lib/appCheckPolicy');
  resetAppCheckModeCache();
}

describe('wrapCallable', () => {
  beforeEach(async () => {
    logEventMock.mockClear();
    writeAuditEntryMock.mockClear();
    captureMock.mockClear();
    assertSessionNotRevokedMock.mockReset();
    assertSessionNotRevokedMock.mockResolvedValue({ outcome: 'miss', durationMs: 7 });
    securityDocGet.mockClear();
    await setMode('off');
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

  /**
   * Issue #556, backend half. Before this, `enforceAppCheck` appeared nowhere
   * in the codebase and no wrapper consulted `req.app` for anything but a log
   * line, so an unattested request was served exactly like an attested one on
   * every one of the ~230 callables. These pin the L2 gate: what it refuses,
   * what it merely records, and what it must never touch.
   */
  describe('O-3 L2 enforcement', () => {
    it('refuses a cohort callable with no App Check token when the mode is enforce', async () => {
      await setMode('enforce');
      const { wrapCallable } = await import('../src/lib/wrapCallable');
      const handler = vi.fn().mockResolvedValue({ ok: true });
      const wrapped = wrapCallable(COHORT_FN, handler);

      await expect(wrapped({ auth: { uid: 'u1' } } as any)).rejects.toMatchObject({
        code: 'unauthenticated',
      });
      // Refused BEFORE the handler, which is the point: an unattested request
      // must not reach the work.
      expect(handler).not.toHaveBeenCalled();
    });

    it('refuses a cohort callable whose token failed verification', async () => {
      await setMode('enforce');
      const { wrapCallable } = await import('../src/lib/wrapCallable');
      const wrapped = wrapCallable(COHORT_FN, async () => ({ ok: true }));

      await expect(
        wrapped({
          auth: { uid: 'u1' },
          rawRequest: { headers: { 'x-firebase-appcheck': 'forged' } },
        } as any),
      ).rejects.toMatchObject({ code: 'unauthenticated' });
    });

    it('serves a cohort callable that carries a verified token', async () => {
      await setMode('enforce');
      const { wrapCallable } = await import('../src/lib/wrapCallable');
      const wrapped = wrapCallable(COHORT_FN, async () => ({ ok: true }));

      await expect(
        wrapped({ auth: { uid: 'u1' }, app: { appId: 'app-1' } } as any),
      ).resolves.toEqual({ ok: true });
    });

    it('serves an unattested cohort callable in log mode, and says it would not have', async () => {
      await setMode('log');
      const { wrapCallable } = await import('../src/lib/wrapCallable');
      const wrapped = wrapCallable(COHORT_FN, async () => ({ ok: true }));

      await expect(wrapped({ auth: { uid: 'u1' } } as any)).resolves.toEqual({ ok: true });
      expect(logEventMock).toHaveBeenCalledWith(
        expect.objectContaining({
          event: `${COHORT_FN}.appCheck.wouldReject`,
          appCheck: 'absent',
          extra: { appCheckMode: 'log' },
        }),
      );
    });

    it('leaves every callable outside the cohort alone, even in enforce mode', async () => {
      await setMode('enforce');
      const { wrapCallable } = await import('../src/lib/wrapCallable');
      const wrapped = wrapCallable('getMyHome', async () => ({ ok: true }));

      await expect(wrapped({ auth: { uid: 'u1' } } as any)).resolves.toEqual({ ok: true });
      // And it does not even read the settings doc: the gate is free for the
      // ~230 callables it does not govern.
      expect(securityDocGet).not.toHaveBeenCalled();
    });

    it('logs a refusal as a failure and audits it', async () => {
      await setMode('enforce');
      const { wrapCallable } = await import('../src/lib/wrapCallable');
      const wrapped = wrapCallable(COHORT_FN, async () => ({ ok: true }));

      await expect(wrapped({ auth: { uid: 'u1' } } as any)).rejects.toBeTruthy();

      expect(logEventMock).toHaveBeenCalledWith(
        expect.objectContaining({ event: `${COHORT_FN}.appCheck.rejected` }),
      );
      expect(logEventMock).toHaveBeenCalledWith(
        expect.objectContaining({ event: `${COHORT_FN}.failure`, errorCode: 'unauthenticated' }),
      );
      expect(writeAuditEntryMock).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'FAILURE', event: 'ERROR_FUNCTION_FAILURE' }),
      );
      // 'unauthenticated' is user-fault: refusing a request that is working as
      // designed must not fill Sentry.
      expect(captureMock).not.toHaveBeenCalled();
    });

    it('logs appCheck="invalid" for a rejected token instead of calling it absent', async () => {
      const { wrapCallable } = await import('../src/lib/wrapCallable');
      const wrapped = wrapCallable('getMyHome', async () => ({ ok: true }));

      await wrapped({
        auth: { uid: 'u1' },
        rawRequest: { headers: { 'x-firebase-appcheck': 'expired.token' } },
      } as any);

      expect(logEventMock).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'getMyHome.success', appCheck: 'invalid' }),
      );
    });
  });

  /**
   * The two pre-handler gates, together. #556's App Check gate and #557's
   * revocation gate landed independently and both refuse with
   * `unauthenticated`, so the thing worth pinning is that they stay TOLD
   * APART: by the caller, which branches on `details.reason` before signing
   * anybody out, and in the logs, where the cost aggregation must not read
   * one gate's refusals as the other's free traffic.
   */
  describe('App Check (#556) and session revocation (#557) together', () => {
    it('runs App Check first, so a refused request never pays for the revocation lookup', async () => {
      await setMode('enforce');
      const { wrapCallable } = await import('../src/lib/wrapCallable');
      const wrapped = wrapCallable(COHORT_FN, async () => ({ ok: true }));

      await expect(wrapped({ auth: { uid: 'u1' } } as any)).rejects.toMatchObject({
        code: 'unauthenticated',
      });

      expect(assertSessionNotRevokedMock).not.toHaveBeenCalled();
    });

    it('logs an App Check refusal as authCheck="not-run", never as "skipped"', async () => {
      await setMode('enforce');
      const { wrapCallable } = await import('../src/lib/wrapCallable');
      const wrapped = wrapCallable(COHORT_FN, async () => ({ ok: true }));

      await expect(wrapped({ auth: { uid: 'u1' } } as any)).rejects.toBeTruthy();

      expect(logEventMock).toHaveBeenCalledWith(
        expect.objectContaining({ event: `${COHORT_FN}.failure`, authCheck: 'not-run' }),
      );
    });

    it('does not tag an App Check refusal with a session reason, so no client signs out over it', async () => {
      await setMode('enforce');
      const { wrapCallable } = await import('../src/lib/wrapCallable');
      const wrapped = wrapCallable(COHORT_FN, async () => ({ ok: true }));

      const refusal = await wrapped({ auth: { uid: 'u1' } } as any).catch((e: unknown) => e);

      expect((refusal as { details?: unknown }).details).toBeUndefined();
      expect((refusal as Error).message).not.toContain('session-revoked');
    });

    it('still refuses a revoked session on a cohort callable that DID attest', async () => {
      const { HttpsError } = await import('firebase-functions/v2/https');
      await setMode('enforce');
      assertSessionNotRevokedMock.mockRejectedValue(
        new HttpsError('unauthenticated', 'ended (session-revoked)', { reason: 'session-revoked' }),
      );
      const { wrapCallable } = await import('../src/lib/wrapCallable');
      const wrapped = wrapCallable(COHORT_FN, async () => ({ ok: true }));

      // A verified App Check token: the platform populates req.app.
      await expect(
        wrapped({ auth: { uid: 'u1' }, app: { appId: 'app-1' } } as any),
      ).rejects.toMatchObject({ details: { reason: 'session-revoked' } });

      expect(logEventMock).toHaveBeenCalledWith(
        expect.objectContaining({
          event: `${COHORT_FN}.failure`,
          authCheck: 'revoked',
          appCheck: 'valid',
        }),
      );
    });

    it('log mode does not short-circuit the revocation gate', async () => {
      await setMode('log');
      const { wrapCallable } = await import('../src/lib/wrapCallable');
      const wrapped = wrapCallable(COHORT_FN, async () => ({ ok: true }));

      await wrapped({ auth: { uid: 'u1' } } as any);

      expect(assertSessionNotRevokedMock).toHaveBeenCalledTimes(1);
      expect(logEventMock).toHaveBeenCalledWith(
        expect.objectContaining({ event: `${COHORT_FN}.appCheck.wouldReject` }),
      );
    });
  });
});
