import { describe, it, expect, vi } from 'vitest';

const addMock = vi.fn().mockResolvedValue({ id: 'inv-1', update: vi.fn().mockResolvedValue(undefined) });
vi.mock('../src/lib/firestoreAdmin', () => ({ db: () => ({ collection: () => ({ add: addMock }) }) }));
vi.mock('../src/lib/sendFromTemplate', () => ({ sendFromTemplate: vi.fn().mockResolvedValue('m') }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('a') }));

const FULL_PERMS = {
  billing_full: false,
  messaging_direct: true,
  messaging_group: true,
  kin_edit: false,
  kintales_only: true,
  home_access: false,
};

describe('mintInviteHandler (admin)', () => {
  it('rejects invalid args (missing proposedPermissions)', async () => {
    const { mintInviteHandler } = await import('../src/admin/mintInvite');
    await expect(
      mintInviteHandler({ data: { familyId: 'f1', invitedEmail: 'a@b.com' }, auth: { uid: 'u' } } as any),
    ).rejects.toThrow();
  });

  it('accepts proposedPermissions including home_access=true', async () => {
    const { mintInviteHandler } = await import('../src/admin/mintInvite');
    const r = await mintInviteHandler({
      data: {
        familyId: 'f1',
        invitedEmail: 'a@b.com',
        proposedPermissions: { ...FULL_PERMS, home_access: true },
      },
      auth: { uid: 'u-admin' },
    } as any);
    expect(r.inviteId).toBe('inv-1');
    expect(addMock).toHaveBeenCalled();
    const arg = addMock.mock.calls[0][0];
    expect(arg.proposedPermissions.home_access).toBe(true);
  });
});
