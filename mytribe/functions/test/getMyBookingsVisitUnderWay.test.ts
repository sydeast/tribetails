import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #1830 / #1832 / #1823: a visit the Auntie is working stays the household's
 * visit. On my way, Arrived and Departed are written to the SESSION only, so
 * each case below leaves the household's `kinCares` copy on `confirmed`, the
 * way production data looks, and moves the session.
 *
 * #2123 (operator ruling 2026-11-12): once the Auntie has departed the visit
 * is Completed for the household. There is no Departed stage on the wire.
 */

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());

const HOUR = 3600_000;

function visit(familyId: string, batchId: string, id: string, data: Record<string, unknown>) {
  return {
    id,
    path: `families/${familyId}/bookings/${batchId}/kinCares/${id}`,
    data: { familyId, batchId, kinIds: ['k1'], kinNames: ['Biscuit'], ...data },
  };
}

function session(id: string, data: Record<string, unknown>) {
  return { id, data };
}

function envelope() {
  return { envelopeStatus: 'confirmed', pattern: 'individual', kinIds: ['k1'], kinNames: ['Biscuit'], visitCount: 1 };
}

/** One confirmed visit of household 3, started `startedAgoMs` ago, behind a session in `sessionStatus`. */
function oneVisitDb(sessionStatus: string, opts: { startedAgoMs?: number; visitStatus?: string } = {}) {
  const startMs = Date.now() - (opts.startedAgoMs ?? 5 * 60_000);
  return buildDbMock({
    docs: {
      'clients/u1': { kinfolkIds: ['3'] },
      'families/3/bookings/env-a': envelope(),
    },
    collectionGroupDocs: {
      kinCares: [
        visit('3', 'env-a', 'v1', {
          status: opts.visitStatus ?? 'confirmed',
          visitProgress: null,
          startTime: Timestamp.fromMillis(startMs),
          sessionId: 'vis_v1',
        }),
      ],
    },
    queryDocs: {
      kin_care_sessions: [
        session('vis_v1', {
          kinfolkId: '3',
          status: sessionStatus,
          startTime: new Date(startMs).toISOString(),
          kinCareBatchId: 'env-a',
          kinCareVisitId: 'v1',
        }),
      ],
    },
  });
}

async function read(ctx: { db: unknown }, kinfolkId = '3', uid = 'u1') {
  mocks.dbFn.mockReturnValue(ctx.db);
  const { getMyBookingsHandler } = await import('../src/portal/getMyBookings');
  return getMyBookingsHandler({ data: { kinfolkId }, auth: { uid } } as any);
}

/** Every place a client looks a visit up by id: the three lists and the envelopes. */
function findById(res: Awaited<ReturnType<typeof read>>, id: string) {
  const listed = [res.liveVisit, ...res.upcoming, ...res.recent].filter((b) => b !== null);
  return listed.find((b) => b!.id === id) ?? res.envelopes.flatMap((e) => e.kinCares).find((b) => b.id === id) ?? null;
}

describe('getMyBookings: a visit past its start, at every status of its life', () => {
  it('confirmed and running late (session still SCHEDULED): on Upcoming as confirmed, not live', async () => {
    const res = await read(oneVisitDb('SCHEDULED'));
    expect(res.upcoming.map((b) => b.id)).toEqual(['v1']);
    expect(res.upcoming[0]).toMatchObject({ status: 'confirmed', visitProgress: null });
    expect(res.liveVisit).toBeNull();
    expect(res.recent).toEqual([]);
  });

  it('On the way: en route on Upcoming, and it is the live visit', async () => {
    const res = await read(oneVisitDb('ON_MY_WAY'));
    expect(res.upcoming.map((b) => b.id)).toEqual(['v1']);
    expect(res.upcoming[0]).toMatchObject({ status: 'enRoute', visitProgress: 'enRoute' });
    expect(res.liveVisit).toMatchObject({ id: 'v1', status: 'enRoute', kinNames: ['Biscuit'], sessionId: 'vis_v1' });
  });

  it('Arrived: in progress on Upcoming, and it is the live visit', async () => {
    const res = await read(oneVisitDb('ARRIVED'));
    expect(res.upcoming[0]).toMatchObject({ id: 'v1', status: 'active', visitProgress: 'active' });
    expect(res.liveVisit).toMatchObject({ id: 'v1', status: 'active', visitProgress: 'active', kinNames: ['Biscuit'] });
  });

  it('#2123 Departed: completed on Past Visits at once, off Upcoming, and the live card clears', async () => {
    const res = await read(oneVisitDb('DEPARTED'));
    expect(res.upcoming).toEqual([]);
    expect(res.liveVisit).toBeNull();
    expect(res.recent.map((b) => b.id)).toEqual(['v1']);
    expect(res.recent[0]).toMatchObject({ status: 'completed', visitProgress: 'ended' });
  });

  it('#2123 Departed with no KinTale sent: still completed, the household waits on nothing', async () => {
    // The session carries no reportIds and no sentReportCount, the state a
    // visit is in the minute the Auntie leaves.
    const res = await read(oneVisitDb('DEPARTED'));
    expect(findById(res, 'v1')).toMatchObject({ status: 'completed' });
    expect(res.envelopes[0].kinCares[0]).toMatchObject({ status: 'completed', visitProgress: 'ended' });
  });

  it('#2123 Departed does not reopen a visit the office cancelled', async () => {
    const res = await read(oneVisitDb('DEPARTED', { visitStatus: 'cancelled' }));
    expect(res.recent[0]).toMatchObject({ id: 'v1', status: 'cancelled' });
    expect(res.upcoming).toEqual([]);
  });

  it('Completed on the session before the household copy caught up: completed, on Past Visits', async () => {
    const res = await read(oneVisitDb('COMPLETED'));
    expect(res.upcoming).toEqual([]);
    expect(res.liveVisit).toBeNull();
    expect(res.recent.map((b) => b.id)).toEqual(['v1']);
    expect(res.recent[0].status).toBe('completed');
  });

  it('Completed on both: completed, on Past Visits', async () => {
    const res = await read(oneVisitDb('COMPLETED', { visitStatus: 'completed' }));
    expect(res.recent[0]).toMatchObject({ id: 'v1', status: 'completed' });
    expect(res.upcoming).toEqual([]);
  });

  it('a cancelled visit is not revived by a session left under way', async () => {
    const res = await read(oneVisitDb('ARRIVED', { visitStatus: 'cancelled' }));
    expect(res.recent[0]).toMatchObject({ id: 'v1', status: 'cancelled' });
    expect(res.liveVisit).toBeNull();
    expect(res.upcoming).toEqual([]);
  });

  it('an undone arrival (session back to SCHEDULED) reads confirmed again', async () => {
    const res = await read(oneVisitDb('SCHEDULED'));
    expect(findById(res, 'v1')).toMatchObject({ status: 'confirmed', visitProgress: null });
  });

  it.each([
    ['SCHEDULED', 'confirmed', null],
    ['ON_MY_WAY', 'enRoute', 'enRoute'],
    ['ARRIVED', 'active', 'active'],
    ['DEPARTED', 'completed', 'ended'],
    ['COMPLETED', 'completed', 'ended'],
  ])('by id, session %s: the visit is found, and its envelope copy agrees', async (sessionStatus, status, visitProgress) => {
    const res = await read(oneVisitDb(sessionStatus));
    expect(findById(res, 'v1')).toMatchObject({ id: 'v1', status, visitProgress });
    // The envelope copy is the one Android's detail screen reads first.
    expect(res.envelopes).toHaveLength(1);
    expect(res.envelopes[0].kinCares[0]).toMatchObject({ id: 'v1', status, visitProgress });
  });

  it('a visit under way stays listed however long ago it started', async () => {
    const res = await read(oneVisitDb('ARRIVED', { startedAgoMs: 30 * HOUR }));
    expect(res.upcoming.map((b) => b.id)).toEqual(['v1']);
  });

  it('a confirmed visit nobody started leaves Upcoming a day after its start, and still opens by id', async () => {
    const res = await read(oneVisitDb('SCHEDULED', { startedAgoMs: 25 * HOUR }));
    expect(res.upcoming).toEqual([]);
    expect(res.recent).toEqual([]);
    expect(findById(res, 'v1')).toMatchObject({ id: 'v1', status: 'confirmed' });
  });

  it('a request whose time passed unanswered gets no slack', async () => {
    const res = await read(oneVisitDb('PENDING', { visitStatus: 'requested' }));
    expect(res.upcoming).toEqual([]);
    expect(findById(res, 'v1')).toMatchObject({ id: 'v1', status: 'requested' });
  });

  it('a completed visit older than the ten on Past Visits still opens by id', async () => {
    const past = Date.now() - 40 * 24 * HOUR;
    const kinCares = Array.from({ length: 12 }, (_, i) =>
      visit('3', 'env-a', `done-${i}`, { status: 'completed', startTime: Timestamp.fromMillis(past + i * 24 * HOUR) }),
    );
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] }, 'families/3/bookings/env-a': envelope() },
      collectionGroupDocs: { kinCares },
      queryDocs: { kin_care_sessions: [] },
    });
    const res = await read(ctx);
    expect(res.recent).toHaveLength(10);
    expect(res.recent.map((b) => b.id)).not.toContain('done-0');
    expect(findById(res, 'done-0')).toMatchObject({ id: 'done-0', status: 'completed' });
  });
});

describe('getMyBookings: joining a visit to its session', () => {
  it('joins on the session\'s kinCareVisitId when the visit names no session, and lists it once', async () => {
    const startMs = Date.now() - 5 * 60_000;
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] }, 'families/3/bookings/env-a': envelope() },
      collectionGroupDocs: {
        kinCares: [visit('3', 'env-a', 'v1', { status: 'confirmed', startTime: Timestamp.fromMillis(startMs) })],
      },
      queryDocs: {
        kin_care_sessions: [
          session('vis_v1', {
            kinfolkId: '3',
            status: 'ARRIVED',
            startTime: new Date(startMs).toISOString(),
            kinCareBatchId: 'env-a',
            kinCareVisitId: 'v1',
          }),
        ],
      },
    });
    const res = await read(ctx);
    expect(res.upcoming.map((b) => b.id)).toEqual(['v1']);
    expect(res.liveVisit).toMatchObject({ id: 'v1', status: 'active', sessionId: 'vis_v1' });
  });

  it('the live visit is the one the Auntie is at, ahead of one she is on the way to', async () => {
    const startMs = Date.now() - 5 * 60_000;
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] }, 'families/3/bookings/env-a': envelope() },
      collectionGroupDocs: {
        kinCares: [
          visit('3', 'env-a', 'v-otw', { status: 'confirmed', startTime: Timestamp.fromMillis(startMs - HOUR), sessionId: 's-otw' }),
          visit('3', 'env-a', 'v-here', { status: 'confirmed', startTime: Timestamp.fromMillis(startMs), sessionId: 's-here' }),
          visit('3', 'env-a', 'v-next', { status: 'confirmed', startTime: Timestamp.fromMillis(startMs - 2 * HOUR), sessionId: 's-next' }),
        ],
      },
      queryDocs: {
        kin_care_sessions: [
          session('s-otw', { kinfolkId: '3', status: 'ON_MY_WAY' }),
          session('s-here', { kinfolkId: '3', status: 'ARRIVED' }),
          session('s-next', { kinfolkId: '3', status: 'SCHEDULED' }),
        ],
      },
    });
    const res = await read(ctx);
    expect(res.liveVisit?.id).toBe('v-here');
    // Under way leads the list; the late confirmed visit follows.
    expect(res.upcoming.map((b) => b.id)).toEqual(['v-otw', 'v-here', 'v-next']);
  });

  it('#2123 a visit with no booking record: Departed is finished, like Completed, so it leaves Upcoming', async () => {
    const startMs = Date.now() - 40 * 60_000;
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] } },
      collectionGroupDocs: { kinCares: [] },
      queryDocs: {
        kin_care_sessions: [
          session('sess-adhoc', {
            kinfolkId: '3',
            status: 'DEPARTED',
            serviceType: 'visit_30',
            startTime: new Date(startMs).toISOString(),
            kinIds: ['k1'],
            kinNames: ['Biscuit'],
          }),
        ],
      },
    });
    const res = await read(ctx);
    expect(res.upcoming).toEqual([]);
    expect(res.liveVisit).toBeNull();
  });

  it.each([
    ['ON_MY_WAY', 'enRoute'],
    ['ARRIVED', 'active'],
  ])('a visit with no booking record, %s: listed and live', async (sessionStatus, status) => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] } },
      collectionGroupDocs: { kinCares: [] },
      queryDocs: {
        kin_care_sessions: [
          session('sess-adhoc', { kinfolkId: '3', status: sessionStatus, startTime: new Date(Date.now() - HOUR).toISOString() }),
        ],
      },
    });
    const res = await read(ctx);
    expect(res.upcoming.map((b) => b.id)).toEqual(['sess-adhoc']);
    expect(res.liveVisit).toMatchObject({ id: 'sess-adhoc', status });
  });
});

describe('getMyBookings: another household\'s visit', () => {
  const startMs = Date.now() - 5 * 60_000;
  function twoHouseholds() {
    return buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'clients/u2': { kinfolkIds: ['9'] },
        'families/3/bookings/env-a': envelope(),
        'families/9/bookings/env-z': envelope(),
      },
      collectionGroupDocs: {
        kinCares: [
          visit('3', 'env-a', 'mine', { status: 'confirmed', startTime: Timestamp.fromMillis(startMs), sessionId: 'vis_theirs' }),
          visit('9', 'env-z', 'theirs', { status: 'confirmed', startTime: Timestamp.fromMillis(startMs), sessionId: 'vis_theirs' }),
        ],
      },
      queryDocs: {
        kin_care_sessions: [
          session('vis_theirs', { kinfolkId: '9', status: 'ARRIVED', kinCareBatchId: 'env-z', kinCareVisitId: 'theirs' }),
        ],
      },
    });
  }

  it('is in none of my lists and none of my envelopes, at any status', async () => {
    const res = await read(twoHouseholds());
    expect(findById(res, 'theirs')).toBeNull();
    // ("vis_theirs" is my own visit's stored session id; the visit id and the
    // envelope id are what must not cross.)
    expect(JSON.stringify(res)).not.toContain('"id":"theirs"');
    expect(JSON.stringify(res)).not.toContain('env-z');
  });

  it('its session cannot move my visit, even when my visit names that session', async () => {
    const res = await read(twoHouseholds());
    expect(findById(res, 'mine')).toMatchObject({ status: 'confirmed', visitProgress: null });
    expect(res.liveVisit).toBeNull();
  });

  it('asking for another household by id is refused', async () => {
    mocks.dbFn.mockReturnValue(twoHouseholds().db);
    const { getMyBookingsHandler } = await import('../src/portal/getMyBookings');
    await expect(
      getMyBookingsHandler({ data: { kinfolkId: '9' }, auth: { uid: 'u1' } } as any),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('its own household does see it under way', async () => {
    const res = await read(twoHouseholds(), '9', 'u2');
    expect(res.liveVisit).toMatchObject({ id: 'theirs', status: 'active' });
    expect(findById(res, 'mine')).toBeNull();
  });
});
