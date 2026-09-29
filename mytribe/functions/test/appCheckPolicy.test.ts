import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';

/**
 * O-3 App Check policy (docs/O3_APP_CHECK_RULING_2026-07-13.md), as narrowed by
 * D-2026-09-28-APP-CHECK-ONLY-LOGS (docs/DECISIONS.md): App Check only logs.
 * The `enforce` mode and the `reject` decision are gone; a stored `enforce`
 * reads as `log` with a warning.
 */

const getMock = vi.fn();
const logEventMock = vi.fn();
vi.mock('../src/lib/logger', () => ({ logEvent: logEventMock }));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({ collection: () => ({ doc: () => ({ get: getMock }) }) }),
}));

function request(over: Partial<CallableRequest<unknown>> = {}): CallableRequest<unknown> {
  return { auth: { uid: 'u1' }, ...over } as CallableRequest<unknown>;
}

describe('appCheckStatusOf', () => {
  it('reads a populated req.app as valid — the platform only sets it after verifyToken', async () => {
    const { appCheckStatusOf } = await import('../src/lib/appCheckPolicy');
    expect(appCheckStatusOf(request({ app: { appId: 'app-1' } as never }))).toBe('valid');
  });

  it('separates a REJECTED token from no token at all', async () => {
    const { appCheckStatusOf } = await import('../src/lib/appCheckPolicy');
    // A token that reached the platform and did not survive verification: the
    // header is there, req.app is not. L1 called this 'absent', which read as
    // "a client that does not attest yet" and hid the opposite.
    const rejected = request({
      rawRequest: { headers: { 'x-firebase-appcheck': 'forged.or.expired' } } as never,
    });
    expect(appCheckStatusOf(rejected)).toBe('invalid');
  });

  it('reads a request with no attestation header as absent', async () => {
    const { appCheckStatusOf } = await import('../src/lib/appCheckPolicy');
    expect(appCheckStatusOf(request({ rawRequest: { headers: {} } as never }))).toBe('absent');
    expect(appCheckStatusOf(request())).toBe('absent');
  });

  it('treats an empty header as absent rather than as a rejected token', async () => {
    const { appCheckStatusOf } = await import('../src/lib/appCheckPolicy');
    expect(
      appCheckStatusOf(request({ rawRequest: { headers: { 'x-firebase-appcheck': '' } } as never })),
    ).toBe('absent');
  });
});

describe('appCheckDecision', () => {
  let decide: typeof import('../src/lib/appCheckPolicy').appCheckDecision;

  beforeEach(async () => {
    ({ appCheckDecision: decide } = await import('../src/lib/appCheckPolicy'));
  });

  it('never touches a function outside the cohort, whatever the mode', async () => {
    expect(decide({ mode: 'log', status: 'absent', inCohort: false })).toBe('allow');
    expect(decide({ mode: 'log', status: 'invalid', inCohort: false })).toBe('allow');
  });

  it('mode off observes nothing, even in the cohort', async () => {
    expect(decide({ mode: 'off', status: 'absent', inCohort: true })).toBe('allow');
  });

  it('mode log serves the request and records that it carried no verified token', async () => {
    expect(decide({ mode: 'log', status: 'absent', inCohort: true })).toBe('observe');
    expect(decide({ mode: 'log', status: 'invalid', inCohort: true })).toBe('observe');
  });

  it('a verified token is served without an observation', async () => {
    expect(decide({ mode: 'log', status: 'valid', inCohort: true })).toBe('allow');
  });

  it('no input produces a refusal: App Check only logs', async () => {
    for (const mode of ['off', 'log'] as const) {
      for (const status of ['valid', 'invalid', 'absent'] as const) {
        for (const inCohort of [true, false]) {
          expect(['allow', 'observe']).toContain(decide({ mode, status, inCohort }));
        }
      }
    }
  });
});

describe('currentAppCheckMode', () => {
  beforeEach(async () => {
    getMock.mockReset();
    logEventMock.mockClear();
    const { resetAppCheckModeCache } = await import('../src/lib/appCheckPolicy');
    resetAppCheckModeCache();
  });

  it('reads business_settings/security', async () => {
    getMock.mockResolvedValue({ data: () => ({ appCheckMode: 'off' }) });
    const { currentAppCheckMode } = await import('../src/lib/appCheckPolicy');
    await expect(currentAppCheckMode()).resolves.toBe('off');
    expect(logEventMock).not.toHaveBeenCalled();
  });

  it('reads log as log, with no warning', async () => {
    getMock.mockResolvedValue({ data: () => ({ appCheckMode: 'log' }) });
    const { currentAppCheckMode } = await import('../src/lib/appCheckPolicy');
    await expect(currentAppCheckMode()).resolves.toBe('log');
    expect(logEventMock).not.toHaveBeenCalled();
  });

  it('reads a leftover enforce as log and warns once per cache refresh', async () => {
    getMock.mockResolvedValue({ data: () => ({ appCheckMode: 'enforce' }) });
    const { currentAppCheckMode, resetAppCheckModeCache } = await import('../src/lib/appCheckPolicy');
    await expect(currentAppCheckMode()).resolves.toBe('log');
    await currentAppCheckMode();
    await currentAppCheckMode();
    expect(logEventMock).toHaveBeenCalledTimes(1);
    expect(logEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'warn',
        event: 'appCheck.enforceIgnored',
        errorMessage: expect.stringContaining('D-2026-09-28-APP-CHECK-ONLY-LOGS'),
      }),
    );

    // The next read after the cache expires warns again, so a field left at
    // `enforce` keeps showing up in the logs until someone clears it.
    resetAppCheckModeCache();
    await currentAppCheckMode();
    expect(logEventMock).toHaveBeenCalledTimes(2);
  });

  it('caches, so the gate costs one read per instance per minute and not one per request', async () => {
    getMock.mockResolvedValue({ data: () => ({ appCheckMode: 'log' }) });
    const { currentAppCheckMode } = await import('../src/lib/appCheckPolicy');
    await currentAppCheckMode();
    await currentAppCheckMode();
    await currentAppCheckMode();
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to log when the doc is missing, so no seeding is required', async () => {
    getMock.mockResolvedValue({ data: () => undefined });
    const { currentAppCheckMode } = await import('../src/lib/appCheckPolicy');
    await expect(currentAppCheckMode()).resolves.toBe('log');
    expect(logEventMock).not.toHaveBeenCalled();
  });

  it('falls back to log on a garbage value rather than guessing at it', async () => {
    getMock.mockResolvedValue({ data: () => ({ appCheckMode: 'ENFORCE!!' }) });
    const { currentAppCheckMode } = await import('../src/lib/appCheckPolicy');
    await expect(currentAppCheckMode()).resolves.toBe('log');
  });

  it('fails open when Firestore is unreachable: App Check is not the authz boundary', async () => {
    getMock.mockRejectedValue(new Error('DEADLINE_EXCEEDED'));
    const { currentAppCheckMode } = await import('../src/lib/appCheckPolicy');
    await expect(currentAppCheckMode()).resolves.toBe('log');
  });
});
