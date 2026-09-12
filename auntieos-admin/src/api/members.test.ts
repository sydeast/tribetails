import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import {
  EDITABLE_PERMISSION_KEYS,
  PERMISSION_META,
  formatInviteDate,
  inviteHandle,
  inviteStatusLabel,
  inviteStatusTone,
  listAllInvites,
  listHouseholdInvites,
  listHouseholdMembers,
  listRecoveryCandidates,
  memberLabel,
  memberStatusTone,
} from './members';

beforeEach(() => {
  call.mockReset();
});

describe('listHouseholdMembers', () => {
  it('sends the household id and maps a complete member row', async () => {
    call.mockResolvedValue({
      members: [
        {
          uid: 'u1',
          secondaryLabel: 'Spouse',
          role: 'SECONDARY',
          status: 'ACTIVE',
          permissions: {
            billing_full: true,
            messaging_direct: true,
            messaging_group: false,
            kin_edit: true,
            kintales_only: true,
            home_access: false,
          },
          invitedEmail: 'marcus@example.com',
        },
      ],
    });

    await expect(listHouseholdMembers('fam1')).resolves.toEqual([
      {
        uid: 'u1',
        secondaryLabel: 'Spouse',
        role: 'SECONDARY',
        status: 'ACTIVE',
        permissions: {
          billing_full: true,
          messaging_direct: true,
          messaging_group: false,
          kin_edit: true,
          kintales_only: true,
          home_access: false,
        },
        invitedEmail: 'marcus@example.com',
      },
    ]);
    expect(call).toHaveBeenCalledWith('listMembers', { kinfolkId: 'fam1' });
  });

  it('fills in every absent permission flag as false rather than leaving it undefined', async () => {
    call.mockResolvedValue({ members: [{ uid: 'u1' }] });
    const [member] = await listHouseholdMembers('fam1');
    expect(member?.permissions).toEqual({
      billing_full: false,
      messaging_direct: false,
      messaging_group: false,
      kin_edit: false,
      kintales_only: false,
      home_access: false,
    });
    expect(member?.role).toBe('SECONDARY');
    expect(member?.status).toBe('INVITED');
    expect(member?.invitedEmail).toBeNull();
  });

  it('drops a row with no uid instead of rendering an unaddressable member', async () => {
    call.mockResolvedValue({ members: [{ uid: '' }, null, { uid: 'u2' }] });
    const rows = await listHouseholdMembers('fam1');
    expect(rows.map((r) => r.uid)).toEqual(['u2']);
  });

  it('reads a malformed members field as an empty roster, never undefined', async () => {
    call.mockResolvedValue({ members: 'nope' });
    await expect(listHouseholdMembers('fam1')).resolves.toEqual([]);
  });

  it('refuses a blank household id without a round trip', async () => {
    await expect(listHouseholdMembers('   ')).rejects.toThrow('requires a household id');
    expect(call).not.toHaveBeenCalled();
  });

  it('propagates a callable failure fail-loud', async () => {
    call.mockRejectedValue(new Error('permission-denied'));
    await expect(listHouseholdMembers('fam1')).rejects.toThrow('permission-denied');
  });
});

describe('listHouseholdInvites', () => {
  it('sends the household id and maps a complete invite row', async () => {
    call.mockResolvedValue({
      invites: [
        {
          inviteId: 'rq_8fk29a',
          tribeId: 'fam1',
          invitedEmail: 'jane@example.com',
          secondaryLabel: 'Sister',
          proposedRole: 'SECONDARY',
          proposedPermissions: { messaging_direct: true },
          status: 'EMAIL_SENT',
          effectiveStatus: 'EMAIL_SENT',
          redeemable: true,
          createdAt: '2026-05-26T00:00:00.000Z',
          sentToInviteeAt: '2026-05-26T00:01:00.000Z',
          expiresAt: '2026-06-09T00:00:00.000Z',
          revokedAt: null,
          acceptedUid: null,
        },
      ],
    });

    const [row] = await listHouseholdInvites('fam1');
    expect(call).toHaveBeenCalledWith('listInvites', { familyId: 'fam1' });
    expect(row?.inviteId).toBe('rq_8fk29a');
    expect(row?.effectiveStatus).toBe('EMAIL_SENT');
    expect(row?.redeemable).toBe(true);
    expect(row?.proposedPermissions.messaging_direct).toBe(true);
    expect(row?.proposedPermissions.billing_full).toBe(false);
  });

  it('carries the server\'s lapsed-invite verdict rather than the raw status', async () => {
    // The nightly sweep has not run, so Firestore still says EMAIL_SENT while
    // the server has already worked out the invite is dead.
    call.mockResolvedValue({
      invites: [
        {
          inviteId: 'rq_lapsed',
          status: 'EMAIL_SENT',
          effectiveStatus: 'EXPIRED',
          redeemable: false,
        },
      ],
    });
    const [row] = await listHouseholdInvites('fam1');
    expect(row?.status).toBe('EMAIL_SENT');
    expect(row?.effectiveStatus).toBe('EXPIRED');
    expect(row?.redeemable).toBe(false);
  });

  it('treats an absent redeemable as NOT redeemable, so Revoke is never offered on a guess', async () => {
    call.mockResolvedValue({ invites: [{ inviteId: 'rq_1', status: 'EMAIL_SENT' }] });
    const [row] = await listHouseholdInvites('fam1');
    expect(row?.redeemable).toBe(false);
  });

  it('falls back to status when effectiveStatus is missing', async () => {
    call.mockResolvedValue({ invites: [{ inviteId: 'rq_1', status: 'REVOKED' }] });
    const [row] = await listHouseholdInvites('fam1');
    expect(row?.effectiveStatus).toBe('REVOKED');
  });

  it('drops a row with no invite id, which could not be revoked anyway', async () => {
    call.mockResolvedValue({ invites: [{ inviteId: '' }, { inviteId: 'rq_2' }] });
    const rows = await listHouseholdInvites('fam1');
    expect(rows.map((r) => r.inviteId)).toEqual(['rq_2']);
  });

  it('refuses a blank household id without a round trip', async () => {
    await expect(listHouseholdInvites('')).rejects.toThrow('requires a household id');
    expect(call).not.toHaveBeenCalled();
  });

  it('propagates a callable failure fail-loud', async () => {
    call.mockRejectedValue(new Error('not-found'));
    await expect(listHouseholdInvites('nope')).rejects.toThrow('not-found');
  });
});

describe('listAllInvites', () => {
  it('takes no household argument and maps the household name onto every row', async () => {
    call.mockResolvedValue({
      invites: [
        {
          inviteId: 'rq_1',
          tribeId: 'f1',
          householdName: 'the Demos',
          invitedEmail: 'jane@example.com',
          status: 'PENDING',
          effectiveStatus: 'PENDING',
          redeemable: true,
          createdAt: '2026-08-01T00:00:00.000Z',
        },
      ],
    });

    const rows = await listAllInvites();

    expect(call).toHaveBeenCalledWith('listAllInvites', {});
    expect(rows[0]).toMatchObject({
      inviteId: 'rq_1',
      tribeId: 'f1',
      householdName: 'the Demos',
      effectiveStatus: 'PENDING',
      redeemable: true,
    });
  });

  it('maps every other field exactly as listHouseholdInvites does', async () => {
    const row = {
      inviteId: 'rq_1',
      tribeId: 'f1',
      householdName: 'the Demos',
      invitedEmail: 'jane@example.com',
      secondaryLabel: 'Sister',
      proposedRole: 'SECONDARY',
      proposedPermissions: { messaging_direct: true },
      status: 'EMAIL_SENT',
      effectiveStatus: 'EXPIRED',
      redeemable: false,
      createdAt: '2026-05-20T00:00:00.000Z',
      sentToInviteeAt: '2026-05-20T00:01:00.000Z',
      expiresAt: '2026-06-03T00:00:00.000Z',
      revokedAt: null,
      acceptedUid: null,
    };
    call.mockResolvedValue({ invites: [row] });
    const [all] = await listAllInvites();
    call.mockResolvedValue({ invites: [row] });
    const [one] = await listHouseholdInvites('f1');

    const { householdName, ...rest } = all!;
    expect(householdName).toBe('the Demos');
    expect(rest).toEqual(one);
  });

  /**
   * FAIL LOUD. A row the server could not name is the row the operator most
   * needs. Substituting the id, or worse a blank, would hide it in plain sight.
   */
  it('keeps the server’s loud marker for an unnameable household', async () => {
    call.mockResolvedValue({
      invites: [{ inviteId: 'rq_9', tribeId: 'gone', householdName: '(household not found: gone)' }],
    });
    const [row] = await listAllInvites();
    expect(row?.householdName).toBe('(household not found: gone)');
  });

  it('says so rather than rendering a blank card when the name is missing entirely', async () => {
    call.mockResolvedValue({ invites: [{ inviteId: 'rq_9', tribeId: 'f1' }] });
    const [row] = await listAllInvites();
    expect(row?.householdName).toBe('(household name missing: f1)');
  });

  it('drops a row with no invite id, which nothing could act on', async () => {
    call.mockResolvedValue({ invites: [{ inviteId: '' }, { inviteId: 'rq_2', tribeId: 'f1' }] });
    expect((await listAllInvites()).map((r) => r.inviteId)).toEqual(['rq_2']);
  });

  it('propagates a callable failure fail-loud rather than returning an empty list', async () => {
    call.mockRejectedValue(new Error('permission-denied'));
    await expect(listAllInvites()).rejects.toThrow('permission-denied');
  });
});

describe('permission metadata', () => {
  it('marks kintales_only server-locked and keeps it out of the editable set', () => {
    const locked = PERMISSION_META.find((p) => p.key === 'kintales_only');
    expect(locked?.serverLocked).toBe(true);
    expect(EDITABLE_PERMISSION_KEYS).not.toContain('kintales_only');
  });

  /**
   * RULING: "besides admin, primary kinfolk can set permissions for the
   * secondary ... including billing if they want." This used to assert
   * `adminOnly === true` on billing_full. The flag is gone, and the badge that
   * read "admin only" in the roster with it.
   */
  it('no longer claims billing_full is admin-only', () => {
    const billing = PERMISSION_META.find((p) => p.key === 'billing_full');
    expect(billing).toBeDefined();
    expect(billing).not.toHaveProperty('adminOnly');
    expect(EDITABLE_PERMISSION_KEYS).toContain('billing_full');
  });

  it('covers every key setMemberPermissions accepts, and nothing else', () => {
    expect([...EDITABLE_PERMISSION_KEYS].sort()).toEqual([
      'billing_full',
      'home_access',
      'kin_edit',
      'messaging_direct',
      'messaging_group',
    ]);
  });
});

describe('display helpers', () => {
  it('labels a member by email, then label, then uid, never blank', () => {
    const base = {
      uid: 'u1',
      role: 'SECONDARY' as const,
      status: 'ACTIVE' as const,
      permissions: {
        billing_full: false,
        messaging_direct: false,
        messaging_group: false,
        kin_edit: false,
        kintales_only: true,
        home_access: false,
      },
    };
    expect(memberLabel({ ...base, secondaryLabel: 'Spouse', invitedEmail: 'a@b.com' })).toBe('a@b.com');
    expect(memberLabel({ ...base, secondaryLabel: 'Spouse', invitedEmail: null })).toBe('Spouse');
    expect(memberLabel({ ...base, secondaryLabel: null, invitedEmail: null })).toBe('u1');
  });

  it('tones invite statuses in the mock tints, so revoked and expired never read as live', () => {
    expect(inviteStatusTone('ACCEPTED')).toBe('teal');
    expect(inviteStatusTone('EMAIL_SENT')).toBe('orange');
    expect(inviteStatusTone('PENDING')).toBe('orange');
    expect(inviteStatusTone('REVOKED')).toBe('error');
    expect(inviteStatusTone('EXPIRED')).toBe('muted');
  });

  it('tones member statuses as the members mock draws its LED', () => {
    expect(memberStatusTone('ACTIVE')).toBe('teal');
    expect(memberStatusTone('INVITED')).toBe('orange');
    expect(memberStatusTone('SUSPENDED')).toBe('error');
  });

  it('reads EMAIL_SENT as "Email sent" and the rest in sentence case', () => {
    expect(inviteStatusLabel('EMAIL_SENT')).toBe('Email sent');
    expect(inviteStatusLabel('REVOKED')).toBe('Revoked');
    expect(inviteStatusLabel('EXPIRED')).toBe('Expired');
  });

  it('formats a date, and returns null for a missing or unparseable one rather than today', () => {
    expect(formatInviteDate('2026-05-26T13:45:00.000Z')).toBe('2026-05-26');
    expect(formatInviteDate(null)).toBeNull();
    expect(formatInviteDate('whenever')).toBeNull();
  });

  it('truncates the invite id, because the full id is the claim token', () => {
    expect(inviteHandle('rq_8fk29aLONGTAIL')).toBe('rq_8fk29…');
    expect(inviteHandle('short')).toBe('short');
  });
});
describe('listRecoveryCandidates', () => {
  it('sends the household and the primary being recovered away from', async () => {
    call.mockResolvedValue({ candidates: [] });
    await listRecoveryCandidates('fam1', 'p1');
    expect(call).toHaveBeenCalledWith('listRecoveryCandidates', {
      familyId: 'fam1',
      oldUid: 'p1',
    });
  });
  it('omits oldUid entirely when there is no sitting primary to exclude', async () => {
    call.mockResolvedValue({ candidates: [] });
    await listRecoveryCandidates('fam1');
    expect(call).toHaveBeenCalledWith('listRecoveryCandidates', { familyId: 'fam1' });
  });
  it('maps a candidate row', async () => {
    call.mockResolvedValue({
      candidates: [
        { uid: 'u1', email: 'marcus@example.com', secondaryLabel: 'Spouse', role: 'SECONDARY', status: 'ACTIVE' },
      ],
    });
    await expect(listRecoveryCandidates('fam1', 'p1')).resolves.toEqual([
      {
        uid: 'u1',
        email: 'marcus@example.com',
        secondaryLabel: 'Spouse',
        role: 'SECONDARY',
        status: 'ACTIVE',
      },
    ]);
  });
  it('drops a row carrying no address, which nothing could be sent to', async () => {
    call.mockResolvedValue({
      candidates: [{ uid: 'u1', email: '', role: 'SECONDARY', status: 'ACTIVE' }, { uid: '', email: 'x@y.z' }],
    });
    await expect(listRecoveryCandidates('fam1')).resolves.toEqual([]);
  });
  it('refuses a blank household id before it reaches the wire', async () => {
    await expect(listRecoveryCandidates('  ')).rejects.toThrow(/household id/);
    expect(call).not.toHaveBeenCalled();
  });
  it('answers an empty list for an unreadable shape rather than inventing rows', async () => {
    call.mockResolvedValue({});
    await expect(listRecoveryCandidates('fam1')).resolves.toEqual([]);
  });
});
