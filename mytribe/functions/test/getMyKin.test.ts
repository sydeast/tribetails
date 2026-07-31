import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());

/**
 * Wraps the mock db so every `.where(...)` issued anywhere in the chain is
 * recorded.
 *
 * The shared double now enforces `where` (P0-10 is fixed), so the statusless
 * fixture below would genuinely vanish if the filter came back. This proxy is
 * still the direct guard: it proves the filter was never ISSUED at all, which
 * is exactly the fix under test. The old
 * `.where('status', 'in', ['active', 'noLongerWithUs'])` silently dropped every
 * kin doc missing the field, which is how the mirror-created docs vanished.
 */
function recordWheres(db: any): { db: any; wheres: unknown[][] } {
  const wheres: unknown[][] = [];
  const wrap = (target: any): any =>
    new Proxy(target, {
      get(t, prop, recv) {
        const value = Reflect.get(t, prop, recv);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (prop === 'where') wheres.push(args);
          const out = value.apply(t, args);
          return out && typeof out === 'object' && typeof out.then !== 'function'
            ? wrap(out)
            : out;
        };
      },
    });
  return { db: wrap(db), wheres };
}

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

  // P0-9. The old fixture here seeded `status: 'random'` and asserted 'active',
  // an outcome production could never reach: with the server-side `in` filter,
  // real Firestore returned zero docs for it. A statusless doc is the shape
  // production DOES produce (the flat -> family mirror merges into a family doc
  // that may not exist yet), and it has to survive.
  it('lists a kin doc that has NO status field at all, defaulting it to active', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] } },
      queryDocs: {
        'families/3/kin': [{ id: 'k1', data: { name: 'Ghost' } }],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinHandler } = await import('../src/portal/getMyKin');
    const res = await getMyKinHandler({ data: {}, auth: { uid: 'u1' } } as any);
    expect(res.kin).toHaveLength(1);
    expect(res.kin[0].name).toBe('Ghost');
    expect(res.kin[0].status).toBe('active');
  });

  it('never asks Firestore to filter kin by status', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] } },
      queryDocs: {
        'families/3/kin': [{ id: 'k1', data: { name: 'Ghost' } }],
      },
    });
    const tracked = recordWheres(ctx.db);
    mocks.dbFn.mockReturnValue(tracked.db);
    const { getMyKinHandler } = await import('../src/portal/getMyKin');
    await getMyKinHandler({ data: {}, auth: { uid: 'u1' } } as any);
    expect(tracked.wheres.filter((args) => args[0] === 'status')).toEqual([]);
  });

  it('keeps a memorial kin in the list and reports noLongerWithUs', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] } },
      queryDocs: {
        'families/3/kin': [{ id: 'k1', data: { name: 'Biscuit', status: 'noLongerWithUs' } }],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinHandler } = await import('../src/portal/getMyKin');
    const res = await getMyKinHandler({ data: {}, auth: { uid: 'u1' } } as any);
    expect(res.kin).toHaveLength(1);
    expect(res.kin[0].status).toBe('noLongerWithUs');
  });

  it('hides the legacy admin statuses (inactive, archived) and nothing else', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] } },
      queryDocs: {
        'families/3/kin': [
          { id: 'k1', data: { name: 'Buddy', status: 'active' } },
          { id: 'k2', data: { name: 'Biscuit', status: 'noLongerWithUs' } },
          { id: 'k3', data: { name: 'Ghost' } },
          { id: 'k4', data: { name: 'OldInactive', status: 'inactive' } },
          { id: 'k5', data: { name: 'OldArchived', status: 'archived' } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyKinHandler } = await import('../src/portal/getMyKin');
    const res = await getMyKinHandler({ data: {}, auth: { uid: 'u1' } } as any);
    expect(res.kin.map((k) => k.name)).toEqual(['Buddy', 'Biscuit', 'Ghost']);
  });
});
