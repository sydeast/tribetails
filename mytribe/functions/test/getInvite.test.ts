import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { callableRequest } from './_helpers/callableRequest';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  getUser: vi.fn(),
  writeAuditEntry: vi.fn().mockResolvedValue('audit-1'),
  logEvent: vi.fn(),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({
  db: mocks.dbFn,
  auth: () => ({ getUser: mocks.getUser }),
  getAdmin: vi.fn(),
}));
vi.mock('../src/lib/sessionRevocation', () => import('./_helpers/mockSessionRevocation'));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntry }));

import { getInviteHandler } from '../src/admin/getInvite';
import { wrapAdminCallable } from '../src/lib/wrapAdminCallable';

function ts(iso: string) {
  return { toDate: () => new Date(iso) };
}

function inviteDoc(over: Record<string, unknown> = {}) {
  return {
    tribeId: 'f1',
    primaryUid: 'p1',
    invitedEmail: 'jane@example.com',
    secondaryLabel: 'Sister',
    proposedRole: 'SECONDARY',
    proposedPermissions: { messaging_direct: true },
    status: 'EMAIL_SENT',
    source: 'mytribe-portal',
    createdAt: ts('2026-10-01T10:00:00.000Z'),
    sentToInviteeAt: ts('2026-10-01T10:00:05.000Z'),
    expiresAt: ts('2099-01-01T00:00:00.000Z'),
    ...over,
  };
}

const admin = { uid: 'admin1', token: { admin: true } };

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.getUser.mockReset();
  mocks.writeAuditEntry.mockReset().mockResolvedValue('audit-1');
  mocks.logEvent.mockReset();
});

describe('getInvite HAPPY', () => {
  it('returns one invite with its household, inviter and the listInvites projection', async () => {
    const ctx = buildDbMock({
      docs: {
        'inviteRequests/inv123': inviteDoc(),
        'kinfolk/f1': { firstName: 'Dora', lastName: 'Demo' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.getUser.mockImplementation(async (uid: string) => {
      if (uid === 'p1') return { uid, displayName: 'Dora Demo', email: 'dora@example.com' };
      throw new Error('no user');
    });

    const res = await getInviteHandler(callableRequest({ inviteId: 'inv123' }, admin));

    expect(res.invite).toMatchObject({
      inviteId: 'inv123',
      tribeId: 'f1',
      householdName: 'the Demos',
      invitedEmail: 'jane@example.com',
      secondaryLabel: 'Sister',
      proposedRole: 'SECONDARY',
      status: 'EMAIL_SENT',
      effectiveStatus: 'EMAIL_SENT',
      redeemable: true,
      createdAt: '2026-10-01T10:00:00.000Z',
      sentToInviteeAt: '2026-10-01T10:00:05.000Z',
      invitedByRole: 'PRIMARY',
      invitedBy: { uid: 'p1', displayName: 'Dora Demo', email: 'dora@example.com' },
      acceptedBy: null,
      acceptedAt: null,
      source: 'mytribe-portal',
    });
  });

  it('a business-minted invite (primaryUid "") reads AUNTIE with no inviter account', async () => {
    const ctx = buildDbMock({
      docs: {
        'inviteRequests/inv9': inviteDoc({ primaryUid: '', proposedRole: 'PRIMARY', source: undefined }),
        'kinfolk/f1': { firstName: 'Dora', lastName: 'Demo' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await getInviteHandler(callableRequest({ inviteId: 'inv9' }, admin));

    expect(res.invite.invitedByRole).toBe('AUNTIE');
    expect(res.invite.invitedBy).toBeNull();
    expect(res.invite.source).toBeNull();
    expect(mocks.getUser).not.toHaveBeenCalled();
  });

  it('an accepted invite carries who claimed it and when', async () => {
    const ctx = buildDbMock({
      docs: {
        'inviteRequests/inv5': inviteDoc({
          status: 'ACCEPTED',
          acceptedUid: 'u7',
          acceptedAt: ts('2026-10-03T08:30:00.000Z'),
        }),
        'kinfolk/f1': { firstName: 'Dora', lastName: 'Demo' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.getUser.mockImplementation(async (uid: string) =>
      uid === 'u7' ? { uid, displayName: '', email: 'jane@example.com' } : { uid, displayName: 'Dora Demo' },
    );

    const res = await getInviteHandler(callableRequest({ inviteId: 'inv5' }, admin));

    expect(res.invite.effectiveStatus).toBe('ACCEPTED');
    expect(res.invite.acceptedAt).toBe('2026-10-03T08:30:00.000Z');
    // A blank displayName is no name, not an empty one.
    expect(res.invite.acceptedBy).toEqual({ uid: 'u7', displayName: null, email: 'jane@example.com' });
  });

  it('an inviter account Auth cannot read keeps its uid and reads null name/email (never hides the row)', async () => {
    const ctx = buildDbMock({
      docs: {
        'inviteRequests/inv6': inviteDoc(),
        'kinfolk/f1': { firstName: 'Dora', lastName: 'Demo' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.getUser.mockRejectedValue(new Error('auth/user-not-found'));

    const res = await getInviteHandler(callableRequest({ inviteId: 'inv6' }, admin));

    expect(res.invite.invitedBy).toEqual({ uid: 'p1', displayName: null, email: null });
  });

  it('a missing household is named as missing, not blank', async () => {
    const ctx = buildDbMock({ docs: { 'inviteRequests/inv7': inviteDoc({ tribeId: 'gone' }) } });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.getUser.mockResolvedValue({ uid: 'p1' });

    const res = await getInviteHandler(callableRequest({ inviteId: 'inv7' }, admin));

    expect(res.invite.householdName).toBe('(household not found: gone)');
  });

  it('never logs or audits the invite id (it is the claim token)', async () => {
    const ctx = buildDbMock({
      docs: {
        'inviteRequests/secretTok': inviteDoc(),
        'kinfolk/f1': { firstName: 'Dora', lastName: 'Demo' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.getUser.mockResolvedValue({ uid: 'p1' });

    await getInviteHandler(callableRequest({ inviteId: 'secretTok' }, admin));

    expect(JSON.stringify(mocks.logEvent.mock.calls)).not.toContain('secretTok');
    expect(JSON.stringify(mocks.writeAuditEntry.mock.calls)).not.toContain('secretTok');
    expect(mocks.writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'OPERATOR_CROSSTENANT_ACCESS', familyId: 'f1' }),
    );
  });
});

describe('getInvite REFUSALS', () => {
  it('not-found for an id with no document', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: {} }).db);
    await expect(getInviteHandler(callableRequest({ inviteId: 'nope' }, admin))).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('invalid-argument for a blank or slash-bearing id', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: {} }).db);
    await expect(getInviteHandler(callableRequest({ inviteId: '  ' }, admin))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    await expect(getInviteHandler(callableRequest({ inviteId: 'a/b' }, admin))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('a non-admin caller is refused by the wrapper', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: { 'inviteRequests/i1': inviteDoc() } }).db);
    const wrapped = wrapAdminCallable('getInvite', getInviteHandler);
    await expect(
      wrapped(callableRequest({ inviteId: 'i1' }, { uid: 'k1', token: { kinfolkId: 'f1' } })),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });
});
