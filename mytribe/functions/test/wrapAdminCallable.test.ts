import { describe, it, expect, beforeEach, vi } from 'vitest';

const captureMock = vi.fn().mockReturnValue('s1');
const logEventMock = vi.fn();
vi.mock('../src/lib/sentry', () => ({ captureFunctionError: captureMock, initSentry: () => {} }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('a1') }));
vi.mock('../src/lib/logger', () => ({ logEvent: logEventMock }));
// #557: wrapAdminCallable delegates to wrapCallable, which now checks session
// revocation. Stub it out — see test/_helpers/mockSessionRevocation.ts.
vi.mock('../src/lib/sessionRevocation', () => import('./_helpers/mockSessionRevocation'));

beforeEach(() => {
  process.env.AUNTIE_OPERATOR_UIDS = 'uid-auntie';
  captureMock.mockClear();
  logEventMock.mockClear();
});

describe('wrapAdminCallable', () => {
  it('rejects non-allowlisted callers', async () => {
    const { wrapAdminCallable } = await import('../src/lib/wrapAdminCallable');
    const wrapped = wrapAdminCallable('admin.x', async () => ({ ok: true }));
    await expect(wrapped({ auth: { uid: 'uid-stranger' } } as any)).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  // #1520: the staff gate's own refusals are user-fault codes. They go through
  // wrapCallable's catch (this wrapper has none of its own), so they log at
  // warn and stay out of Sentry, like any other refused call.
  it('#1520: a refused stranger is logged at warn, not error, and not captured', async () => {
    const { wrapAdminCallable } = await import('../src/lib/wrapAdminCallable');
    const wrapped = wrapAdminCallable('admin.x', async () => ({ ok: true }));
    await expect(wrapped({ auth: { uid: 'uid-stranger' } } as any)).rejects.toBeTruthy();
    expect(captureMock).not.toHaveBeenCalled();
    expect(logEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'warn', event: 'admin.x.failure', errorCode: 'permission-denied' }),
    );
    expect(logEventMock).not.toHaveBeenCalledWith(expect.objectContaining({ severity: 'error' }));
  });

  it('#1520: an allowlisted caller whose handler breaks is still logged at error and captured', async () => {
    const { wrapAdminCallable } = await import('../src/lib/wrapAdminCallable');
    const wrapped = wrapAdminCallable('admin.x', async () => {
      throw new Error('boom');
    });
    await expect(wrapped({ auth: { uid: 'uid-auntie' } } as any)).rejects.toMatchObject({ code: 'internal' });
    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(logEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'error', event: 'admin.x.failure', errorCode: 'internal' }),
    );
  });

  it('allows allowlisted caller', async () => {
    const { wrapAdminCallable } = await import('../src/lib/wrapAdminCallable');
    const wrapped = wrapAdminCallable('admin.x', async () => ({ ok: true }));
    const r = await wrapped({ auth: { uid: 'uid-auntie' } } as any);
    expect(r.ok).toBe(true);
  });

  it('rejects unauthenticated', async () => {
    const { wrapAdminCallable } = await import('../src/lib/wrapAdminCallable');
    const wrapped = wrapAdminCallable('admin.x', async () => ({ ok: true }));
    await expect(wrapped({ auth: undefined } as any)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });
});
