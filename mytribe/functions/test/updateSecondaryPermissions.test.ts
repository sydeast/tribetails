import { describe, it, expect, vi, beforeEach } from 'vitest';

const memberGet = vi.fn();
const docUpdate = vi.fn().mockResolvedValue(undefined);
const auditMock = vi.fn().mockResolvedValue('a');

vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({ doc: () => ({ get: memberGet, update: docUpdate }) }),
}));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: auditMock }));

beforeEach(() => {
  memberGet.mockReset();
  docUpdate.mockClear();
  auditMock.mockClear();
});

describe('updateSecondaryPermissionsHandler', () => {
  it('SECONDARY caller denied', async () => {
    memberGet.mockResolvedValue({
      exists: true,
      data: () => ({ role: 'SECONDARY', status: 'ACTIVE', permissions: {} }),
    });
    const { updateSecondaryPermissionsHandler } = await import('../src/membership/updateSecondaryPermissions');
    await expect(
      updateSecondaryPermissionsHandler({
        auth: { uid: 'u-sec' },
        data: { familyId: 'f1', targetUid: 'u-x', permissions: { kin_edit: true } },
      } as any),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('PRIMARY can grant kin_edit to SECONDARY target', async () => {
    memberGet
      .mockResolvedValueOnce({ exists: true, data: () => ({ role: 'PRIMARY', status: 'ACTIVE', permissions: {} }) })
      .mockResolvedValueOnce({ exists: true, data: () => ({ role: 'SECONDARY', status: 'ACTIVE', permissions: {} }) });
    const { updateSecondaryPermissionsHandler } = await import('../src/membership/updateSecondaryPermissions');
    const r = await updateSecondaryPermissionsHandler({
      auth: { uid: 'u-prim' },
      data: { familyId: 'f1', targetUid: 'u-sec', permissions: { kin_edit: true } },
    } as any);
    expect(r.ok).toBe(true);
    expect(docUpdate).toHaveBeenCalledOnce();
    expect(auditMock).toHaveBeenCalled();
  });

  it('PRIMARY can grant home_access independently of kin_edit', async () => {
    memberGet
      .mockResolvedValueOnce({ exists: true, data: () => ({ role: 'PRIMARY', status: 'ACTIVE', permissions: {} }) })
      .mockResolvedValueOnce({ exists: true, data: () => ({ role: 'SECONDARY', status: 'ACTIVE', permissions: {} }) });
    const { updateSecondaryPermissionsHandler } = await import('../src/membership/updateSecondaryPermissions');
    const r = await updateSecondaryPermissionsHandler({
      auth: { uid: 'u-prim' },
      data: { familyId: 'f1', targetUid: 'u-sec', permissions: { home_access: true } },
    } as any);
    expect(r.ok).toBe(true);
    expect(docUpdate).toHaveBeenCalledOnce();
    expect(auditMock).toHaveBeenCalled();
  });
});
