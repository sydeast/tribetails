import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/lib/firestoreAdmin', () => ({ db: () => ({}) }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn() }));
vi.mock('argon2', () => ({ default: { hash: vi.fn().mockResolvedValue('h'), argon2id: 2 } }));

describe('setTribePinHandler', () => {
  it('rejects invalid args (pin too short)', async () => {
    const { setTribePinHandler } = await import('../src/admin/setTribePin');
    await expect(
      setTribePinHandler({ data: { familyId: 'f', plaintextPin: '12' }, auth: { uid: 'u' } } as any),
    ).rejects.toThrow();
  });
});
