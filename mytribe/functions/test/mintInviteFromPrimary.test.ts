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
  process.env.CLAIM_LINK_BASE_URL = 'https://claim.tribetails.com';
  delete process.env.AUNTIE_NOTIFY_EMAIL;
  delete process.env.AUNTIE_OS_REVIEW_BASE_URL;
});

const validPermissions = {
  billing_full: true,
  messaging_direct: true,
  messaging_group: true,
  kin_edit: true,
  kintales_only: false,
  home_access: false,
};

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

  describe('CLAIM_LINK_BASE_URL guard', () => {
    it('throws failed-precondition, and writes nothing, when unset — before even checking PRIMARY status', async () => {
      delete process.env.CLAIM_LINK_BASE_URL;
      // Deliberately left unmocked (memberGet.mockReset() ran in beforeEach with
      // no resolved value queued): if the handler reached loadMember before the
      // guard, this call would hang/reject on an unconfigured mock, not on the
      // assertion below. Asserting memberGet was never called proves the guard
      // ran first, matching createShareLink's guard-before-authz shape.
      const { mintInviteFromPrimaryHandler } = await import('../src/membership/mintInviteFromPrimary');
      await expect(
        mintInviteFromPrimaryHandler({
          auth: { uid: 'u-prim', token: { email: 'p@x.com' } },
          data: { familyId: 'f1', invitedEmail: 'a@b.com', secondaryLabel: 'Co-Parent', permissions: validPermissions },
        } as any),
      ).rejects.toMatchObject({
        code: 'failed-precondition',
        message: expect.stringContaining('CLAIM_LINK_BASE_URL'),
      });
      expect(memberGet).not.toHaveBeenCalled();
      expect(inviteAdd).not.toHaveBeenCalled();
      expect(sendMock).not.toHaveBeenCalled();
      expect(auditMock).not.toHaveBeenCalled();
    });
  });

  describe('AUNTIE_OS_REVIEW_BASE_URL guard', () => {
    // #1277: this used to refuse the whole invite. The review URL only builds
    // the business's own notice, so the household's invite now goes out and
    // the gap is recorded for the operator instead.
    it('still mints and sends the invite when AUNTIE_NOTIFY_EMAIL is set but the review base URL is not; only the Auntie notice is skipped, and recorded', async () => {
      process.env.AUNTIE_NOTIFY_EMAIL = 'e2e-admin@tribetails.com';
      memberGet.mockResolvedValue({ exists: true, data: () => ({ role: 'PRIMARY', status: 'ACTIVE', permissions: {} }) });
      const { mintInviteFromPrimaryHandler } = await import('../src/membership/mintInviteFromPrimary');
      const r = await mintInviteFromPrimaryHandler({
        auth: { uid: 'u-prim', token: { email: 'pawsome@hanasamku.com' } },
        data: { familyId: 'f1', invitedEmail: 'catch@hanasamku.com', secondaryLabel: 'Co-Parent', permissions: validPermissions },
      } as any);
      expect(r.inviteId).toBe('i-new');
      expect(inviteAdd).toHaveBeenCalledTimes(1);
      const templates = sendMock.mock.calls.map((c) => c[0]);
      expect(templates).toEqual(['invite.secondary', 'invite.primary-receipt']);
      // Not stamped as notified: no notice went out.
      const update = refUpdate.mock.calls[0]![0] as Record<string, unknown>;
      expect(update.status).toBe('EMAIL_SENT');
      expect(update).not.toHaveProperty('auntieNotifiedAt');
      const skipped = auditMock.mock.calls.map((c) => c[0]).find((a) => a.event === 'MEMBERSHIP_INVITE_AUNTIE_NOTICE_SKIPPED');
      expect(skipped).toMatchObject({
        status: 'FAILURE',
        familyId: 'f1',
        payload: { function: 'mintInviteFromPrimary', inviteId: 'i-new', missingVar: 'AUNTIE_OS_REVIEW_BASE_URL' },
      });
    });
    it('a failed audit write for the skipped notice does not fail the invite', async () => {
      process.env.AUNTIE_NOTIFY_EMAIL = 'e2e-admin@tribetails.com';
      auditMock.mockImplementation(async (a: { event: string }) => {
        if (a.event === 'MEMBERSHIP_INVITE_AUNTIE_NOTICE_SKIPPED') throw new Error('audit down');
        return 'a';
      });
      memberGet.mockResolvedValue({ exists: true, data: () => ({ role: 'PRIMARY', status: 'ACTIVE', permissions: {} }) });
      const { mintInviteFromPrimaryHandler } = await import('../src/membership/mintInviteFromPrimary');
      try {
        const r = await mintInviteFromPrimaryHandler({
          auth: { uid: 'u-prim', token: { email: 'pawsome@hanasamku.com' } },
          data: { familyId: 'f1', invitedEmail: 'catch@hanasamku.com', secondaryLabel: 'Co-Parent', permissions: validPermissions },
        } as any);
        expect(r.inviteId).toBe('i-new');
      } finally {
        auditMock.mockReset();
        auditMock.mockResolvedValue('a');
      }
    });
    it('does NOT guard AUNTIE_OS_REVIEW_BASE_URL when AUNTIE_NOTIFY_EMAIL is unset (the auntie-notify email is never sent)', async () => {
      // AUNTIE_NOTIFY_EMAIL stays unset (default from beforeEach); the invite
      // still mints normally and must not be blocked by a var this run never
      // reads.
      memberGet.mockResolvedValue({ exists: true, data: () => ({ role: 'PRIMARY', status: 'ACTIVE', permissions: {} }) });
      const { mintInviteFromPrimaryHandler } = await import('../src/membership/mintInviteFromPrimary');
      const r = await mintInviteFromPrimaryHandler({
        auth: { uid: 'u-prim', token: { email: 'p@x.com' } },
        data: { familyId: 'f1', invitedEmail: 'a@b.com', secondaryLabel: 'Co-Parent', permissions: validPermissions },
      } as any);
      expect(r.inviteId).toBe('i-new');
      const templates = sendMock.mock.calls.map((c) => c[0]);
      expect(templates).not.toContain('invite.auntie-notify');
    });

    it('sends the auntie-notify mail with a normalized review URL when both vars are configured', async () => {
      process.env.AUNTIE_NOTIFY_EMAIL = 'auntie@tribetails.com';
      process.env.AUNTIE_OS_REVIEW_BASE_URL = 'https://auntie.tribetails.com/review/';
      memberGet.mockResolvedValue({ exists: true, data: () => ({ role: 'PRIMARY', status: 'ACTIVE', permissions: {} }) });
      const { mintInviteFromPrimaryHandler } = await import('../src/membership/mintInviteFromPrimary');
      await mintInviteFromPrimaryHandler({
        auth: { uid: 'u-prim', token: { email: 'p@x.com' } },
        data: { familyId: 'f1', invitedEmail: 'a@b.com', secondaryLabel: 'Co-Parent', permissions: validPermissions },
      } as any);
      const auntieNotifyCall = sendMock.mock.calls.find((c) => c[0] === 'invite.auntie-notify');
      expect(auntieNotifyCall).toBeDefined();
      const data = auntieNotifyCall![2] as Record<string, unknown>;
      // trailing slash stripped, not doubled
      expect(data.auntieReviewUrl).toBe('https://auntie.tribetails.com/review/invites/i-new');
      expect(refUpdate.mock.calls[0]![0]).toHaveProperty('auntieNotifiedAt');
      expect(auditMock.mock.calls.map((c) => c[0].event)).not.toContain('MEMBERSHIP_INVITE_AUNTIE_NOTICE_SKIPPED');
    });
  });
});
