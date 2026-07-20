import { describe, it, expect, vi } from 'vitest';

const familyGet = vi.fn();
const membersGet = vi.fn().mockResolvedValue({ docs: [{ id: 'u1', data: () => ({ role: 'ADMIN' }) }] });
const reportsAdd = vi.fn().mockResolvedValue({ id: 'r' });
const txnRun = vi.fn();

vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({
    doc: () => ({ get: familyGet }),
    collection: (p: string) => p === 'migrationReports'
      ? { add: reportsAdd }
      : p.endsWith('/members')
        ? { get: membersGet }
        : { get: vi.fn().mockResolvedValue({ docs: [{ id: 'f1' }] }) },
    runTransaction: txnRun,
  }),
}));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn() }));

describe('migrateFoundationV1Handler', () => {
  it('dry-run writes report and skips mutations', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op';
    familyGet.mockResolvedValue({ exists: true, data: () => ({ displayName: 'Foster' }) });
    const { migrateFoundationV1Handler } = await import('../src/migration/migrateFoundationV1');
    const res = await migrateFoundationV1Handler({
      auth: { uid: 'op' }, data: { familyId: 'f1', dryRun: true },
    } as any);
    expect(res.dryRun).toBe(true);
    expect(reportsAdd).toHaveBeenCalled();
    expect(txnRun).not.toHaveBeenCalled();
  });
});
