import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/lib/firestoreAdmin', () => ({ db: () => ({}) }));
vi.mock('../src/lib/sendFromTemplate', () => ({ sendFromTemplate: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn() }));

describe('executePrimaryRecoveryHandler', () => {
  it('rejects invalid args (missing newEmail)', async () => {
    const { executePrimaryRecoveryHandler } = await import('../src/admin/executePrimaryRecovery');
    await expect(
      executePrimaryRecoveryHandler({ data: { familyId: 'f' }, auth: { uid: 'u' } } as any),
    ).rejects.toThrow();
  });
});
