import { describe, it, expect, vi } from 'vitest';

const getMock = vi.fn();
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({ doc: () => ({ get: getMock, update: vi.fn().mockResolvedValue(undefined) }) }),
}));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn() }));

describe('revokeInviteHandler', () => {
  it('rejects invalid args', async () => {
    const { revokeInviteHandler } = await import('../src/admin/revokeInvite');
    await expect(
      revokeInviteHandler({ data: {}, auth: { uid: 'u' } } as any),
    ).rejects.toThrow();
  });

  it('throws not-found when invite missing', async () => {
    getMock.mockResolvedValueOnce({ exists: false });
    const { revokeInviteHandler } = await import('../src/admin/revokeInvite');
    await expect(
      revokeInviteHandler({ data: { inviteId: 'i1' }, auth: { uid: 'u' } } as any),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});
