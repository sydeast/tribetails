import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());

/**
 * The shared double's `.limit(n)` reproduces the real SDK's
 * `validateInteger('limit', n)` check — the exact source of MYTRIBE-FUNCTIONS-4
 * (`Value for argument "limit" is not a valid integer.`) — so a raw 20.5
 * reaching Firestore throws here exactly as it does in production. It also
 * enforces the predicate and the page size, which the local no-op double this
 * replaced could not (P0-10).
 */
function buildVisitsDb(
  kinfolkIds: string[],
  sessions: Array<{ id: string; data: Record<string, unknown> }>,
) {
  return buildDbMock({
    docs: { 'clients/u1': { kinfolkIds } },
    queryDocs: { kin_care_sessions: sessions },
  });
}
/** 25 visits for one household, newest last, so a page size is observable. */
function manyVisits(kinfolkId: string) {
  return Array.from({ length: 25 }, (_, i) => ({
    id: `v${String(i).padStart(2, '0')}`,
    data: {
      kinfolkId,
      startTime: `2026-06-${String(i + 1).padStart(2, '0')}T10:00:00.000Z`,
      status: 'COMPLETED',
    },
  }));
}
describe('getMyVisitsHandler', () => {
  it('rejects unauthenticated request', async () => {
    const { getMyVisitsHandler } = await import('../src/portal/getMyVisits');
    await expect(
      getMyVisitsHandler({ data: {}, auth: undefined } as any),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });
  it('coerces a fractional limit to an integer before querying (MYTRIBE-FUNCTIONS-4)', async () => {
    // Wasm/JS callers can serialize the limit as a non-integer double; the raw
    // value must never reach Firestore's `.limit()`. Passing 20.5 through would
    // throw; truncating to 20 (not rounding to 21) is what the page proves.
    const ctx = buildVisitsDb(['fam3'], manyVisits('fam3'));
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyVisitsHandler } = await import('../src/portal/getMyVisits');
    const res = await getMyVisitsHandler({
      data: { kinfolkId: 'fam3', limit: 20.5 },
      auth: { uid: 'u1' },
    } as any);
    expect(res.visits).toHaveLength(20);
  });
  it('defaults limit to 10 when omitted', async () => {
    const ctx = buildVisitsDb(['fam3'], manyVisits('fam3'));
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyVisitsHandler } = await import('../src/portal/getMyVisits');
    const res = await getMyVisitsHandler({
      data: { kinfolkId: 'fam3' },
      auth: { uid: 'u1' },
    } as any);
    expect(res.visits).toHaveLength(10);
  });
});
describe('getMyVisitsHandler query semantics', () => {
  const session = (id: string, kinfolkId: string, startTime: string) => ({
    id,
    data: { kinfolkId, startTime, status: 'COMPLETED', serviceType: 'WALK' },
  });

  function ctxFor(sessions: Array<{ id: string; data: Record<string, unknown> }>) {
    return buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['fam3'] } },
      queryDocs: { kin_care_sessions: sessions },
    });
  }

  it('TENANT: returns only the caller household, never a neighbour', async () => {
    const ctx = ctxFor([
      session('mine-1', 'fam3', '2026-07-01T10:00:00.000Z'),
      session('theirs-1', 'fam9', '2026-07-02T10:00:00.000Z'),
      session('mine-2', 'fam3', '2026-07-03T10:00:00.000Z'),
      session('theirs-2', 'fam9', '2026-07-04T10:00:00.000Z'),
    ]);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyVisitsHandler } = await import('../src/portal/getMyVisits');

    const res = await getMyVisitsHandler({
      data: { kinfolkId: 'fam3' },
      auth: { uid: 'u1' },
    } as any);

    expect(res.visits.map((v) => v.id)).toEqual(['mine-2', 'mine-1']);
  });

  it('ORDER: most recent visit first', async () => {
    const ctx = ctxFor([
      session('oldest', 'fam3', '2026-07-01T10:00:00.000Z'),
      session('newest', 'fam3', '2026-07-09T10:00:00.000Z'),
      session('middle', 'fam3', '2026-07-05T10:00:00.000Z'),
    ]);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyVisitsHandler } = await import('../src/portal/getMyVisits');

    const res = await getMyVisitsHandler({
      data: { kinfolkId: 'fam3' },
      auth: { uid: 'u1' },
    } as any);

    expect(res.visits.map((v) => v.id)).toEqual(['newest', 'middle', 'oldest']);
  });

  it('PAGE SIZE: caps at the default 10 and at the requested page size', async () => {
    const sessions = Array.from({ length: 14 }, (_, i) =>
      session(`s${String(i).padStart(2, '0')}`, 'fam3', `2026-07-${String(i + 1).padStart(2, '0')}T10:00:00.000Z`),
    );
    mocks.dbFn.mockReturnValue(ctxFor(sessions).db);
    const { getMyVisitsHandler } = await import('../src/portal/getMyVisits');

    const dflt = await getMyVisitsHandler({
      data: { kinfolkId: 'fam3' },
      auth: { uid: 'u1' },
    } as any);
    expect(dflt.visits).toHaveLength(10);

    mocks.dbFn.mockReturnValue(ctxFor(sessions).db);
    const asked = await getMyVisitsHandler({
      data: { kinfolkId: 'fam3', limit: 3 },
      auth: { uid: 'u1' },
    } as any);
    expect(asked.visits.map((v) => v.id)).toEqual(['s13', 's12', 's11']);
  });
});
