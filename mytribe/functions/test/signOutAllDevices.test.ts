import { describe, it, expect, vi, beforeEach } from 'vitest';

const revokeMock = vi.fn().mockResolvedValue(undefined);
const auditMock = vi.fn().mockResolvedValue('a');

vi.mock('../src/lib/firestoreAdmin', () => ({
  auth: () => ({ revokeRefreshTokens: revokeMock }),
}));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: auditMock }));

beforeEach(() => {
  revokeMock.mockClear();
  auditMock.mockClear();
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
});
