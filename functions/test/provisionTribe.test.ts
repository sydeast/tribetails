import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/lib/firestoreAdmin', () => ({ db: () => ({}) }));
vi.mock('../src/lib/sendFromTemplate', () => ({ sendFromTemplate: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn() }));

describe('provisionTribeHandler', () => {
  it('rejects invalid args (missing primaryEmail)', async () => {
    const { provisionTribeHandler } = await import('../src/admin/provisionTribe');
    await expect(
      provisionTribeHandler({ data: { displayName: 'X' }, auth: { uid: 'u' } } as any),
    ).rejects.toThrow();
  });
});
