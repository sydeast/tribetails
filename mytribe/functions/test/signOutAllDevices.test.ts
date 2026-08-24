import { describe, it, expect, vi, beforeEach } from 'vitest';

const revokeMock = vi.fn().mockResolvedValue(undefined);
const auditMock = vi.fn().mockResolvedValue('a');
const getUserMock = vi.fn().mockResolvedValue({ disabled: false });

vi.mock('../src/lib/firestoreAdmin', () => ({
  auth: () => ({ revokeRefreshTokens: revokeMock, getUser: getUserMock }),
}));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: auditMock }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ captureFunctionError: vi.fn(), initSentry: () => {} }));

beforeEach(() => {
  revokeMock.mockClear();
  auditMock.mockClear();
  getUserMock.mockClear();
});

describe('signOutAllDevicesHandler', () => {
  it('rejects unauthenticated', async () => {
    const { signOutAllDevicesHandler } = await import('../src/auth/signOutAllDevices');
    await expect(
      signOutAllDevicesHandler({ auth: undefined, data: {} } as any),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('revokes refresh tokens for caller', async () => {
    const { signOutAllDevicesHandler } = await import('../src/auth/signOutAllDevices');
    const r = await signOutAllDevicesHandler({ auth: { uid: 'u1' }, data: {} } as any);
    expect(r.ok).toBe(true);
    expect(revokeMock).toHaveBeenCalledWith('u1');
    expect(auditMock).toHaveBeenCalled();
  });

  // #557: the instance that performs the revoke has this uid cached as "not
  // revoked" from its own inbound check. Without the eviction it would keep
  // serving that answer for the rest of the TTL — the one instance that
  // provably knows better.
  it('drops its own cached session facts for the caller after revoking', async () => {
    const { signOutAllDevicesHandler } = await import('../src/auth/signOutAllDevices');
    const { assertSessionNotRevoked, resetSessionRevocationCacheForTest } = await import(
      '../src/lib/sessionRevocation'
    );
    resetSessionRevocationCacheForTest();
    const req = { auth: { uid: 'u1', token: { auth_time: 1_800_000_000 } }, data: {} } as any;

    await assertSessionNotRevoked(req, 'signOutAllDevices');
    expect(getUserMock).toHaveBeenCalledTimes(1);
    // Cached: a second check inside the TTL does not look up again.
    await assertSessionNotRevoked(req, 'signOutAllDevices');
    expect(getUserMock).toHaveBeenCalledTimes(1);

    await signOutAllDevicesHandler(req);

    await assertSessionNotRevoked(req, 'getMyHome');
    expect(getUserMock).toHaveBeenCalledTimes(2);
  });
});
