import { describe, it, expect, vi, beforeEach } from 'vitest';

const memberGet = vi.fn();
const refUpdate = vi.fn().mockResolvedValue(undefined);
const inviteAdd = vi.fn().mockResolvedValue({ id: 'i-new', update: refUpdate });
const sendMock = vi.fn().mockResolvedValue('m-1');
const auditMock = vi.fn().mockResolvedValue('a');

vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({
    doc: () => ({ get: memberGet }),
    collection: () => ({ add: inviteAdd }),
  }),
}));
vi.mock('../src/lib/sendFromTemplate', () => ({ sendFromTemplate: sendMock }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: auditMock }));

beforeEach(() => {
  memberGet.mockReset();
  inviteAdd.mockClear();
  refUpdate.mockClear();
  sendMock.mockClear();
  auditMock.mockClear();
});

describe('mintInviteFromPrimaryHandler', () => {
  it('rejects non-PRIMARY caller', async () => {
    memberGet.mockResolvedValue({ exists: true, data: () => ({ role: 'SECONDARY', status: 'ACTIVE', permissions: {} }) });
    const { mintInviteFromPrimaryHandler } = await import('../src/membership/mintInviteFromPrimary');
    await expect(
      mintInviteFromPrimaryHandler({
        auth: { uid: 'u-sec' },
        data: {
          familyId: 'f1', invitedEmail: 'a@b.com',
          secondaryLabel: 'Co-Parent',
          permissions: { billing_full: false, messaging_direct: false, messaging_group: false, kin_edit: false, kintales_only: true, home_access: false },
        },
      } as any),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('forces kintales_only=true and creates invite', async () => {
    memberGet.mockResolvedValue({ exists: true, data: () => ({ role: 'PRIMARY', status: 'ACTIVE', permissions: {} }) });
    const { mintInviteFromPrimaryHandler } = await import('../src/membership/mintInviteFromPrimary');
    const r = await mintInviteFromPrimaryHandler({
      auth: { uid: 'u-prim', token: { email: 'p@x.com' } },
      data: {
        familyId: 'f1', invitedEmail: 'a@b.com', secondaryLabel: 'Co-Parent',
        permissions: { billing_full: true, messaging_direct: true, messaging_group: true, kin_edit: true, kintales_only: false, home_access: false },
      },
    } as any);
    expect(r.inviteId).toBe('i-new');
    expect(inviteAdd).toHaveBeenCalledOnce();
    const arg = inviteAdd.mock.calls[0][0];
    expect(arg.proposedPermissions.kintales_only).toBe(true);
    expect(sendMock).toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalled();
  });

  it('accepts home_access=true in permissions payload', async () => {
    memberGet.mockResolvedValue({ exists: true, data: () => ({ role: 'PRIMARY', status: 'ACTIVE', permissions: {} }) });
    const { mintInviteFromPrimaryHandler } = await import('../src/membership/mintInviteFromPrimary');
    const r = await mintInviteFromPrimaryHandler({
      auth: { uid: 'u-prim', token: { email: 'p@x.com' } },
      data: {
        familyId: 'f1', invitedEmail: 'b@b.com', secondaryLabel: 'Partner',
        permissions: { billing_full: false, messaging_direct: true, messaging_group: true, kin_edit: false, kintales_only: true, home_access: true },
      },
    } as any);
    expect(r.inviteId).toBe('i-new');
    const arg = inviteAdd.mock.calls[0][0];
    expect(arg.proposedPermissions.home_access).toBe(true);
  });
});
