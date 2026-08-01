import { describe, it, expect, vi, beforeEach } from 'vitest';

const captureMock = vi.fn().mockReturnValue('sentry-id-1');
const logEventMock = vi.fn();
const mocks = vi.hoisted(() => ({
  writeAuditEntryMock: vi.fn().mockResolvedValue('a1'),
}));
vi.mock('../src/lib/sentry', () => ({ captureFunctionError: captureMock, initSentry: () => {} }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryMock }));
vi.mock('../src/lib/logger', () => ({ logEvent: logEventMock }));
const writeAuditEntryMock = mocks.writeAuditEntryMock;

describe('wrapCallable', () => {
  beforeEach(() => {
    logEventMock.mockClear();
    writeAuditEntryMock.mockClear();
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
});
