import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());

describe('getMyKinHandler', () => {
  it('rejects unauth', async () => {
    const { getMyKinHandler } = await import('../src/portal/getMyKin');
    await expect(getMyKinHandler({ data: {}, auth: undefined } as any)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('returns active kin without legacyKinId blurb', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] } },
      queryDocs: {
        'families/3/kin': [
          { id: 'k1', data: { name: 'Buddy', species: 'dog', breed: 'Aussie', ageYears: 4, status: 'active' } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinHandler } = await import('../src/portal/getMyKin');
    const res = await getMyKinHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    expect(res.kin).toHaveLength(1);
    expect(res.kin[0].name).toBe('Buddy');
    expect(res.kin[0].aiBlurb).toBeNull();
  });

  it('merges the_411 blurb when legacyKinId set', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'the_411/10': { rawSummary: 'Mr Biggles is pure joy.' },
      },
      queryDocs: {
        'families/3/kin': [
          { id: 'k2', data: { name: 'Mr Biggles', legacyKinId: '10', status: 'active' } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinHandler } = await import('../src/portal/getMyKin');
    const res = await getMyKinHandler({ data: {}, auth: { uid: 'u1' } } as any);
    expect(res.kin[0].aiBlurb).toBe('Mr Biggles is pure joy.');
  });

  it('coerces unknown status to active', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] } },
      queryDocs: {
        'families/3/kin': [{ id: 'k1', data: { name: 'X', status: 'random' } }],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinHandler } = await import('../src/portal/getMyKin');
    const res = await getMyKinHandler({ data: {}, auth: { uid: 'u1' } } as any);
    expect(res.kin[0].status).toBe('active');
  });
});
