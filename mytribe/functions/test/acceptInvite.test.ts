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

// The unverified-email branch mints a Firebase verification link and mails it.
const genVerifyLink = vi.fn();
const sendTpl = vi.fn();
const rateLimit = vi.fn();
vi.mock('firebase-admin/auth', () => ({
  getAuth: () => ({ generateEmailVerificationLink: genVerifyLink }),
}));
vi.mock('../src/lib/sendFromTemplate', () => ({ sendFromTemplate: sendTpl }));
vi.mock('../src/lib/rateLimit', () => ({ enforceRateLimit: rateLimit }));

beforeEach(() => {
  inviteGet.mockReset();
  inviteUpdate.mockClear();
  memberSet.mockClear();
  clientUpdate.mockClear();
  auditAdd.mockClear();
  enqueue.mockClear();
  syncClaim.mockClear();
  syncClaim.mockResolvedValue({ kinfolkId: 't1' });
  genVerifyLink.mockReset();
  genVerifyLink.mockResolvedValue('https://verify.example/abc');
  sendTpl.mockReset();
  sendTpl.mockResolvedValue('msg-1');
  rateLimit.mockReset();
  rateLimit.mockResolvedValue(undefined);
  process.env.CLAIM_LINK_BASE_URL = 'https://claim.tribetails.com';
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

  /**
   * B1. The admin can now revoke an invite from the Members-and-invites screen,
   * so "the operator revoked it and the invitee clicked the link anyway" stopped
   * being hypothetical the day that button shipped. These two pin the refusal
   * for the two ways an invite dies, and pin that NOTHING is written on the way
   * out: no member doc, no clients arrayUnion, no partial join.
   */
  it('B1: refuses a REVOKED invite and writes nothing', async () => {
    inviteGet.mockResolvedValue({
      exists: true,
      data: () => ({
        status: 'REVOKED',
        tribeId: 't1',
        invitedEmail: 'a@b',
        // Still inside its TTL: it is the status, not the clock, that kills it.
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
    expect(inviteUpdate).not.toHaveBeenCalled();
    expect(syncClaim).not.toHaveBeenCalled();
  });

  it('B1: refuses an already-EXPIRED invite (the nightly sweep stamped it) and writes nothing', async () => {
    inviteGet.mockResolvedValue({
      exists: true,
      data: () => ({
        status: 'EXPIRED',
        tribeId: 't1',
        invitedEmail: 'a@b',
        expiresAt: { toMillis: () => Date.now() - 100000 },
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
    expect(inviteUpdate).not.toHaveBeenCalled();
  });

  it('B1: a revoked invite is refused BEFORE the email check, so the link never reveals whose it was', async () => {
    // The wrong-email path answers permission-denied and the dead-invite path
    // answers failed-precondition. A revoked invite must take the dead branch
    // regardless of who is holding it, or the two answers together would tell a
    // stranger whether they guessed the invited address.
    inviteGet.mockResolvedValue({
      exists: true,
      data: () => ({
        status: 'REVOKED',
        tribeId: 't1',
        invitedEmail: 'a@b',
        expiresAt: { toMillis: () => Date.now() + 100000 },
      }),
    });
    const { acceptInviteHandler } = await import('../src/membership/acceptInvite');
    await expect(
      acceptInviteHandler({
        auth: { uid: 'stranger', token: { email: 'stranger@x', email_verified: true } },
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

/**
 * RULING: "secondary needs email verification as well."
 *
 * firestore.rules already required a VERIFIED email to so much as READ an
 * inviteRequest (WARNING-17). This callable handed out household membership on
 * the strength of the same unproven address. These pin the two halves of the
 * fix: the refusal is real, and it is survivable.
 */
describe('acceptInviteHandler: email verification', () => {
  function liveInvite() {
    return {
      exists: true,
      data: () => ({
        status: 'EMAIL_SENT',
        invitedEmail: 'a@b',
        tribeId: 't1',
        proposedRole: 'SECONDARY',
        proposedPermissions: { billing_full: true },
        createdAt: 0,
        expiresAt: { toMillis: () => Date.now() + 100000 },
      }),
    };
  }

  it('refuses an unverified invitee and joins them to nothing', async () => {
    inviteGet.mockResolvedValue(liveInvite());
    const { acceptInviteHandler } = await import('../src/membership/acceptInvite');
    await expect(
      acceptInviteHandler({
        auth: { uid: 'u1', token: { email: 'a@b', email_verified: false } },
        data: { inviteId: 'i1' },
      } as any),
    ).rejects.toMatchObject({ code: 'failed-precondition' });

    // No membership, no tenant link, no invite consumed. A refused accept must
    // leave the invite redeemable for its full TTL once they come back verified.
    expect(memberSet).not.toHaveBeenCalled();
    expect(inviteUpdate).not.toHaveBeenCalled();
    expect(syncClaim).not.toHaveBeenCalled();
  });

  it('treats a MISSING email_verified claim as unverified', async () => {
    inviteGet.mockResolvedValue(liveInvite());
    const { acceptInviteHandler } = await import('../src/membership/acceptInvite');
    await expect(
      acceptInviteHandler({
        auth: { uid: 'u1', token: { email: 'a@b' } },
        data: { inviteId: 'i1' },
      } as any),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(memberSet).not.toHaveBeenCalled();
  });

  it('says what to do and names the address, rather than a bare denial', async () => {
    inviteGet.mockResolvedValue(liveInvite());
    const { acceptInviteHandler } = await import('../src/membership/acceptInvite');
    const err = await acceptInviteHandler({
      auth: { uid: 'u1', token: { email: 'a@b', email_verified: false } },
      data: { inviteId: 'i1' },
    } as any).catch((e: { message: string }) => e);
    expect((err as { message: string }).message).toContain('a@b');
    expect((err as { message: string }).message).toMatch(/verif/i);
  });

  it('mails the invited address a verification link so they can get in', async () => {
    inviteGet.mockResolvedValue(liveInvite());
    const { acceptInviteHandler } = await import('../src/membership/acceptInvite');
    await acceptInviteHandler({
      auth: { uid: 'u1', token: { email: 'a@b', email_verified: false } },
      data: { inviteId: 'i1' },
    } as any).catch(() => undefined);

    expect(genVerifyLink).toHaveBeenCalledWith('a@b');
    expect(sendTpl).toHaveBeenCalledTimes(1);
    const [key, to, data] = sendTpl.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(key).toBe('invite.verify-email');
    // The mail goes to the INVITED address, never to whatever the caller claims.
    expect(to).toBe('a@b');
    expect(data['verifyUrl']).toBe('https://verify.example/abc');
    expect(String(data['claimUrl'])).toContain('invite=i1');
  });

  it('still refuses actionably when the verification mail cannot be sent', async () => {
    // A dead SMTP key must not turn "verify your email" into an opaque internal
    // error. The invitee can still verify through any normal Firebase route.
    inviteGet.mockResolvedValue(liveInvite());
    sendTpl.mockRejectedValue(new Error('smtp down'));
    const { acceptInviteHandler } = await import('../src/membership/acceptInvite');
    const err = await acceptInviteHandler({
      auth: { uid: 'u1', token: { email: 'a@b', email_verified: false } },
      data: { inviteId: 'i1' },
    } as any).catch((e: { code: string; message: string }) => e);
    expect(err).toMatchObject({ code: 'failed-precondition' });
    expect((err as { message: string }).message).toContain('a@b');
    expect(memberSet).not.toHaveBeenCalled();
  });

  it('suppresses the mail when rate limited, without changing the refusal', async () => {
    inviteGet.mockResolvedValue(liveInvite());
    rateLimit.mockRejectedValue(new Error('rate limited'));
    const { acceptInviteHandler } = await import('../src/membership/acceptInvite');
    const err = await acceptInviteHandler({
      auth: { uid: 'u1', token: { email: 'a@b', email_verified: false } },
      data: { inviteId: 'i1' },
    } as any).catch((e: { code: string }) => e);
    expect(err).toMatchObject({ code: 'failed-precondition' });
    expect(sendTpl).not.toHaveBeenCalled();
  });

  it('rate-limits per uid AND per invited address', async () => {
    inviteGet.mockResolvedValue(liveInvite());
    const { acceptInviteHandler } = await import('../src/membership/acceptInvite');
    await acceptInviteHandler({
      auth: { uid: 'u1', token: { email: 'a@b', email_verified: false } },
      data: { inviteId: 'i1' },
    } as any).catch(() => undefined);
    const keys = rateLimit.mock.calls.map((c) => c[1]);
    expect(keys).toContain('u1');
    expect(keys).toContain('a@b');
  });

  it('lets a VERIFIED invitee straight through, billing_full and all', async () => {
    // The claimInviteSignup path mints accounts with emailVerified: true, so a
    // brand-new invitee is unaffected by any of the above. And per the ruling a
    // PRIMARY may propose billing_full, so it is applied verbatim.
    inviteGet.mockResolvedValue(liveInvite());
    const { acceptInviteHandler } = await import('../src/membership/acceptInvite');
    const res = await acceptInviteHandler({
      auth: { uid: 'u1', token: { email: 'a@b', email_verified: true } },
      data: { inviteId: 'i1' },
    } as any);

    expect(res.familyId).toBe('t1');
    expect(sendTpl).not.toHaveBeenCalled();
    const written = memberSet.mock.calls[0]?.[1] as { permissions: Record<string, boolean>; role: string };
    expect(written.permissions.billing_full).toBe(true);
    expect(written.role).toBe('SECONDARY');
  });

  describe('CLAIM_LINK_BASE_URL guard', () => {
    it(
      'suppresses the verification mail (never sent with a broken claim link) but still ' +
        'refuses the accept the same way — sendInviteVerificationEmail is documented to ' +
        'NEVER throw to its caller, so the guard error is absorbed by its existing catch-all',
      async () => {
        delete process.env.CLAIM_LINK_BASE_URL;
        inviteGet.mockResolvedValue(liveInvite());
        const { acceptInviteHandler } = await import('../src/membership/acceptInvite');
        const err = await acceptInviteHandler({
          auth: { uid: 'u1', token: { email: 'a@b', email_verified: false } },
          data: { inviteId: 'i1' },
        } as any).catch((e: { code: string; message: string }) => e);

        // Today (pre-guard) this send goes out with claimUrl = "undefined?invite=i1".
        // Post-guard it must not be attempted at all.
        expect(genVerifyLink).not.toHaveBeenCalled();
        expect(sendTpl).not.toHaveBeenCalled();

        // The outer refusal is unchanged: still the "verify your email" failed-precondition,
        // not a new error shape leaking the misconfiguration to the caller.
        expect(err).toMatchObject({ code: 'failed-precondition' });
        expect((err as { message: string }).message).toContain('a@b');
        expect((err as { message: string }).message).toMatch(/verif/i);
        expect(memberSet).not.toHaveBeenCalled();
      },
    );
  });
});
