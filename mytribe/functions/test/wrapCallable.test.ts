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

/**
 * A stand-in cohort member. The real cohort is empty by ruling
 * (D-2026-09-28-APP-CHECK-ONLY-LOGS, src/lib/appCheckPolicy.ts), so the observe
 * path, and the proof that nothing refuses, are driven through a made-up name. Only `isAppCheckCohort` is replaced;
 * the mode read, the decision and the cache are the real ones.
 */
const { COHORT_FN } = vi.hoisted(() => ({ COHORT_FN: 'webOnlyCohortProbe' }));
vi.mock('../src/lib/appCheckPolicy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/appCheckPolicy')>();
  return { ...actual, isAppCheckCohort: (name: string) => name === COHORT_FN };
});

/** The raw stored value. `enforce` is kept here on purpose: a doc may still hold it. */
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
   * O-3 cohort observation. It used to be the L2 gate that could refuse (#556).
   * D-2026-09-28-APP-CHECK-ONLY-LOGS removed the `enforce` mode: App Check only
   * logs. These pin that no stored mode, cohort member or token state makes the
   * wrapper refuse, and that the would-reject line and per-call telemetry stay.
   */
  describe('App Check only logs (D-2026-09-28-APP-CHECK-ONLY-LOGS)', () => {
    it('serves a cohort callable with no App Check token even when the doc still says enforce', async () => {
      await setMode('enforce');
      const { wrapCallable } = await import('../src/lib/wrapCallable');
      const handler = vi.fn().mockResolvedValue({ ok: true });
      const wrapped = wrapCallable(COHORT_FN, handler);
      await expect(wrapped({ auth: { uid: 'u1' } } as any)).resolves.toEqual({ ok: true });
      expect(handler).toHaveBeenCalledTimes(1);
      // A stored `enforce` reads as `log`: observed, never refused.
      expect(logEventMock).toHaveBeenCalledWith(
        expect.objectContaining({
          event: `${COHORT_FN}.appCheck.wouldReject`,
          appCheck: 'absent',
          extra: { appCheckMode: 'log' },
        }),
      );
      expect(logEventMock).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'appCheck.enforceIgnored', severity: 'warn' }),
      );
      expect(logEventMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: `${COHORT_FN}.appCheck.rejected` }),
      );
    });
    it('serves a cohort callable whose token failed verification, and logs it as invalid', async () => {
      await setMode('enforce');
      const { wrapCallable } = await import('../src/lib/wrapCallable');
      const wrapped = wrapCallable(COHORT_FN, async () => ({ ok: true }));
      await expect(
        wrapped({
          auth: { uid: 'u1' },
          rawRequest: { headers: { 'x-firebase-appcheck': 'forged' } },
        } as any),
      ).resolves.toEqual({ ok: true });
      expect(logEventMock).toHaveBeenCalledWith(
        expect.objectContaining({ event: `${COHORT_FN}.success`, appCheck: 'invalid' }),
      );
    });
    it('serves a cohort callable that carries a verified token without a would-reject line', async () => {
      await setMode('log');
      const { wrapCallable } = await import('../src/lib/wrapCallable');
      const wrapped = wrapCallable(COHORT_FN, async () => ({ ok: true }));
      await expect(
        wrapped({ auth: { uid: 'u1' }, app: { appId: 'app-1' } } as any),
      ).resolves.toEqual({ ok: true });
      expect(logEventMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: `${COHORT_FN}.appCheck.wouldReject` }),
      );
    });
    it('serves an unattested cohort callable in log mode, and says it would have been refused', async () => {
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
      expect(logEventMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: 'appCheck.enforceIgnored' }),
      );
    });
    it('off mode logs no would-reject line, only the per-call telemetry', async () => {
      await setMode('off');
      const { wrapCallable } = await import('../src/lib/wrapCallable');
      const wrapped = wrapCallable(COHORT_FN, async () => ({ ok: true }));
      await expect(wrapped({ auth: { uid: 'u1' } } as any)).resolves.toEqual({ ok: true });
      expect(logEventMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: `${COHORT_FN}.appCheck.wouldReject` }),
      );
      expect(logEventMock).toHaveBeenCalledWith(
        expect.objectContaining({ event: `${COHORT_FN}.success`, appCheck: 'absent' }),
      );
    });
    it('leaves every callable outside the cohort alone and never reads the settings doc', async () => {
      await setMode('enforce');
      const { wrapCallable } = await import('../src/lib/wrapCallable');
      const wrapped = wrapCallable('getMyHome', async () => ({ ok: true }));
      await expect(wrapped({ auth: { uid: 'u1' } } as any)).resolves.toEqual({ ok: true });
      expect(securityDocGet).not.toHaveBeenCalled();
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
   * App Check observation and #557 session revocation together. App Check no
   * longer refuses, so revocation is the only pre-handler gate that can; these
   * pin that the observation step never stands in its way.
   */
  describe('App Check observation and session revocation (#557) together', () => {
    it('an unattested cohort request still reaches the revocation check', async () => {
      await setMode('enforce');
      const { wrapCallable } = await import('../src/lib/wrapCallable');
      const wrapped = wrapCallable(COHORT_FN, async () => ({ ok: true }));
      await wrapped({ auth: { uid: 'u1' } } as any);
      expect(assertSessionNotRevokedMock).toHaveBeenCalledTimes(1);
      expect(logEventMock).toHaveBeenCalledWith(
        expect.objectContaining({ event: `${COHORT_FN}.success`, authCheck: 'miss' }),
      );
    });
    it('refuses a revoked session on a cohort callable, whatever its App Check state', async () => {
      const { HttpsError } = await import('firebase-functions/v2/https');
      await setMode('log');
      assertSessionNotRevokedMock.mockRejectedValue(
        new HttpsError('unauthenticated', 'ended (session-revoked)', { reason: 'session-revoked' }),
      );
      const { wrapCallable } = await import('../src/lib/wrapCallable');
      const wrapped = wrapCallable(COHORT_FN, async () => ({ ok: true }));
      await expect(wrapped({ auth: { uid: 'u1' }, app: { appId: 'app-1' } } as any)).rejects.toMatchObject({
        details: { reason: 'session-revoked' },
      });
      await expect(wrapped({ auth: { uid: 'u1' } } as any)).rejects.toMatchObject({
        details: { reason: 'session-revoked' },
      });
      expect(logEventMock).toHaveBeenCalledWith(
        expect.objectContaining({
          event: `${COHORT_FN}.failure`,
          authCheck: 'revoked',
          appCheck: 'valid',
        }),
      );
      expect(logEventMock).toHaveBeenCalledWith(
        expect.objectContaining({
          event: `${COHORT_FN}.failure`,
          authCheck: 'revoked',
          appCheck: 'absent',
        }),
      );
    });
  });
});
