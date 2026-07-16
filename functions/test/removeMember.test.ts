import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/lib/firestoreAdmin', () => ({ db: () => ({}), auth: () => ({ revokeRefreshTokens: vi.fn() }) }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn() }));

describe('removeMemberHandler', () => {
  it('rejects invalid args', async () => {
    const { removeMemberHandler } = await import('../src/admin/removeMember');
    await expect(
      removeMemberHandler({ data: { familyId: 'f' }, auth: { uid: 'u' } } as any),
    ).rejects.toThrow();
  });
});
