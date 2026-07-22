import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());

/** Helper: builds a kinCares collectionGroup row under a given batch. */
function visit(batchId: string, id: string, data: Record<string, unknown>) {
  return {
    id,
    path: `families/3/bookings/${batchId}/kinCares/${id}`,
    data: { familyId: '3', batchId, ...data },
  };
}

describe('getMyBookingsHandler', () => {
  it('rejects unauth', async () => {
    const { getMyBookingsHandler } = await import('../src/portal/getMyBookings');
    await expect(getMyBookingsHandler({ data: {}, auth: undefined } as any)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('splits live, upcoming, recent — buckets unchanged from the pre-envelope shape', async () => {
    const future = Date.now() + 86400_000;
    const past = Date.now() - 86400_000;
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'families/3/bookings/env-a': {
          envelopeStatus: 'inProgress',
          pattern: 'individual',
          serviceName: 'Walk',
          kinIds: ['k1'],
          kinNames: ['Rex'],
          notes: 'gate code 1234',
          visitCount: 2,
          confirmedCount: 1,
          completedCount: 0,
          firstStartTime: Timestamp.fromMillis(Date.now()),
          lastStartTime: Timestamp.fromMillis(future),
        },
        'families/3/bookings/env-b': {
          envelopeStatus: 'completed',
          pattern: 'individual',
          serviceName: 'Walk',
          kinIds: [],
          kinNames: [],
          notes: null,
          visitCount: 2,
          confirmedCount: 0,
          completedCount: 2,
          firstStartTime: Timestamp.fromMillis(past),
          lastStartTime: Timestamp.fromMillis(past),
        },
      },
      collectionGroupDocs: {
        kinCares: [
          visit('env-a', 'b-active', { status: 'active', visitProgress: 'active', startTime: Timestamp.fromMillis(Date.now()), sourceBookingId: 'auntie-1', sessionId: 'sess-1' }),
          visit('env-a', 'b-up', { status: 'confirmed', startTime: Timestamp.fromMillis(future) }),
          visit('env-b', 'b-done', { status: 'completed', startTime: Timestamp.fromMillis(past) }),
          visit('env-b', 'b-cancel', { status: 'cancelled', startTime: Timestamp.fromMillis(past) }),
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyBookingsHandler } = await import('../src/portal/getMyBookings');
    const res = await getMyBookingsHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);

    // Buckets identical to the old behaviour.
    expect(res.liveVisit?.id).toBe('b-active');
    expect(res.upcoming.map((b) => b.id)).toEqual(['b-up']);
    expect(res.recent.map((b) => b.id).sort()).toEqual(['b-cancel', 'b-done']);

    // Each kinCare carries id + batchId + sourceBookingId + sessionId.
    expect(res.liveVisit?.batchId).toBe('env-a');
    expect(res.liveVisit?.sourceBookingId).toBe('auntie-1');
    expect(res.liveVisit?.sessionId).toBe('sess-1');
    expect(res.upcoming[0].batchId).toBe('env-a');
    expect(res.upcoming[0].sourceBookingId).toBeNull();
    expect(res.upcoming[0].sessionId).toBeNull();
  });

  it('returns an envelopes[] array grouping kinCares with envelope-level fields', async () => {
    const future = Date.now() + 86400_000;
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'families/3/bookings/env-a': {
          envelopeStatus: 'partiallyConfirmed',
          pattern: 'weekly',
          serviceName: 'Walk',
          kinIds: ['k1'],
          kinNames: ['Rex'],
          notes: 'gate code 1234',
          visitCount: 2,
          confirmedCount: 1,
          completedCount: 0,
          firstStartTime: Timestamp.fromMillis(future),
          lastStartTime: Timestamp.fromMillis(future + 86400_000),
        },
      },
      collectionGroupDocs: {
        kinCares: [
          visit('env-a', 'v1', { status: 'confirmed', startTime: Timestamp.fromMillis(future) }),
          visit('env-a', 'v2', { status: 'requested', startTime: Timestamp.fromMillis(future + 86400_000) }),
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyBookingsHandler } = await import('../src/portal/getMyBookings');
    const res: any = await getMyBookingsHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);

    expect(Array.isArray(res.envelopes)).toBe(true);
    expect(res.envelopes).toHaveLength(1);
    const env = res.envelopes[0];
    expect(env.batchId).toBe('env-a');
    expect(env.envelopeStatus).toBe('partiallyConfirmed');
    expect(env.pattern).toBe('weekly');
    expect(env.serviceName).toBe('Walk');
    expect(env.kinIds).toEqual(['k1']);
    expect(env.kinNames).toEqual(['Rex']);
    expect(env.notes).toBe('gate code 1234');
    expect(env.visitCount).toBe(2);
    expect(env.confirmedCount).toBe(1);
    expect(env.completedCount).toBe(0);
    expect(env.firstStartTimeMs).toBe(future);
    expect(env.lastStartTimeMs).toBe(future + 86400_000);
    expect(env.kinCares.map((k: any) => k.id)).toEqual(['v1', 'v2']);
    expect(env.kinCares[0].batchId).toBe('env-a');
  });

  it('returns empty buckets + empty envelopes when no kinCares', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] } },
      collectionGroupDocs: { kinCares: [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyBookingsHandler } = await import('../src/portal/getMyBookings');
    const res: any = await getMyBookingsHandler({ data: {}, auth: { uid: 'u1' } } as any);
    expect(res.liveVisit).toBeNull();
    expect(res.upcoming).toEqual([]);
    expect(res.recent).toEqual([]);
    expect(res.envelopes).toEqual([]);
  });

  // An admin-scheduled visit lives ONLY in kin_care_sessions (no booking
  // envelope). Before the merge it never reached the kinfolk's Upcoming list.
  it('surfaces an ad-hoc kin_care_session (no booking) in upcoming', async () => {
    const future = Date.now() + 3 * 3600_000;
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] } },
      collectionGroupDocs: { kinCares: [] },
      queryDocs: {
        kin_care_sessions: [
          {
            id: 'sess-adhoc',
            data: {
              kinfolkId: '3',
              status: 'SCHEDULED',
              serviceType: 'visit_60',
              startTime: new Date(future).toISOString(),
              endTime: new Date(future + 3600_000).toISOString(),
              kinIds: ['k1'],
            },
          },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyBookingsHandler } = await import('../src/portal/getMyBookings');
    const res: any = await getMyBookingsHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    const dto = res.upcoming.find((b: any) => b.id === 'sess-adhoc');
    expect(dto).toBeTruthy();
    expect(dto.status).toBe('confirmed');
    expect(dto.sessionId).toBe('sess-adhoc');
    expect(dto.serviceType).toBe('visit_60');
    expect(dto.startTimeMs).toBe(future);
  });

  it('does not double-show a kin_care_session already linked to a booking', async () => {
    const future = Date.now() + 3 * 3600_000;
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'families/3/bookings/env-a': { envelopeStatus: 'confirmed', pattern: 'individual' },
      },
      collectionGroupDocs: {
        kinCares: [visit('env-a', 'b-up', { status: 'confirmed', startTime: Timestamp.fromMillis(future), sessionId: 'sess-linked' })],
      },
      queryDocs: {
        kin_care_sessions: [{ id: 'sess-linked', data: { kinfolkId: '3', status: 'SCHEDULED', startTime: new Date(future).toISOString() } }],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyBookingsHandler } = await import('../src/portal/getMyBookings');
    const res: any = await getMyBookingsHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    expect(res.upcoming.map((b: any) => b.id)).toEqual(['b-up']);
  });

  it('ignores completed/cancelled ad-hoc sessions — they are not upcoming', async () => {
    const now = Date.now();
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] } },
      collectionGroupDocs: { kinCares: [] },
      queryDocs: {
        kin_care_sessions: [
          { id: 's-done', data: { kinfolkId: '3', status: 'COMPLETED', startTime: new Date(now).toISOString() } },
          { id: 's-cancel', data: { kinfolkId: '3', status: 'CANCELLED', startTime: new Date(now).toISOString() } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyBookingsHandler } = await import('../src/portal/getMyBookings');
    const res: any = await getMyBookingsHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    expect(res.upcoming).toEqual([]);
  });
});
