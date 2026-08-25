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

/**
 * THE BOUNDARY. ISSUE #584 removed the kinfolk `allow read` on
 * `kin_care_sessions`, which makes this callable the ONLY way a household sees
 * a visit — and therefore makes "what does NOT cross the boundary" as much of a
 * test subject as what does. Same shape as `getBookingPolicy.test.ts`, for the
 * same reason and against a document that carries far more.
 *
 * These cases pass against the pre-#584 handler too, and that is the point:
 * `getMyVisits` already projected field by field, so the property being pinned
 * is not a new behaviour but the one the rule change now depends on. A future
 * `return { id: d.id, ...data }` would be a two-character convenience that
 * silently re-opens everything #584 closed, and this is what stops it.
 */
describe('getMyVisitsHandler projection boundary', () => {
  /** Everything AuntieOS puts on a session that is none of a household's business. */
  const ADMIN_ONLY = {
    notes: 'Gate code 1234, key under the third planter',
    kinfolkNotes: 'Rufus is shy with strangers',
    invoiceId: 'inv-77',
    sitterPayout: 4200,
    assignedSitterId: 'auntie-9',
    visitRouteId: 'vr-1',
    formValues: { doorLocked: 'yes', alarmCode: '9911' },
    autoCompleteEligible: true,
    kinfolkName: 'The Fosters',
    completedAt: '2026-07-02T11:00:00.000Z',
  };

  function ctxWith(data: Record<string, unknown>) {
    return buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['fam3'] },
        'business_settings/business_settings': { allowClientLocationSharing: true },
      },
      queryDocs: { kin_care_sessions: [{ id: 'v1', data }] },
    });
  }

  it('serves the DTO keys and no others, whatever else the document carries', async () => {
    mocks.dbFn.mockReturnValue(
      ctxWith({
        kinfolkId: 'fam3',
        startTime: '2026-07-01T10:00:00.000Z',
        endTime: '2026-07-01T11:00:00.000Z',
        arrivedAt: '2026-07-01T10:02:00.000Z',
        departedAt: '2026-07-01T10:58:00.000Z',
        status: 'COMPLETED',
        serviceType: 'WALK',
        ...ADMIN_ONLY,
      }).db,
    );
    const { getMyVisitsHandler } = await import('../src/portal/getMyVisits');
    const res = await getMyVisitsHandler({ data: { kinfolkId: 'fam3' }, auth: { uid: 'u1' } } as any);

    expect(Object.keys(res.visits[0]).sort()).toEqual([
      'arrivedAtIso',
      'departedAtIso',
      'endTimeIso',
      'id',
      'serviceType',
      'startTimeIso',
      'status',
    ]);

    const wire = JSON.stringify(res);
    expect(wire).not.toContain('Gate code 1234');
    expect(wire).not.toContain('9911');
    expect(wire).not.toContain('inv-77');
    expect(wire).not.toContain('auntie-9');
    expect(wire).not.toContain('sitterPayout');
    expect(wire).not.toContain('Rufus is shy');
  });

  /**
   * A FIELD ADDED TO THE STORED DOCUMENT LATER MUST NOT APPEAR ON ITS OWN. The
   * two `neverSeenBefore` keys stand in for the next thing AuntieOS writes here,
   * at both levels: the document and the nested `gpsSummary`, which is projected
   * key by key for exactly this reason.
   */
  it('a field the projection has never heard of does not ride along', async () => {
    mocks.dbFn.mockReturnValue(
      ctxWith({
        kinfolkId: 'fam3',
        startTime: '2026-07-01T10:00:00.000Z',
        status: 'COMPLETED',
        neverSeenBefore: 'FUTURE-ADMIN-FIELD',
        gpsSummary: {
          distanceMeters: 1900,
          durationSeconds: 1500,
          startLat: 30.1,
          startLng: -97.7,
          neverSeenBefore: 'FUTURE-COORDINATE-FIELD',
        },
      }).db,
    );
    const { getMyVisitsHandler } = await import('../src/portal/getMyVisits');
    const res = await getMyVisitsHandler({ data: { kinfolkId: 'fam3' }, auth: { uid: 'u1' } } as any);

    expect(JSON.stringify(res)).not.toContain('neverSeenBefore');
    expect(JSON.stringify(res)).not.toContain('FUTURE-ADMIN-FIELD');
    expect(JSON.stringify(res)).not.toContain('FUTURE-COORDINATE-FIELD');
    // The known coordinate keys still come through, so this is a projection and
    // not an accidental blanket denial.
    expect(res.visits[0]?.gpsSummary?.startLat).toBe(30.1);
    expect(Object.keys(res.visits[0].gpsSummary ?? {}).sort()).toEqual([
      'distanceMeters',
      'durationSeconds',
      'startLat',
      'startLng',
    ]);
  });
});
