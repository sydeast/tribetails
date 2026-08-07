import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: mocks.dbFn,
  auth: vi.fn(),
  getAdmin: vi.fn(),
}));

beforeEach(() => {
  mocks.dbFn.mockReset();
});

describe('resolveNonStaffKinfolkId', () => {
  it('no clients doc / empty kinfolkIds throws failed-precondition', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': null } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveNonStaffKinfolkId } = await import('../src/lib/resolveNonStaffKinfolkId');
    await expect(resolveNonStaffKinfolkId('u1', undefined)).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });

  it('single linked id, omitted -> resolves it (the normal path, unchanged)', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveNonStaffKinfolkId } = await import('../src/lib/resolveNonStaffKinfolkId');
    const res = await resolveNonStaffKinfolkId('u1', undefined);
    expect(res).toBe('3');
  });

  it("single linked id, '' -> resolves it ('' pinned as omitted, not an explicit invalid id)", async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveNonStaffKinfolkId } = await import('../src/lib/resolveNonStaffKinfolkId');
    const res = await resolveNonStaffKinfolkId('u1', '');
    expect(res).toBe('3');
  });

  it('MULTIPLE linked ids, omitted -> refuses to guess (defect account, PR28b)', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3', '5'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveNonStaffKinfolkId } = await import('../src/lib/resolveNonStaffKinfolkId');
    await expect(resolveNonStaffKinfolkId('u1', undefined)).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });

  it("MULTIPLE linked ids, '' -> refuses to guess ('' pinned as omitted here too)", async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3', '5'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveNonStaffKinfolkId } = await import('../src/lib/resolveNonStaffKinfolkId');
    await expect(resolveNonStaffKinfolkId('u1', '')).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });

  it('requested id in allowed set -> ok', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3', '5'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveNonStaffKinfolkId } = await import('../src/lib/resolveNonStaffKinfolkId');
    const res = await resolveNonStaffKinfolkId('u1', '5');
    expect(res).toBe('5');
  });

  it('requested id NOT in allowed set -> permission-denied', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveNonStaffKinfolkId } = await import('../src/lib/resolveNonStaffKinfolkId');
    await expect(resolveNonStaffKinfolkId('u1', '999')).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });
});
