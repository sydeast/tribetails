import { describe, it, expect, vi, beforeEach } from 'vitest';

const memberGet = vi.fn();
const docUpdate = vi.fn().mockResolvedValue(undefined);
const auditMock = vi.fn().mockResolvedValue('a');

vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({ doc: () => ({ get: memberGet, update: docUpdate }) }),
}));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: auditMock }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

beforeEach(() => {
  memberGet.mockReset();
  docUpdate.mockClear();
  auditMock.mockClear();
  delete process.env.AUNTIE_OPERATOR_UIDS;
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

  it('STAFF GATE: a stranger with no member doc anywhere in the family is denied (regression guard)', async () => {
    // Caller lookup: no member doc, and not staff. This must stay denied —
    // it is the exact hole a naive requireKinfolkPrimary swap would open,
    // since that helper's legacy no-member-doc fallback assumes an earlier
    // clients/{uid}.kinfolkIds check already ran, which this callable has
    // never had.
    memberGet.mockResolvedValueOnce({ exists: false, data: () => undefined });
    const { updateSecondaryPermissionsHandler } = await import('../src/membership/updateSecondaryPermissions');
    await expect(
      updateSecondaryPermissionsHandler({
        auth: { uid: 'stranger' },
        data: { familyId: 'f1', targetUid: 'u-x', permissions: { kin_edit: true } },
      } as any),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(docUpdate).not.toHaveBeenCalled();
  });

  it('STAFF GATE: an operator with the admin claim bypasses the member-doc requirement entirely', async () => {
    // Only the TARGET's member doc is looked up; the operator's own
    // families/{familyId}/members/{uid} is never consulted.
    memberGet.mockResolvedValueOnce({ exists: true, data: () => ({ role: 'SECONDARY', status: 'ACTIVE', permissions: {} }) });
    const { updateSecondaryPermissionsHandler } = await import('../src/membership/updateSecondaryPermissions');
    const r = await updateSecondaryPermissionsHandler({
      auth: { uid: 'op-uid', token: { admin: true } },
      data: { familyId: 'f1', targetUid: 'u-sec', permissions: { kin_edit: true } },
    } as any);
    expect(r.ok).toBe(true);
    expect(docUpdate).toHaveBeenCalledOnce();
  });

  it('STAFF GATE: an operator on the AUNTIE_OPERATOR_UIDS allowlist (no admin claim) bypasses the member-doc requirement', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op-uid';
    memberGet.mockResolvedValueOnce({ exists: true, data: () => ({ role: 'SECONDARY', status: 'ACTIVE', permissions: {} }) });
    const { updateSecondaryPermissionsHandler } = await import('../src/membership/updateSecondaryPermissions');
    const r = await updateSecondaryPermissionsHandler({
      auth: { uid: 'op-uid' },
      data: { familyId: 'f1', targetUid: 'u-sec', permissions: { kin_edit: true } },
    } as any);
    expect(r.ok).toBe(true);
    expect(docUpdate).toHaveBeenCalledOnce();
  });

  it('STAFF GATE: audit-logs the operator write as cross-tenant access (matches resolveKinfolkAccess) and labels PERM_GRANTED as AUNTIE, not PRIMARY', async () => {
    memberGet.mockResolvedValueOnce({ exists: true, data: () => ({ role: 'SECONDARY', status: 'ACTIVE', permissions: {} }) });
    const { updateSecondaryPermissionsHandler } = await import('../src/membership/updateSecondaryPermissions');
    await updateSecondaryPermissionsHandler({
      auth: { uid: 'op-uid', token: { admin: true } },
      data: { familyId: 'f1', targetUid: 'u-sec', permissions: { kin_edit: true } },
    } as any);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'OPERATOR_CROSSTENANT_ACCESS',
        actorRole: 'AUNTIE',
        actorUid: 'op-uid',
        targetUid: 'f1',
      }),
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'PERM_GRANTED',
        actorRole: 'AUNTIE',
        actorUid: 'op-uid',
        targetUid: 'u-sec',
      }),
    );
  });
});
