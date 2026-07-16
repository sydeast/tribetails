import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), writeAuditEntryFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__SERVER_TS__' } };
});
beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.writeAuditEntryFn.mockReset();
  mocks.writeAuditEntryFn.mockResolvedValue('audit-id');
});

describe('saveTribeProfileHandler', () => {
  it('rejects unauth', async () => {
    const { saveTribeProfileHandler } = await import('../src/portal/saveTribeProfile');
    await expect(saveTribeProfileHandler({ data: { displayName: 'X' }, auth: undefined } as any)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('writes only fields that the caller passed', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveTribeProfileHandler } = await import('../src/portal/saveTribeProfile');
    await saveTribeProfileHandler({ data: { kinfolkId: '3', displayName: 'Foster' }, auth: { uid: 'u1' } } as any);
    const w = ctx.writes.find((w) => w.path === 'families/3');
    expect(w).toBeDefined();
    expect(w!.data.displayName).toBe('Foster');
    expect(w!.data.customFields).toBeUndefined();
    expect(w!.merge).toBe(true);
  });

  it('emits PROFILE_UPDATED audit on successful save', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveTribeProfileHandler } = await import('../src/portal/saveTribeProfile');
    await saveTribeProfileHandler({ data: { kinfolkId: '3', displayName: 'Foster' }, auth: { uid: 'u1' } } as any);
    expect(mocks.writeAuditEntryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'PROFILE_UPDATED',
        actorRole: 'PRIMARY',
        actorUid: 'u1',
        targetUid: '3',
        targetCollection: 'families',
      }),
    );
  });

  it('returns ok without writing when nothing besides timestamp would change', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { saveTribeProfileHandler } = await import('../src/portal/saveTribeProfile');
    await saveTribeProfileHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    expect(ctx.writes).toHaveLength(0);
  });
});
