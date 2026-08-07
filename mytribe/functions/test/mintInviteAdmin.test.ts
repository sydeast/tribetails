import { describe, it, expect, vi, beforeEach } from 'vitest';

const updateMock = vi.fn().mockResolvedValue(undefined);
const addMock = vi.fn().mockResolvedValue({ id: 'inv-1', update: updateMock });
vi.mock('../src/lib/firestoreAdmin', () => ({ db: () => ({ collection: () => ({ add: addMock }) }) }));
const sendFromTemplate = vi.fn().mockResolvedValue('m');
vi.mock('../src/lib/sendFromTemplate', () => ({ sendFromTemplate }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('a') }));

beforeEach(() => {
  addMock.mockClear();
  sendFromTemplate.mockClear();
  process.env.CLAIM_LINK_BASE_URL = 'https://claim.tribetails.com';
});

/**
 * RULING (2026-08-04): the admin's only invite is inviting the PRIMARY. The
 * secondary is invited by the household's own primary, through
 * `portal/addSecondaryContact.ts`.
 *
 * The two cases this file used to carry both described the SECONDARY shape:
 * one required `proposedPermissions`, the other asserted a per-invite
 * permission choice was honoured. Neither is true of a primary invite, and the
 * suite never asked what role the default minted.
 */
describe('mintInviteHandler (admin)', () => {
  it('rejects invalid args (no email)', async () => {
    const { mintInviteHandler } = await import('../src/admin/mintInvite');
    await expect(
      mintInviteHandler({ data: { familyId: 'f1' }, auth: { uid: 'u' } } as any),
    ).rejects.toThrow();
  });

  it('mints a PRIMARY claim with the full entitlement set and no permission choices', async () => {
    const { mintInviteHandler } = await import('../src/admin/mintInvite');
    const r = await mintInviteHandler({
      data: { familyId: 'f1', invitedEmail: 'A@B.com' },
      auth: { uid: 'u-admin' },
    } as any);

    expect(r.inviteId).toBe('inv-1');
    const arg = addMock.mock.calls[0][0];
    expect(arg.proposedRole).toBe('PRIMARY');
    expect(arg.invitedEmail).toBe('a@b.com');
    // Every entitlement, because they belong to the role rather than to the
    // invite. `acceptInvite` copies this onto the member doc verbatim, so
    // anything less puts a PRIMARY on the roster looking restricted.
    expect(arg.proposedPermissions).toEqual({
      billing_full: true,
      messaging_direct: true,
      messaging_group: true,
      kin_edit: true,
      kintales_only: true,
      home_access: true,
    });
    expect(sendFromTemplate.mock.calls[0][0]).toBe('invite.primary');
  });

  it('REFUSES to mint a SECONDARY, rather than quietly minting a PRIMARY instead', async () => {
    const { mintInviteHandler } = await import('../src/admin/mintInvite');
    await expect(
      mintInviteHandler({
        data: { familyId: 'f1', invitedEmail: 'a@b.com', proposedRole: 'SECONDARY' },
        auth: { uid: 'u-admin' },
      } as any),
    ).rejects.toThrow();
    expect(addMock).not.toHaveBeenCalled();
    expect(sendFromTemplate).not.toHaveBeenCalled();
  });

  it('ignores a permission set an older client still sends, instead of honouring it', async () => {
    const { mintInviteHandler } = await import('../src/admin/mintInvite');
    await mintInviteHandler({
      data: {
        familyId: 'f1',
        invitedEmail: 'a@b.com',
        secondaryLabel: 'Sister',
        proposedPermissions: { billing_full: false, home_access: false },
      },
      auth: { uid: 'u-admin' },
    } as any);

    const arg = addMock.mock.calls[0][0];
    expect(arg.proposedPermissions.billing_full).toBe(true);
    expect(arg.proposedPermissions.home_access).toBe(true);
    expect(arg.secondaryLabel).toBeUndefined();
  });

  describe('CLAIM_LINK_BASE_URL guard', () => {
    it('throws failed-precondition, and writes nothing, when unset', async () => {
      delete process.env.CLAIM_LINK_BASE_URL;
      const { mintInviteHandler } = await import('../src/admin/mintInvite');
      await expect(
        mintInviteHandler({
          data: { familyId: 'f1', invitedEmail: 'a@b.com' },
          auth: { uid: 'u-admin' },
        } as any),
      ).rejects.toMatchObject({
        code: 'failed-precondition',
        message: expect.stringContaining('CLAIM_LINK_BASE_URL'),
      });
      expect(addMock).not.toHaveBeenCalled();
      expect(sendFromTemplate).not.toHaveBeenCalled();
    });
  });
});
