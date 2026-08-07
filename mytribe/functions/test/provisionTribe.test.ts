import { describe, it, expect, vi, beforeEach } from 'vitest';

const setMock = vi.fn();
const updateMock = vi.fn().mockResolvedValue(undefined);
let refCounter = 0;
function makeRef() {
  refCounter += 1;
  return { id: `ref-${refCounter}`, update: updateMock };
}
const sendFromTemplateMock = vi.fn().mockResolvedValue('m');
const auditMock = vi.fn().mockResolvedValue('a');

vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({
    collection: () => ({ doc: () => makeRef() }),
    doc: () => ({ id: 'theme', update: updateMock }),
    runTransaction: (cb: (tx: { set: typeof setMock }) => unknown) => Promise.resolve(cb({ set: setMock })),
  }),
}));
vi.mock('../src/lib/sendFromTemplate', () => ({ sendFromTemplate: sendFromTemplateMock }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: auditMock }));

beforeEach(() => {
  refCounter = 0;
  setMock.mockClear();
  updateMock.mockClear();
  sendFromTemplateMock.mockClear();
  auditMock.mockClear();
  process.env.CLAIM_LINK_BASE_URL = 'https://claim.tribetails.com';
});

describe('provisionTribeHandler', () => {
  it('rejects invalid args (missing primaryEmail)', async () => {
    const { provisionTribeHandler } = await import('../src/admin/provisionTribe');
    await expect(
      provisionTribeHandler({ data: { displayName: 'X' }, auth: { uid: 'u' } } as any),
    ).rejects.toThrow();
  });

  it('happy path: var configured -> writes, mails a real claim link, and audits', async () => {
    const { provisionTribeHandler } = await import('../src/admin/provisionTribe');
    const r = await provisionTribeHandler({
      data: { displayName: 'The Does', primaryEmail: 'a@b.com' },
      auth: { uid: 'u' },
    } as any);
    expect(r.familyId).toBe('ref-1');
    expect(r.inviteId).toBe('ref-2');
    expect(setMock).toHaveBeenCalledTimes(3); // family, themeConfig, invite
    expect(updateMock).toHaveBeenCalled(); // inviteRef.update({status: 'EMAIL_SENT', ...})
    expect(sendFromTemplateMock).toHaveBeenCalledWith(
      'invite.primary',
      'a@b.com',
      expect.objectContaining({ claimUrl: 'https://claim.tribetails.com?invite=ref-2' }),
    );
    expect(auditMock).toHaveBeenCalled();
  });

  describe('CLAIM_LINK_BASE_URL guard', () => {
    it('throws failed-precondition, and writes nothing, when unset', async () => {
      delete process.env.CLAIM_LINK_BASE_URL;
      const { provisionTribeHandler } = await import('../src/admin/provisionTribe');
      await expect(
        provisionTribeHandler({
          data: { displayName: 'X', primaryEmail: 'a@b.com' },
          auth: { uid: 'u' },
        } as any),
      ).rejects.toMatchObject({
        code: 'failed-precondition',
        message: expect.stringContaining('CLAIM_LINK_BASE_URL'),
      });
      expect(setMock).not.toHaveBeenCalled();
      expect(sendFromTemplateMock).not.toHaveBeenCalled();
      expect(auditMock).not.toHaveBeenCalled();
    });
  });
});
