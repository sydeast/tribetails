import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), writeAuditEntry: vi.fn().mockResolvedValue('a1') }));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: mocks.dbFn,
  auth: vi.fn(),
  getAdmin: vi.fn(),
}));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntry }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.writeAuditEntry.mockClear();
  process.env.AUNTIE_OPERATOR_UIDS = '';
});

describe('resolveKinfolkAccess', () => {
  it('non-operator with no clients doc throws failed-precondition', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': null } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinfolkAccess } = await import('../src/lib/resolveKinfolkAccess');
    await expect(resolveKinfolkAccess('u1', undefined, false, 'test')).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });

  it('non-operator with a single linked id and no requested resolves it (the normal path, unchanged)', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinfolkAccess } = await import('../src/lib/resolveKinfolkAccess');
    const res = await resolveKinfolkAccess('u1', undefined, false, 'test');
    expect(res).toEqual({ kinfolkId: '3', isOperator: false });
  });

  it('non-operator with MULTIPLE linked ids and no requested refuses to guess (defect account, PR28a)', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3', '5'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinfolkAccess } = await import('../src/lib/resolveKinfolkAccess');
    await expect(resolveKinfolkAccess('u1', undefined, false, 'test')).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });

  it('non-operator allows own id', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3', '5'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinfolkAccess } = await import('../src/lib/resolveKinfolkAccess');
    const res = await resolveKinfolkAccess('u1', '5', false, 'test');
    expect(res).toEqual({ kinfolkId: '5', isOperator: false });
  });

  it('non-operator denied for foreign id', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinfolkAccess } = await import('../src/lib/resolveKinfolkAccess');
    await expect(resolveKinfolkAccess('u1', '999', false, 'test')).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('non-operator branch is unaffected by the admin claim alone (no env allowlist, no claim in this scenario)', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinfolkAccess } = await import('../src/lib/resolveKinfolkAccess');
    const res = await resolveKinfolkAccess('u1', '3', false, 'test');
    expect(res).toEqual({ kinfolkId: '3', isOperator: false });
  });

  it('staff (admin claim) with explicit EXISTING kinfolkId always allowed', async () => {
    const ctx = buildDbMock({ docs: { 'clients/op': null, 'kinfolk/777': { firstName: 'X' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinfolkAccess } = await import('../src/lib/resolveKinfolkAccess');
    const res = await resolveKinfolkAccess('op', '777', true, 'test');
    expect(res).toEqual({ kinfolkId: '777', isOperator: true });
  });

  it('RULING O-6 hardening 1: staff + nonexistent kinfolkId -> not-found', async () => {
    const ctx = buildDbMock({ docs: { 'clients/op': null, 'kinfolk/777': null } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinfolkAccess } = await import('../src/lib/resolveKinfolkAccess');
    await expect(resolveKinfolkAccess('op', '777', true, 'test')).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('RULING O-6 hardening 2: staff resolving a FOREIGN id writes a cross-tenant audit entry', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/op': { kinfolkIds: ['own-id'] }, 'kinfolk/777': { firstName: 'X' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinfolkAccess } = await import('../src/lib/resolveKinfolkAccess');
    await resolveKinfolkAccess('op', '777', true, 'someFunction');
    expect(mocks.writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'OPERATOR_CROSSTENANT_ACCESS',
        actorRole: 'AUNTIE',
        actorUid: 'op',
        targetUid: '777',
      }),
    );
  });

  it('RULING O-6 hardening 2: staff resolving their OWN id writes no cross-tenant audit entry', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/op': { kinfolkIds: ['own-id'] }, 'kinfolk/own-id': { firstName: 'X' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinfolkAccess } = await import('../src/lib/resolveKinfolkAccess');
    await resolveKinfolkAccess('op', 'own-id', true, 'someFunction');
    expect(mocks.writeAuditEntry).not.toHaveBeenCalled();
  });

  it('env-allowlist staff (no admin claim) with no requested, no own ids throws (must specify)', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op';
    const ctx = buildDbMock({ docs: { 'clients/op': null } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinfolkAccess } = await import('../src/lib/resolveKinfolkAccess');
    await expect(resolveKinfolkAccess('op', undefined, false, 'test')).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });

  it('env-allowlist staff (no admin claim) with own ids and no requested defaults to first own id', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op';
    const ctx = buildDbMock({ docs: { 'clients/op': { kinfolkIds: ['42'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveKinfolkAccess } = await import('../src/lib/resolveKinfolkAccess');
    const res = await resolveKinfolkAccess('op', undefined, false, 'test');
    expect(res).toEqual({ kinfolkId: '42', isOperator: true });
  });
});
