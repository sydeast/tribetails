import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSnap = vi.fn();
const updateMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({ doc: () => ({ get: getSnap, update: updateMock }) }),
}));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('a') }));

function memberSnap(role: 'PRIMARY' | 'SECONDARY') {
  return { exists: true, data: () => ({ role, status: 'ACTIVE', permissions: {} }) };
}

beforeEach(() => {
  updateMock.mockClear();
});

describe('setMemberPermissionsHandler', () => {
  it('rejects invalid args', async () => {
    const { setMemberPermissionsHandler } = await import('../src/admin/setMemberPermissions');
    await expect(
      setMemberPermissionsHandler({ data: { familyId: 'f' }, auth: { uid: 'u' } } as any),
    ).rejects.toThrow();
  });

  it('accepts home_access in permissions and persists it', async () => {
    getSnap.mockResolvedValue(memberSnap('SECONDARY'));
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

  // RULING (2026-08-04): "admin can edit permissions but not like primary's
  // access to full billing, home access, kin edit, etc." A PRIMARY's
  // entitlements are inherent to the role, and `requirePerm` never reads the
  // flags for a PRIMARY, so a write here changed nothing an enforcement path
  // consults while the audit log claimed billing had been revoked. This is the
  // case the suite never exercised, which is how the missing guard survived.
  it('REFUSES a PRIMARY target, whatever the flag, and writes nothing', async () => {
    getSnap.mockResolvedValue(memberSnap('PRIMARY'));
    const { setMemberPermissionsHandler } = await import('../src/admin/setMemberPermissions');

    for (const permissions of [
      { billing_full: false },
      { home_access: false },
      { kin_edit: false },
      { messaging_direct: false },
      { messaging_group: false },
    ]) {
      await expect(
        setMemberPermissionsHandler({
          data: { familyId: 'f1', targetUid: 'u-primary', permissions },
          auth: { uid: 'u-admin' },
        } as any),
      ).rejects.toThrow('target not SECONDARY');
    }
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('refuses a PRIMARY target even when the flag would be GRANTED, not revoked', async () => {
    getSnap.mockResolvedValue(memberSnap('PRIMARY'));
    const { setMemberPermissionsHandler } = await import('../src/admin/setMemberPermissions');
    await expect(
      setMemberPermissionsHandler({
        data: { familyId: 'f1', targetUid: 'u-primary', permissions: { billing_full: true } },
        auth: { uid: 'u-admin' },
      } as any),
    ).rejects.toThrow('target not SECONDARY');
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('still reports a missing member as not-found, not as a role failure', async () => {
    getSnap.mockResolvedValue({ exists: false });
    const { setMemberPermissionsHandler } = await import('../src/admin/setMemberPermissions');
    await expect(
      setMemberPermissionsHandler({
        data: { familyId: 'f1', targetUid: 'ghost', permissions: { kin_edit: true } },
        auth: { uid: 'u-admin' },
      } as any),
    ).rejects.toThrow('member not found');
    expect(updateMock).not.toHaveBeenCalled();
  });
});
