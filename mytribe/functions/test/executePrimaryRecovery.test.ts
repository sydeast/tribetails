import { describe, it, expect, vi, beforeEach } from 'vitest';

const memberUpdate = vi.fn().mockResolvedValue(undefined);
const inviteSet = vi.fn().mockResolvedValue(undefined);
const recoveryUpdate = vi.fn().mockResolvedValue(undefined);
const sendFromTemplateMock = vi.fn().mockResolvedValue('m');
const auditMock = vi.fn().mockResolvedValue('a');
let inviteRefCounter = 0;

/**
 * The household roster and the Auth accounts behind it, per test.
 *
 * `members` is what `families/{fid}/members` returns; `authUsers` is what
 * `getUser(uid)` answers. They are separate on purpose: #378 turns on the two
 * disagreeing — a member doc can carry any address somebody typed, and only the
 * Auth account knows whether anybody proved they can read it.
 */
let members: Array<Record<string, unknown> & { uid: string }> = [];
let authUsers: Record<string, { email?: string; emailVerified?: boolean }> = {};

const getUserMock = vi.fn(async (uid: string) => {
  const user = authUsers[uid];
  if (user === undefined) throw new Error(`no auth user: ${uid}`);
  return { uid, ...user };
});

vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({
    doc: (path: string) => {
      if (path.startsWith('families/')) return { update: memberUpdate };
      if (path.startsWith('recoveryRequests/')) return { update: recoveryUpdate };
      throw new Error(`unexpected doc path in test mock: ${path}`);
    },
    collection: (name: string) => {
      if (name.startsWith('families/') && name.endsWith('/members')) {
        return {
          get: async () => ({
            docs: members.map((m) => ({ id: m.uid, data: () => m })),
          }),
        };
      }
      if (name !== 'inviteRequests') throw new Error(`unexpected collection in test mock: ${name}`);
      inviteRefCounter += 1;
      return { doc: () => ({ id: `invite-${inviteRefCounter}`, set: inviteSet }) };
    },
  }),
  auth: () => ({ getUser: getUserMock }),
}));
vi.mock('../src/lib/sendFromTemplate', () => ({ sendFromTemplate: sendFromTemplateMock }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: auditMock }));

/** A household whose new primary-to-be holds a verified address. */
function verifiedHousehold(): void {
  members = [
    { uid: 'old-1', role: 'PRIMARY', status: 'ACTIVE', email: 'old@example.com' },
    { uid: 'new-1', role: 'SECONDARY', status: 'ACTIVE', email: 'new@example.com', secondaryLabel: 'Spouse' },
  ];
  authUsers = {
    'old-1': { email: 'old@example.com', emailVerified: true },
    'new-1': { email: 'new@example.com', emailVerified: true },
  };
}

beforeEach(() => {
  inviteRefCounter = 0;
  memberUpdate.mockClear();
  inviteSet.mockClear();
  recoveryUpdate.mockClear();
  sendFromTemplateMock.mockClear();
  auditMock.mockClear();
  getUserMock.mockClear();
  verifiedHousehold();
  process.env.CLAIM_LINK_BASE_URL = 'https://claim.tribetails.com';
});

/** Nothing was suspended, minted, or mailed. Asserted on every refusal. */
function expectNothingHappened(): void {
  expect(memberUpdate).not.toHaveBeenCalled();
  expect(inviteSet).not.toHaveBeenCalled();
  expect(sendFromTemplateMock).not.toHaveBeenCalled();
  expect(recoveryUpdate).not.toHaveBeenCalled();
}

describe('executePrimaryRecoveryHandler', () => {
  it('rejects invalid args (missing newEmail)', async () => {
    const { executePrimaryRecoveryHandler } = await import('../src/admin/executePrimaryRecovery');
    await expect(
      executePrimaryRecoveryHandler({ data: { familyId: 'f' }, auth: { uid: 'u' } } as any),
    ).rejects.toThrow();
  });

  it('happy path: a verified household member -> suspends old member, mints invite with a real claim link, audits, and completes the recovery request', async () => {
    const { executePrimaryRecoveryHandler } = await import('../src/admin/executePrimaryRecovery');
    const r = await executePrimaryRecoveryHandler({
      data: { familyId: 'f1', newEmail: 'new@example.com', oldUid: 'old-1', recoveryRequestId: 'rr-1' },
      auth: { uid: 'u-admin' },
    } as any);
    expect(r.inviteId).toBe('invite-1');
    expect(memberUpdate).toHaveBeenCalledWith(expect.objectContaining({ status: 'SUSPENDED' }));
    expect(inviteSet).toHaveBeenCalledWith(expect.objectContaining({ invitedEmail: 'new@example.com' }));
    expect(sendFromTemplateMock).toHaveBeenCalledWith(
      'recovery.completed',
      'new@example.com',
      expect.objectContaining({ claimUrl: 'https://claim.tribetails.com?invite=invite-1' }),
    );
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'SUCCESS', severity: 'critical' }));
    expect(recoveryUpdate).toHaveBeenCalledWith(expect.objectContaining({ status: 'COMPLETED' }));
  });

  it('accepts the address in any casing, and mails the verified spelling', async () => {
    const { executePrimaryRecoveryHandler } = await import('../src/admin/executePrimaryRecovery');
    await executePrimaryRecoveryHandler({
      data: { familyId: 'f1', newEmail: 'New@Example.COM', oldUid: 'old-1' },
      auth: { uid: 'u-admin' },
    } as any);
    expect(sendFromTemplateMock).toHaveBeenCalledWith(
      'recovery.completed',
      'new@example.com',
      expect.anything(),
    );
  });

  // #378. The claim link grants a household rather than describing one, so the
  // destination is not a free-text field: it must be an address somebody has
  // already proved they can read, on an account this household already has.
  describe('destination address gate', () => {
    it('refuses an address that is on no member of the household, and suspends nothing', async () => {
      const { executePrimaryRecoveryHandler } = await import('../src/admin/executePrimaryRecovery');
      await expect(
        executePrimaryRecoveryHandler({
          data: { familyId: 'f1', newEmail: 'attacker@example.com', oldUid: 'old-1', recoveryRequestId: 'rr-1' },
          auth: { uid: 'u-admin' },
        } as any),
      ).rejects.toMatchObject({
        code: 'failed-precondition',
        message: expect.stringContaining('verified email address'),
      });
      expectNothingHappened();
      expect(auditMock).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'FAILURE',
          severity: 'critical',
          payload: expect.objectContaining({
            newEmail: 'attacker@example.com',
            reason: 'not_a_verified_household_member',
          }),
        }),
      );
    });

    it("refuses a household member whose Auth email is unverified, and suspends nothing", async () => {
      authUsers['new-1'] = { email: 'new@example.com', emailVerified: false };
      const { executePrimaryRecoveryHandler } = await import('../src/admin/executePrimaryRecovery');
      await expect(
        executePrimaryRecoveryHandler({
          data: { familyId: 'f1', newEmail: 'new@example.com', oldUid: 'old-1' },
          auth: { uid: 'u-admin' },
        } as any),
      ).rejects.toMatchObject({ code: 'failed-precondition' });
      expectNothingHappened();
      expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'FAILURE' }));
    });

    it('refuses a member whose address only exists on the member doc, never on an Auth account', async () => {
      // The member doc says `typo@example.com`; nobody ever signed in with it.
      // Reading eligibility off the roster instead of off Auth would let this
      // through, which is the shape of the original defect.
      members.push({ uid: 'ghost-1', role: 'SECONDARY', status: 'ACTIVE', email: 'typo@example.com' });
      const { executePrimaryRecoveryHandler } = await import('../src/admin/executePrimaryRecovery');
      await expect(
        executePrimaryRecoveryHandler({
          data: { familyId: 'f1', newEmail: 'typo@example.com', oldUid: 'old-1' },
          auth: { uid: 'u-admin' },
        } as any),
      ).rejects.toMatchObject({ code: 'failed-precondition' });
      expectNothingHappened();
    });

    it('refuses a SUSPENDED member, so recovery cannot undo a removal', async () => {
      members = [
        { uid: 'old-1', role: 'PRIMARY', status: 'ACTIVE', email: 'old@example.com' },
        { uid: 'gone-1', role: 'SECONDARY', status: 'SUSPENDED', email: 'gone@example.com' },
      ];
      authUsers['gone-1'] = { email: 'gone@example.com', emailVerified: true };
      const { executePrimaryRecoveryHandler } = await import('../src/admin/executePrimaryRecovery');
      await expect(
        executePrimaryRecoveryHandler({
          data: { familyId: 'f1', newEmail: 'gone@example.com', oldUid: 'old-1' },
          auth: { uid: 'u-admin' },
        } as any),
      ).rejects.toMatchObject({ code: 'failed-precondition' });
      expectNothingHappened();
    });

    it('refuses the address of the primary being recovered away from', async () => {
      const { executePrimaryRecoveryHandler } = await import('../src/admin/executePrimaryRecovery');
      await expect(
        executePrimaryRecoveryHandler({
          data: { familyId: 'f1', newEmail: 'old@example.com', oldUid: 'old-1' },
          auth: { uid: 'u-admin' },
        } as any),
      ).rejects.toMatchObject({ code: 'failed-precondition' });
      expectNothingHappened();
    });

    it('tells an operator with no eligible member what to do instead', async () => {
      members = [{ uid: 'old-1', role: 'PRIMARY', status: 'ACTIVE', email: 'old@example.com' }];
      const { executePrimaryRecoveryHandler } = await import('../src/admin/executePrimaryRecovery');
      await expect(
        executePrimaryRecoveryHandler({
          data: { familyId: 'f1', newEmail: 'someone@example.com', oldUid: 'old-1' },
          auth: { uid: 'u-admin' },
        } as any),
      ).rejects.toMatchObject({
        message: expect.stringContaining('verify their email first'),
      });
      expectNothingHappened();
    });

    it('names the eligible addresses in the refusal so the operator can pick one', async () => {
      const { executePrimaryRecoveryHandler } = await import('../src/admin/executePrimaryRecovery');
      await expect(
        executePrimaryRecoveryHandler({
          data: { familyId: 'f1', newEmail: 'nope@example.com', oldUid: 'old-1' },
          auth: { uid: 'u-admin' },
        } as any),
      ).rejects.toMatchObject({ message: expect.stringContaining('new@example.com') });
    });
  });

  describe('CLAIM_LINK_BASE_URL guard', () => {
    it('throws failed-precondition, and writes nothing, when unset', async () => {
      delete process.env.CLAIM_LINK_BASE_URL;
      const { executePrimaryRecoveryHandler } = await import('../src/admin/executePrimaryRecovery');
      await expect(
        executePrimaryRecoveryHandler({
          data: { familyId: 'f1', newEmail: 'new@example.com', oldUid: 'old-1' },
          auth: { uid: 'u-admin' },
        } as any),
      ).rejects.toMatchObject({
        code: 'failed-precondition',
        message: expect.stringContaining('CLAIM_LINK_BASE_URL'),
      });
      expect(memberUpdate).not.toHaveBeenCalled();
      expect(inviteSet).not.toHaveBeenCalled();
      expect(sendFromTemplateMock).not.toHaveBeenCalled();
      expect(auditMock).not.toHaveBeenCalled();
    });
  });
});

describe('listRecoveryCandidatesHandler', () => {
  it('offers only the household members holding a verified Auth address', async () => {
    members.push({ uid: 'unverified-1', role: 'SECONDARY', status: 'ACTIVE', email: 'pending@example.com' });
    authUsers['unverified-1'] = { email: 'pending@example.com', emailVerified: false };
    const { listRecoveryCandidatesHandler } = await import('../src/admin/listRecoveryCandidates');
    const res = await listRecoveryCandidatesHandler({
      data: { familyId: 'f1', oldUid: 'old-1' },
      auth: { uid: 'u-admin' },
    } as any);
    expect(res.candidates).toEqual([
      { uid: 'new-1', email: 'new@example.com', secondaryLabel: 'Spouse', role: 'SECONDARY', status: 'ACTIVE' },
    ]);
  });

  it('audits the cross-tenant read with counts and no addresses', async () => {
    const { listRecoveryCandidatesHandler } = await import('../src/admin/listRecoveryCandidates');
    await listRecoveryCandidatesHandler({
      data: { familyId: 'f1', oldUid: 'old-1' },
      auth: { uid: 'u-admin' },
    } as any);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'OPERATOR_CROSSTENANT_ACCESS',
        familyId: 'f1',
        payload: expect.objectContaining({ function: 'listRecoveryCandidates', count: 1 }),
      }),
    );
    const entry = auditMock.mock.calls[0]?.[0] as { payload: Record<string, unknown> };
    expect(JSON.stringify(entry.payload)).not.toContain('@');
  });

  it('answers an empty list rather than failing when no member qualifies', async () => {
    members = [{ uid: 'old-1', role: 'PRIMARY', status: 'ACTIVE', email: 'old@example.com' }];
    const { listRecoveryCandidatesHandler } = await import('../src/admin/listRecoveryCandidates');
    const res = await listRecoveryCandidatesHandler({
      data: { familyId: 'f1', oldUid: 'old-1' },
      auth: { uid: 'u-admin' },
    } as any);
    expect(res.candidates).toEqual([]);
  });

  it('lists exactly what the execute gate would accept, for the same household', async () => {
    const { listRecoveryCandidatesHandler } = await import('../src/admin/listRecoveryCandidates');
    const { executePrimaryRecoveryHandler } = await import('../src/admin/executePrimaryRecovery');
    const res = await listRecoveryCandidatesHandler({
      data: { familyId: 'f1', oldUid: 'old-1' },
      auth: { uid: 'u-admin' },
    } as any);
    for (const candidate of res.candidates) {
      await expect(
        executePrimaryRecoveryHandler({
          data: { familyId: 'f1', newEmail: candidate.email, oldUid: 'old-1' },
          auth: { uid: 'u-admin' },
        } as any),
      ).resolves.toMatchObject({ inviteId: expect.any(String) });
    }
    expect(res.candidates.length).toBeGreaterThan(0);
  });
});
