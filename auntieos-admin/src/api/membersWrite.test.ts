import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import { DEFAULT_INVITE_PERMISSIONS } from './membersWrite';
import {
  SECONDARY_LABEL_MAX,
  describePortalInviteOutcome,
  inviteKinfolkToPortal,
  mintInvite,
  removeMember,
  revokeInvite,
  setMemberPermissions,
} from './membersWrite';

beforeEach(() => {
  call.mockReset();
});

describe('mintInvite', () => {
  it('sends every field the server requires, with the full six-flag permission shape', async () => {
    call.mockResolvedValue({ inviteId: 'rq_1' });

    await expect(
      mintInvite({
        familyId: ' fam1 ',
        invitedEmail: '  jane@example.com ',
        secondaryLabel: ' Sister ',
        proposedRole: 'SECONDARY',
        proposedPermissions: { ...DEFAULT_INVITE_PERMISSIONS, kin_edit: true },
      }),
    ).resolves.toEqual({ inviteId: 'rq_1' });

    expect(call).toHaveBeenCalledWith('mintInvite', {
      familyId: 'fam1',
      invitedEmail: 'jane@example.com',
      secondaryLabel: 'Sister',
      proposedRole: 'SECONDARY',
      proposedPermissions: {
        billing_full: false,
        messaging_direct: true,
        messaging_group: true,
        kin_edit: true,
        kintales_only: true,
        home_access: false,
      },
    });
  });

  it('defaults the role to SECONDARY and a blank label to Folk, matching the server', async () => {
    call.mockResolvedValue({ inviteId: 'rq_1' });
    await mintInvite({
      familyId: 'fam1',
      invitedEmail: 'jane@example.com',
      proposedPermissions: DEFAULT_INVITE_PERMISSIONS,
    });
    const payload = call.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload['proposedRole']).toBe('SECONDARY');
    expect(payload['secondaryLabel']).toBe('Folk');
  });

  it('forces kintales_only true, because the server does and a false would be a lie', async () => {
    call.mockResolvedValue({ inviteId: 'rq_1' });
    await mintInvite({
      familyId: 'fam1',
      invitedEmail: 'jane@example.com',
      proposedPermissions: { ...DEFAULT_INVITE_PERMISSIONS, kintales_only: false },
    });
    const payload = call.mock.calls[0]?.[1] as { proposedPermissions: Record<string, boolean> };
    expect(payload.proposedPermissions['kintales_only']).toBe(true);
  });

  it('can mint a PRIMARY invite when asked', async () => {
    call.mockResolvedValue({ inviteId: 'rq_1' });
    await mintInvite({
      familyId: 'fam1',
      invitedEmail: 'jane@example.com',
      proposedRole: 'PRIMARY',
      proposedPermissions: DEFAULT_INVITE_PERMISSIONS,
    });
    expect((call.mock.calls[0]?.[1] as Record<string, unknown>)['proposedRole']).toBe('PRIMARY');
  });

  it('rejects a blank household id, a blank email and an address with no @, without a round trip', async () => {
    const perms = DEFAULT_INVITE_PERMISSIONS;
    await expect(
      mintInvite({ familyId: ' ', invitedEmail: 'a@b.com', proposedPermissions: perms }),
    ).rejects.toThrow('requires a household id');
    await expect(
      mintInvite({ familyId: 'fam1', invitedEmail: '  ', proposedPermissions: perms }),
    ).rejects.toThrow('email address is required');
    await expect(
      mintInvite({ familyId: 'fam1', invitedEmail: 'jane', proposedPermissions: perms }),
    ).rejects.toThrow('is not an email address');
    expect(call).not.toHaveBeenCalled();
  });

  it('rejects an over-long label with the real limit named', async () => {
    await expect(
      mintInvite({
        familyId: 'fam1',
        invitedEmail: 'a@b.com',
        secondaryLabel: 'x'.repeat(SECONDARY_LABEL_MAX + 1),
        proposedPermissions: DEFAULT_INVITE_PERMISSIONS,
      }),
    ).rejects.toThrow(`${SECONDARY_LABEL_MAX} characters or fewer`);
    expect(call).not.toHaveBeenCalled();
  });

  it('propagates a mint failure fail-loud instead of reporting a sent invite', async () => {
    call.mockRejectedValue(new Error('SMTP2GO rejected the send'));
    await expect(
      mintInvite({
        familyId: 'fam1',
        invitedEmail: 'a@b.com',
        proposedPermissions: DEFAULT_INVITE_PERMISSIONS,
      }),
    ).rejects.toThrow('SMTP2GO rejected the send');
  });
});

describe('revokeInvite', () => {
  it('sends the invite id', async () => {
    call.mockResolvedValue({ ok: true });
    await revokeInvite(' rq_1 ');
    expect(call).toHaveBeenCalledWith('revokeInvite', { inviteId: 'rq_1' });
  });

  it('refuses a blank invite id without a round trip', async () => {
    await expect(revokeInvite('')).rejects.toThrow('requires an invite id');
    expect(call).not.toHaveBeenCalled();
  });

  it('propagates not-found for an invite that is already gone', async () => {
    call.mockRejectedValue(new Error('not-found: invite not found'));
    await expect(revokeInvite('rq_gone')).rejects.toThrow('invite not found');
  });
});

describe('setMemberPermissions', () => {
  it('sends only the flags that changed', async () => {
    call.mockResolvedValue({ ok: true });
    await setMemberPermissions('fam1', 'u1', { billing_full: true });
    expect(call).toHaveBeenCalledWith('setMemberPermissions', {
      familyId: 'fam1',
      targetUid: 'u1',
      permissions: { billing_full: true },
    });
  });

  it('strips kintales_only, which the server would silently drop', async () => {
    call.mockResolvedValue({ ok: true });
    await setMemberPermissions('fam1', 'u1', { kintales_only: false, kin_edit: true });
    expect(call).toHaveBeenCalledWith('setMemberPermissions', {
      familyId: 'fam1',
      targetUid: 'u1',
      permissions: { kin_edit: true },
    });
  });

  it('refuses a call that would change nothing, rather than reporting a saved no-op', async () => {
    await expect(setMemberPermissions('fam1', 'u1', { kintales_only: false })).rejects.toThrow(
      'no permission to change',
    );
    await expect(setMemberPermissions('fam1', 'u1', {})).rejects.toThrow('no permission to change');
    expect(call).not.toHaveBeenCalled();
  });

  it('refuses a blank household id or member uid without a round trip', async () => {
    await expect(setMemberPermissions('', 'u1', { kin_edit: true })).rejects.toThrow(
      'requires a household id',
    );
    await expect(setMemberPermissions('fam1', '  ', { kin_edit: true })).rejects.toThrow(
      'requires a member uid',
    );
    expect(call).not.toHaveBeenCalled();
  });

  it('propagates permission-denied fail-loud so the toggle can revert', async () => {
    call.mockRejectedValue(new Error('permission-denied: Admin claim required.'));
    await expect(setMemberPermissions('fam1', 'u1', { billing_full: true })).rejects.toThrow(
      'Admin claim required',
    );
  });
});

describe('removeMember', () => {
  it('sends the household id and target uid', async () => {
    call.mockResolvedValue({ ok: true });
    await removeMember(' fam1 ', ' u1 ');
    expect(call).toHaveBeenCalledWith('removeMember', { familyId: 'fam1', targetUid: 'u1' });
  });

  it('refuses blank ids without a round trip', async () => {
    await expect(removeMember('', 'u1')).rejects.toThrow('requires a household id');
    await expect(removeMember('fam1', '')).rejects.toThrow('requires a member uid');
    expect(call).not.toHaveBeenCalled();
  });

  it('propagates not-found fail-loud', async () => {
    call.mockRejectedValue(new Error('not-found: member not found'));
    await expect(removeMember('fam1', 'ghost')).rejects.toThrow('member not found');
  });
});

describe('inviteKinfolkToPortal', () => {
  it('returns the sent outcome with the new invite id', async () => {
    call.mockResolvedValue({ kinfolkId: 'fam1', status: 'sent', inviteId: 'rq_1' });
    await expect(inviteKinfolkToPortal('fam1')).resolves.toEqual({
      kinfolkId: 'fam1',
      status: 'sent',
      inviteId: 'rq_1',
    });
    expect(call).toHaveBeenCalledWith('inviteKinfolkToPortal', { kinfolkId: 'fam1' });
  });

  it('passes the already_active and no_email outcomes through instead of flattening them', async () => {
    call.mockResolvedValue({ kinfolkId: 'fam1', status: 'already_active' });
    await expect(inviteKinfolkToPortal('fam1')).resolves.toMatchObject({ status: 'already_active' });

    call.mockResolvedValue({ kinfolkId: 'fam1', status: 'no_email' });
    await expect(inviteKinfolkToPortal('fam1')).resolves.toMatchObject({ status: 'no_email' });
  });

  it('throws on an unrecognised status rather than defaulting to sent', async () => {
    call.mockResolvedValue({ kinfolkId: 'fam1', status: 'maybe' });
    await expect(inviteKinfolkToPortal('fam1')).rejects.toThrow('unrecognised status');
  });

  it('refuses a blank household id without a round trip', async () => {
    await expect(inviteKinfolkToPortal('  ')).rejects.toThrow('requires a household id');
    expect(call).not.toHaveBeenCalled();
  });

  it('propagates not-found fail-loud', async () => {
    call.mockRejectedValue(new Error("not-found: Kinfolk 'nope' not found."));
    await expect(inviteKinfolkToPortal('nope')).rejects.toThrow('not found');
  });
});

describe('describePortalInviteOutcome', () => {
  it('reports sent as sent, naming the TTL', () => {
    const out = describePortalInviteOutcome(
      { kinfolkId: 'fam1', status: 'sent', inviteId: 'rq_1' },
      'the Walls',
    );
    expect(out.sent).toBe(true);
    expect(out.message).toContain('the Walls');
    expect(out.message).toContain('14 days');
  });

  it('reports already_active as NOT sent and says why', () => {
    const out = describePortalInviteOutcome(
      { kinfolkId: 'fam1', status: 'already_active' },
      'the Walls',
    );
    expect(out.sent).toBe(false);
    expect(out.message).toContain('No invite sent');
    expect(out.message).toContain('already has an active portal account');
  });

  it('reports no_email as NOT sent and says what to fix', () => {
    const out = describePortalInviteOutcome({ kinfolkId: 'fam1', status: 'no_email' }, 'the Walls');
    expect(out.sent).toBe(false);
    expect(out.message).toContain('No invite sent');
    expect(out.message).toContain('no email address on file');
  });

  it('never leaves the sentence starting with a blank name', () => {
    const out = describePortalInviteOutcome({ kinfolkId: 'fam1', status: 'sent' }, '   ');
    expect(out.message).toContain('This household');
  });
});
