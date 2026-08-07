import { describe, it, expect, vi, beforeEach } from 'vitest';

const memberUpdate = vi.fn().mockResolvedValue(undefined);
const inviteSet = vi.fn().mockResolvedValue(undefined);
const recoveryUpdate = vi.fn().mockResolvedValue(undefined);
const sendFromTemplateMock = vi.fn().mockResolvedValue('m');
const auditMock = vi.fn().mockResolvedValue('a');
let inviteRefCounter = 0;

vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({
    doc: (path: string) => {
      if (path.startsWith('families/')) return { update: memberUpdate };
      if (path.startsWith('recoveryRequests/')) return { update: recoveryUpdate };
      throw new Error(`unexpected doc path in test mock: ${path}`);
    },
    collection: (name: string) => {
      if (name !== 'inviteRequests') throw new Error(`unexpected collection in test mock: ${name}`);
      inviteRefCounter += 1;
      return { doc: () => ({ id: `invite-${inviteRefCounter}`, set: inviteSet }) };
    },
  }),
}));
vi.mock('../src/lib/sendFromTemplate', () => ({ sendFromTemplate: sendFromTemplateMock }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: auditMock }));

beforeEach(() => {
  inviteRefCounter = 0;
  memberUpdate.mockClear();
  inviteSet.mockClear();
  recoveryUpdate.mockClear();
  sendFromTemplateMock.mockClear();
  auditMock.mockClear();
  process.env.CLAIM_LINK_BASE_URL = 'https://claim.tribetails.com';
});

describe('executePrimaryRecoveryHandler', () => {
  it('rejects invalid args (missing newEmail)', async () => {
    const { executePrimaryRecoveryHandler } = await import('../src/admin/executePrimaryRecovery');
    await expect(
      executePrimaryRecoveryHandler({ data: { familyId: 'f' }, auth: { uid: 'u' } } as any),
    ).rejects.toThrow();
  });

  it('happy path: var configured -> suspends old member, mints invite with a real claim link, audits, and completes the recovery request', async () => {
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
    expect(auditMock).toHaveBeenCalled();
    expect(recoveryUpdate).toHaveBeenCalledWith(expect.objectContaining({ status: 'COMPLETED' }));
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
