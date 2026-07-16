import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/lib/firestoreAdmin', () => ({ db: () => ({}) }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn() }));

describe('setBrandTokensHandler', () => {
  it('rejects invalid args', async () => {
    const { setBrandTokensHandler } = await import('../src/admin/setBrandTokens');
    await expect(
      setBrandTokensHandler({ data: { familyId: 'f' }, auth: { uid: 'u' } } as any),
    ).rejects.toThrow();
  });
});
