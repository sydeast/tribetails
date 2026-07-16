import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: mocks.dbFn,
  auth: vi.fn(),
  getAdmin: vi.fn(),
}));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

beforeEach(() => {
  mocks.dbFn.mockReset();
  process.env.AUNTIE_OPERATOR_UIDS = '';
});

describe('getMyAccessHandler', () => {
  it('rejects unauth', async () => {
    const { getMyAccessHandler } = await import('../src/portal/getMyAccess');
    await expect(
      getMyAccessHandler({ data: {}, auth: undefined } as any),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('non-operator returns clients/{uid}.kinfolkIds, isOperator=false', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3', '7'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyAccessHandler } = await import('../src/portal/getMyAccess');
    const res = await getMyAccessHandler({ data: {}, auth: { uid: 'u1' } } as any);
    expect(res).toEqual({ kinfolkIds: ['3', '7'], isOperator: false });
  });

  it('non-operator with no clients doc returns empty, isOperator=false', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': null } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyAccessHandler } = await import('../src/portal/getMyAccess');
    const res = await getMyAccessHandler({ data: {}, auth: { uid: 'u1' } } as any);
    expect(res).toEqual({ kinfolkIds: [], isOperator: false });
  });

  it('operator gets ALL kinfolk ids enumerated from kinfolk collection, isOperator=true', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op-uid';
    const ctx = buildDbMock({
      docs: { 'clients/op-uid': null },
      queryDocs: {
        kinfolk: [
          { id: '3', data: {} },
          { id: '5', data: {} },
          { id: '7', data: {} },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyAccessHandler } = await import('../src/portal/getMyAccess');
    const res = await getMyAccessHandler({ data: {}, auth: { uid: 'op-uid' } } as any);
    expect(res.isOperator).toBe(true);
    expect(res.kinfolkIds.sort()).toEqual(['3', '5', '7']);
  });

  it('operator union: clients/{uid}.kinfolkIds AND all kinfolk ids deduped', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op-uid';
    const ctx = buildDbMock({
      docs: { 'clients/op-uid': { kinfolkIds: ['3', '99'] } },
      queryDocs: {
        kinfolk: [
          { id: '3', data: {} },
          { id: '5', data: {} },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyAccessHandler } = await import('../src/portal/getMyAccess');
    const res = await getMyAccessHandler({ data: {}, auth: { uid: 'op-uid' } } as any);
    expect(res.isOperator).toBe(true);
    // Operator sees union: 3, 5 (from kinfolk) + 99 (from clients doc).
    expect(res.kinfolkIds.sort()).toEqual(['3', '5', '99']);
  });
});
