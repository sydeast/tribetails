import { describe, it, expect, vi, beforeEach } from 'vitest';

const inviteGet = vi.fn();
const inviteUpdate = vi.fn().mockResolvedValue(undefined);
const memberSet = vi.fn().mockResolvedValue(undefined);
const clientUpdate = vi.fn().mockResolvedValue(undefined);
const auditAdd = vi.fn().mockResolvedValue({ id: 'a' });
const enqueue = vi.fn().mockResolvedValue(['n1']);
const syncClaim = vi.fn().mockResolvedValue({ kinfolkId: 't1' });

// The transaction re-reads the invite ref (WARNING-20 TOCTOU fix). makeRef gives
// each path a stable `get` so `tx.get(inviteRef)` resolves the same invite state
// the outer read saw. inviteGet(p) is the canonical source for the invite doc.
function makeRef(p: string) {
  return {
    path: p,
    get: vi.fn().mockImplementation(() => inviteGet(p)),
    update: inviteUpdate,
    set: memberSet,
  };
}
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({
    doc: (p: string) => makeRef(p),
    collection: () => ({ add: auditAdd }),
    runTransaction: (
      cb: (tx: {
        get: (ref: { get: () => unknown }) => unknown;
        set: typeof memberSet;
        update: typeof inviteUpdate;
      }) => unknown,
    ) =>
      Promise.resolve(
        cb({ get: (ref: { get: () => unknown }) => ref.get(), set: memberSet, update: inviteUpdate }),
      ),
  }),
}));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: auditAdd }));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: enqueue }));
vi.mock('../src/lib/kinfolkClaim', () => ({ syncKinfolkClaim: syncClaim }));

beforeEach(() => {
  inviteGet.mockReset();
  inviteUpdate.mockClear();
  memberSet.mockClear();
  clientUpdate.mockClear();
  auditAdd.mockClear();
  enqueue.mockClear();
  syncClaim.mockClear();
  syncClaim.mockResolvedValue({ kinfolkId: 't1' });
});

describe('acceptInviteHandler', () => {
  it('rejects when invite expired', async () => {
    inviteGet.mockResolvedValue({
      exists: true,
      data: () => ({
        status: 'EMAIL_SENT',
        invitedEmail: 'a@b',
        expiresAt: { toMillis: () => Date.now() - 1000 },
      }),
    });
    const { acceptInviteHandler } = await import('../src/membership/acceptInvite');
    await expect(
      acceptInviteHandler({
        auth: { uid: 'u1', token: { email: 'a@b', email_verified: true } },
        data: { inviteId: 'i1' },
      } as any),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('rejects when token email mismatches invite', async () => {
    inviteGet.mockResolvedValue({
      exists: true,
      data: () => ({
        status: 'EMAIL_SENT',
        invitedEmail: 'a@b',
        expiresAt: { toMillis: () => Date.now() + 100000 },
      }),
    });
    const { acceptInviteHandler } = await import('../src/membership/acceptInvite');
    await expect(
      acceptInviteHandler({
        auth: { uid: 'u1', token: { email: 'wrong@b', email_verified: true } },
        data: { inviteId: 'i1' },
      } as any),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('WARNING-20 (TOCTOU): a second accept after the invite is already ACCEPTED fails inside the tx', async () => {
    // Both calls' OUTER read sees a still-acceptable invite (the TOCTOU window),
    // but the in-tx re-read sees ACCEPTED once the first accept commits. The mock
    // serves PENDING for the first two reads (call-1 outer + call-1 in-tx), then
    // ACCEPTED for everything after — so call-2's in-tx guard rejects.
    const pending = () => ({
      exists: true,
      data: () => ({
        status: 'EMAIL_SENT',
        invitedEmail: 'a@b',
        tribeId: 't1',
        proposedRole: 'SECONDARY',
        proposedPermissions: {},
        createdAt: 0,
        expiresAt: { toMillis: () => Date.now() + 100000 },
      }),
    });
    const accepted = () => ({
      exists: true,
      data: () => ({
        status: 'ACCEPTED',
        acceptedUid: 'winner',
        invitedEmail: 'a@b',
        tribeId: 't1',
        proposedRole: 'SECONDARY',
        proposedPermissions: {},
        createdAt: 0,
        expiresAt: { toMillis: () => Date.now() + 100000 },
      }),
    });
    // call-1 outer, call-1 in-tx -> pending; then ACCEPTED for call-2 onwards.
    inviteGet
      .mockResolvedValueOnce(pending())
      .mockResolvedValueOnce(pending())
      .mockResolvedValue(accepted());

    const { acceptInviteHandler } = await import('../src/membership/acceptInvite');
    const reqFor = () =>
      acceptInviteHandler({
        auth: { uid: 'u1', token: { email: 'a@b', email_verified: true } },
        data: { inviteId: 'i1' },
      } as any);

    const first = await reqFor();
    expect(first.familyId).toBe('t1');
    // Second sequential accept: outer read now sees ACCEPTED-by-other -> rejected
    // even before the tx; either way it must NOT succeed / write a member doc.
    memberSet.mockClear();
    await expect(reqFor()).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(memberSet).not.toHaveBeenCalled();
  });

  it('WARNING-20 (TOCTOU): in-tx re-read of an ACCEPTED invite throws even if the outer read saw it acceptable', async () => {
    // Isolate the in-tx guard specifically: outer read returns acceptable (EMAIL_SENT),
    // but the transactional re-read returns ACCEPTED, proving the tx-internal guard
    // (not just the outer pre-check) blocks the double-write.
    inviteGet
      .mockResolvedValueOnce({
        exists: true,
        data: () => ({
          status: 'EMAIL_SENT',
          invitedEmail: 'a@b',
          tribeId: 't1',
          proposedRole: 'SECONDARY',
          proposedPermissions: {},
          createdAt: 0,
          expiresAt: { toMillis: () => Date.now() + 100000 },
        }),
      })
      .mockResolvedValue({
        exists: true,
        data: () => ({
          status: 'ACCEPTED',
          acceptedUid: 'other',
          invitedEmail: 'a@b',
          tribeId: 't1',
          proposedRole: 'SECONDARY',
          proposedPermissions: {},
          createdAt: 0,
          expiresAt: { toMillis: () => Date.now() + 100000 },
        }),
      });
    const { acceptInviteHandler } = await import('../src/membership/acceptInvite');
    await expect(
      acceptInviteHandler({
        auth: { uid: 'u1', token: { email: 'a@b', email_verified: true } },
        data: { inviteId: 'i1' },
      } as any),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(memberSet).not.toHaveBeenCalled();
  });

  it('HAPPY: accepts and emits BOTH the kinfolk welcome and the Business invite-accepted notification', async () => {
    inviteGet.mockResolvedValue({
      exists: true,
      data: () => ({
        status: 'EMAIL_SENT',
        invitedEmail: 'a@b',
        tribeId: 't1',
        proposedRole: 'PRIMARY',
        proposedPermissions: {},
        createdAt: 0,
        expiresAt: { toMillis: () => Date.now() + 100000 },
      }),
    });
    const { acceptInviteHandler } = await import('../src/membership/acceptInvite');
    const res = await acceptInviteHandler({
      auth: { uid: 'u1', token: { email: 'a@b', email_verified: true } },
      data: { inviteId: 'i1' },
    } as any);
    expect(res.familyId).toBe('t1');
    const keys = enqueue.mock.calls.map((c) => (c[0] as { key: string }).key);
    expect(keys).toContain('account.welcome.kinfolk');
    expect(keys).toContain('account.welcome.business'); // Run-4: "Kinfolk Accepted MyTribe Invite"
  });

  /**
   * O-37. Membership used to land here with the role/kinfolkId claims left to
   * onClientsWrite, which fires whenever it fires — so a kinfolk could be a
   * member seconds before their token could prove it. Every claim-gated direct
   * read (conversations/{kinfolkId}, kin_care_sessions/{id}/breadcrumbs) is
   * dark in that window. Stamp it here, the same way setActiveTribe already
   * does, and leave the trigger as the backstop.
   */
  it('O-37: stamps the kinfolk claim before returning, rather than waiting on onClientsWrite', async () => {
    inviteGet.mockResolvedValue({
      exists: true,
      data: () => ({
        status: 'EMAIL_SENT',
        invitedEmail: 'a@b',
        tribeId: 't1',
        proposedRole: 'PRIMARY',
        proposedPermissions: {},
        createdAt: 0,
        expiresAt: { toMillis: () => Date.now() + 100000 },
      }),
    });
    const { acceptInviteHandler } = await import('../src/membership/acceptInvite');
    await acceptInviteHandler({
      auth: { uid: 'u1', token: { email: 'a@b', email_verified: true } },
      data: { inviteId: 'i1' },
    } as any);

    expect(syncClaim).toHaveBeenCalledWith('u1');
  });

  it('O-37: a claim-sync failure does not fail the accept — membership is already committed', async () => {
    // The tx has landed by the time we stamp, so throwing here would tell the
    // kinfolk "joining didn't finish" about work that DID finish. onClientsWrite
    // still backstops the claim, and the client re-checks its token on boot.
    syncClaim.mockRejectedValue(new Error('auth admin down'));
    inviteGet.mockResolvedValue({
      exists: true,
      data: () => ({
        status: 'EMAIL_SENT',
        invitedEmail: 'a@b',
        tribeId: 't1',
        proposedRole: 'PRIMARY',
        proposedPermissions: {},
        createdAt: 0,
        expiresAt: { toMillis: () => Date.now() + 100000 },
      }),
    });
    const { acceptInviteHandler } = await import('../src/membership/acceptInvite');
    const res = await acceptInviteHandler({
      auth: { uid: 'u1', token: { email: 'a@b', email_verified: true } },
      data: { inviteId: 'i1' },
    } as any);

    expect(res.familyId).toBe('t1');
    expect(memberSet).toHaveBeenCalled();
  });
});
