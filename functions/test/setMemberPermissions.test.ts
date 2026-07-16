import { describe, it, expect, vi } from 'vitest';

const getSnap = vi.fn();
const updateMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({ doc: () => ({ get: getSnap, update: updateMock }) }),
}));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('a') }));

describe('setMemberPermissionsHandler', () => {
  it('rejects invalid args', async () => {
    const { setMemberPermissionsHandler } = await import('../src/admin/setMemberPermissions');
    await expect(
      setMemberPermissionsHandler({ data: { familyId: 'f' }, auth: { uid: 'u' } } as any),
    ).rejects.toThrow();
  });

  it('accepts home_access in permissions and persists it', async () => {
    getSnap.mockResolvedValue({ exists: true, data: () => ({ role: 'SECONDARY', status: 'ACTIVE', permissions: {} }) });
    const { setMemberPermissionsHandler } = await import('../src/admin/setMemberPermissions');
    const r = await setMemberPermissionsHandler({
      data: { familyId: 'f1', targetUid: 'u-sec', permissions: { home_access: true } },
      auth: { uid: 'u-admin' },
    } as any);
    expect(r.ok).toBe(true);
    expect(updateMock).toHaveBeenCalled();
    const callArg = updateMock.mock.calls[0][0];
    expect(callArg['permissions.home_access']).toBe(true);
  });
});
