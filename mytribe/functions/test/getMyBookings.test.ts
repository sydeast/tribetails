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

  it('splits live, upcoming, recent; the live visit is on Upcoming as well (#1832)', async () => {
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

    // #1832: the live visit leads Upcoming, so the tab's count is never 0
    // while the Auntie is at the door. Recent is unchanged.
    expect(res.liveVisit?.id).toBe('b-active');
    expect(res.upcoming.map((b) => b.id)).toEqual(['b-active', 'b-up']);
    expect(res.recent.map((b) => b.id).sort()).toEqual(['b-cancel', 'b-done']);

    // Each kinCare carries id + batchId + sourceBookingId + sessionId.
    expect(res.liveVisit?.batchId).toBe('env-a');
    expect(res.liveVisit?.sourceBookingId).toBe('auntie-1');
    expect(res.liveVisit?.sessionId).toBe('sess-1');
    expect(res.upcoming[1].batchId).toBe('env-a');
    expect(res.upcoming[1].sourceBookingId).toBeNull();
    expect(res.upcoming[1].sessionId).toBeNull();
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

  it('#1628: never hands the household the session\'s admin-internal note', async () => {
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
              notes: '[Office note 2026-11-05] Key is under the blue pot',
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
    expect(dto.notes).toBeNull();
    expect(JSON.stringify(res)).not.toContain('blue pot');
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

  it('#438: reports the cancellation ask as pending / accepted / declined', async () => {
    const future = Date.now() + 86400_000;
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] } },
      collectionGroupDocs: {
        kinCares: [
          visit('env-a', 'b-pending', {
            status: 'confirmed',
            startTime: Timestamp.fromMillis(future),
            cancelRequestedAt: Timestamp.fromMillis(Date.now()),
            cancelRequestStatus: 'pending',
            cancelRequestReason: 'We are away',
          }),
          visit('env-a', 'b-declined', {
            status: 'confirmed',
            startTime: Timestamp.fromMillis(future),
            cancelRequestedAt: Timestamp.fromMillis(Date.now()),
            cancelRequestStatus: 'declined',
            cancelResponseNote: 'Inside the 48-hour window.',
          }),
          // The July backlog: the stamp and no status field at all.
          visit('env-a', 'b-legacy', {
            status: 'confirmed',
            startTime: Timestamp.fromMillis(future),
            cancelRequestedAt: Timestamp.fromMillis(Date.now()),
          }),
          visit('env-a', 'b-never', { status: 'confirmed', startTime: Timestamp.fromMillis(future) }),
        ],
      },
      queryDocs: { kin_care_sessions: [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyBookingsHandler } = await import('../src/portal/getMyBookings');
    const res: any = await getMyBookingsHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    const by = Object.fromEntries(res.upcoming.map((b: any) => [b.id, b]));

    expect(by['b-pending']).toMatchObject({
      cancelRequested: true,
      cancelRequestStatus: 'pending',
      cancelRequestReason: 'We are away',
    });
    // Declined is NOT pending: the banner has to clear so they can ask again.
    expect(by['b-declined']).toMatchObject({
      cancelRequested: false,
      cancelRequestStatus: 'declined',
      cancelResponseNote: 'Inside the 48-hour window.',
    });
    expect(by['b-legacy']).toMatchObject({ cancelRequested: true, cancelRequestStatus: 'pending' });
    expect(by['b-never']).toMatchObject({ cancelRequested: false, cancelRequestStatus: null });
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

/**
 * #1098: an Overnight is requested as a NIGHT and the operator sets its start
 * later, so until then the visit has no start instant. The household must still
 * see it, under Upcoming, ordered by its night, and told the time is coming.
 */
describe('getMyBookingsHandler: visits awaiting a start time (#1098)', () => {
  const DAY = 86_400_000;
  const dateIn = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
  it('returns startTimePending and requestedDate, and keeps the pending night in Upcoming in date order', async () => {
    const inTwoDays = Date.now() + 2 * DAY;
    const inFourDays = Date.now() + 4 * DAY;
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        // Every visit in this envelope awaits a time, so its instant rollups are null.
        'families/3/bookings/env-n': { envelopeStatus: 'requested', pattern: 'individual', firstStartTime: null, lastStartTime: null },
        'families/3/bookings/env-t': {
          envelopeStatus: 'confirmed', pattern: 'individual',
          firstStartTime: Timestamp.fromMillis(inTwoDays), lastStartTime: Timestamp.fromMillis(inFourDays),
        },
      },
      collectionGroupDocs: {
        kinCares: [
          visit('env-t', 'late', { status: 'confirmed', startTime: Timestamp.fromMillis(inFourDays), startTimePending: false, requestedDate: null }),
          visit('env-n', 'night', { status: 'requested', startTime: null, endTime: null, startTimePending: true, requestedDate: dateIn(3) }),
          visit('env-t', 'early', { status: 'confirmed', startTime: Timestamp.fromMillis(inTwoDays) }),
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyBookingsHandler } = await import('../src/portal/getMyBookings');
    const res = await getMyBookingsHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    expect(res.upcoming.map((b) => b.id)).toEqual(['early', 'night', 'late']);
    const night = res.upcoming.find((b) => b.id === 'night')!;
    expect(night).toMatchObject({ startTimePending: true, requestedDate: dateIn(3), startTimeMs: null, endTimeMs: null });
    const early = res.upcoming.find((b) => b.id === 'early')!;
    // A visit written before #1098 has neither field: not pending, no date.
    expect(early).toMatchObject({ startTimePending: false, requestedDate: null });
    // The all-night envelope sorts by its night, not to 1970.
    expect(res.envelopes.map((e) => e.batchId)).toEqual(['env-t', 'env-n']);
  });

  it('drops a pending night whose date has passed out of Upcoming, like any past visit', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] } },
      collectionGroupDocs: {
        kinCares: [visit('env-n', 'old', { status: 'requested', startTime: null, startTimePending: true, requestedDate: dateIn(-3) })],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyBookingsHandler } = await import('../src/portal/getMyBookings');
    const res = await getMyBookingsHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    expect(res.upcoming).toEqual([]);
  });
});
describe('getMyBookingsHandler: what a completed visit points at (#1303)', () => {
  const past = () => Date.now() - 86400_000;
  function fixture(extraDocs: Record<string, Record<string, unknown>> = {}) {
    return buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'families/3': { serviceAddress: '12 Elm St, Austin TX' },
        ...extraDocs,
      },
      queryDocs: {
        kin_care_reports: [
          { id: 'tale-1', data: { kinfolkId: '3', sessionId: 'sess-done', sentAt: '2026-07-02T20:00:00Z' } },
          { id: 'tale-draft', data: { kinfolkId: '3', sessionId: 'sess-other' } },
          { id: 'tale-else', data: { kinfolkId: '9', sessionId: 'sess-done', sentAt: '2026-07-02T20:00:00Z' } },
        ],
        invoices: [
          { id: 'inv-1', data: { kinfolkId: '3', sessionIds: ['sess-done'] } },
          { id: 'inv-2', data: { kinfolkId: '3', lineItems: [{ sessionId: 'sess-lined' }] } },
          { id: 'inv-else', data: { kinfolkId: '9', sessionIds: ['sess-done'] } },
        ],
      },
      collectionGroupDocs: {
        kinCares: [
          visit('env-b', 'done', { status: 'completed', startTime: Timestamp.fromMillis(past()), sessionId: 'sess-done' }),
          visit('env-b', 'lined', { status: 'completed', startTime: Timestamp.fromMillis(past()), sessionId: 'sess-lined' }),
          visit('env-b', 'bare', { status: 'completed', startTime: Timestamp.fromMillis(past()) }),
          visit('env-b', 'draft', { status: 'completed', startTime: Timestamp.fromMillis(past()), sessionId: 'sess-other' }),
          visit('env-b', 'up', { status: 'confirmed', startTime: Timestamp.fromMillis(Date.now() + 86400_000), sessionId: 'sess-done' }),
        ],
      },
    });
  }
  async function run(ctx: ReturnType<typeof fixture>) {
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyBookingsHandler } = await import('../src/portal/getMyBookings');
    const res = await getMyBookingsHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    const byId = new Map([...res.recent, ...res.upcoming].map((b) => [b.id, b]));
    return { res, byId };
  }
  it('links a completed visit to its sent KinTale and its invoice, and carries the household address', async () => {
    const { byId } = await run(fixture());
    expect(byId.get('done')).toMatchObject({ kinTaleId: 'tale-1', invoiceId: 'inv-1', address: '12 Elm St, Austin TX' });
  });
  it('finds the invoice through a stored line bound to the visit', async () => {
    const { byId } = await run(fixture());
    expect(byId.get('lined')).toMatchObject({ invoiceId: 'inv-2', kinTaleId: null });
  });
  it('never links a draft report, another household, or a visit with no session', async () => {
    const { byId } = await run(fixture());
    expect(byId.get('draft')).toMatchObject({ kinTaleId: null, invoiceId: null });
    expect(byId.get('bare')).toMatchObject({ kinTaleId: null, invoiceId: null });
  });
  it('does not link anything on a visit that is not completed, but still gives its address', async () => {
    const { byId } = await run(fixture());
    expect(byId.get('up')).toMatchObject({ kinTaleId: null, invoiceId: null, address: '12 Elm St, Austin TX' });
  });
  it('withholds the invoice id from a member without billing access, and keeps the KinTale', async () => {
    const { byId } = await run(
      fixture({ 'families/3/members/u1': { role: 'SECONDARY', status: 'ACTIVE', permissions: { billing_full: false } } }),
    );
    expect(byId.get('done')).toMatchObject({ kinTaleId: 'tale-1', invoiceId: null });
  });
  it('has a null address when the household has none on file', async () => {
    const { byId } = await run(
      buildDbMock({
        docs: { 'clients/u1': { kinfolkIds: ['3'] }, 'families/3': {} },
        collectionGroupDocs: { kinCares: [visit('env-b', 'done', { status: 'completed', startTime: Timestamp.fromMillis(past()) })] },
      }) as unknown as ReturnType<typeof fixture>,
    );
    expect(byId.get('done')?.address).toBeNull();
  });
});

describe('getMyBookingsHandler: what time each visit is shown at (#1301, #1863, #2034)', () => {
  /** 2030-11-19 is CST (UTC-6) in America/Chicago, the business zone below. */
  const at = (hh: number, mm = 0) => Date.UTC(2030, 10, 19, hh + 6, mm);
  const BLOCKS = [
    { id: 'morning', label: 'Morning', startTime: '08:00', endTime: '11:00', active: true },
    { id: 'midday', label: 'Midday', startTime: '11:00', endTime: '15:00', active: true },
    { id: 'evening', label: 'Evening', startTime: '16:00', endTime: '19:00', active: true },
  ];
  const TIME_BLOCKS = { allowTimeBlockBooking: true, allowSpecificTimeBooking: false, defaultBookingMode: 'TIME_BLOCK' };
  const EXACT_TIMES = { allowTimeBlockBooking: false, allowSpecificTimeBooking: true, defaultBookingMode: 'SPECIFIC_TIME' };
  async function read(mode: Record<string, unknown>) {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'business_settings/business_settings': {
          ...mode,
          timeZone: 'America/Chicago',
          timeBlocks: BLOCKS,
          serviceRates: { Overnight: '120' },
          serviceStartTimeBooking: { Overnight: true },
        },
        'families/3/bookings/env-1': { envelopeStatus: 'confirmed', pattern: 'individual' },
      },
      collectionGroupDocs: {
        kinCares: [
          visit('env-1', 'blk', { status: 'confirmed', startTime: Timestamp.fromMillis(at(11)), timeBlockId: 'midday', timeBlockLabel: 'Midday' }),
          // #2034: the office moved a Midday booking to 12:30, then another to 16:30.
          visit('env-1', 'moved', { status: 'confirmed', startTime: Timestamp.fromMillis(at(12, 30)), timeBlockId: 'midday', timeBlockLabel: 'Midday' }),
          visit('env-1', 'movedOut', { status: 'confirmed', startTime: Timestamp.fromMillis(at(16, 30)), timeBlockId: 'midday', timeBlockLabel: 'Midday' }),
          // An office clock booking in no block, exactly between two (the tie).
          visit('env-1', 'clock', { status: 'confirmed', startTime: Timestamp.fromMillis(at(15, 30)), timeBlockId: null, timeBlockLabel: null }),
          // A block that has since been removed.
          visit('env-1', 'gone', { status: 'confirmed', startTime: Timestamp.fromMillis(at(9)), timeBlockId: 'brunch', timeBlockLabel: 'Brunch' }),
          // A household asked to move a visit to 16:30.
          visit('env-1', 'asked', {
            status: 'confirmed',
            startTime: Timestamp.fromMillis(at(11)),
            timeBlockId: 'midday',
            rescheduleRequestStatus: 'pending',
            rescheduleRequestedStartTime: Timestamp.fromMillis(at(16)),
            rescheduleRequestedTimeBlockId: 'evening',
          }),
        ],
      },
      queryDocs: {
        kin_care_sessions: [
          { id: 'sess-office', data: { kinfolkId: '3', status: 'SCHEDULED', startTime: new Date(at(9, 15)).toISOString() } },
          // An office-booked Overnight, a start-time KinCare: keeps its clock.
          {
            id: 'sess-overnight',
            data: { kinfolkId: '3', status: 'SCHEDULED', serviceType: 'Overnight', startTime: new Date(at(19)).toISOString() },
          },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyBookingsHandler } = await import('../src/portal/getMyBookings');
    const res = await getMyBookingsHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    return (id: string) => res.upcoming.find((b) => b.id === id)!;
  }
  it('Time Blocks: every visit is shown as the nearest block, by its CURRENT start', async () => {
    const by = await read(TIME_BLOCKS);
    expect(by('blk')).toMatchObject({ timeBlockLabel: 'Midday', timeBlockStartTime: '11:00', timeBlockEndTime: '15:00' });
    expect(by('moved')).toMatchObject({ timeBlockLabel: 'Midday' });
    expect(by('movedOut')).toMatchObject({ timeBlockLabel: 'Evening', timeBlockStartTime: '16:00', timeBlockEndTime: '19:00' });
    // The tie: 30 minutes from both edges -> the earlier block.
    expect(by('clock')).toMatchObject({ timeBlockLabel: 'Midday' });
    expect(by('gone')).toMatchObject({ timeBlockLabel: 'Morning', timeBlockStartTime: '08:00', timeBlockEndTime: '11:00' });
    expect(by('sess-office')).toMatchObject({ timeBlockLabel: 'Morning' });
    expect(by('sess-overnight')).toMatchObject({ timeBlockLabel: null });
    expect(by('asked')).toMatchObject({
      rescheduleRequestedTimeBlockLabel: 'Evening',
      rescheduleRequestedTimeBlockStartTime: '16:00',
      rescheduleRequestedTimeBlockEndTime: '19:00',
    });
    // The clock is never dropped: the date and order still come from it.
    expect(by('moved').startTimeMs).toBe(at(12, 30));
  });
  it('Exact times: no visit carries a block, so every client prints the clock', async () => {
    const by = await read(EXACT_TIMES);
    for (const id of ['blk', 'moved', 'movedOut', 'clock', 'gone', 'sess-office', 'asked']) {
      expect(by(id)).toMatchObject({ timeBlockLabel: null, timeBlockStartTime: null, timeBlockEndTime: null });
    }
    expect(by('asked').rescheduleRequestedTimeBlockLabel).toBeNull();
    expect(by('moved').startTimeMs).toBe(at(12, 30));
  });
  it('switching the mode re-reads the same stored visits: no data is rewritten', async () => {
    const blocks = await read(TIME_BLOCKS);
    const exact = await read(EXACT_TIMES);
    expect(blocks('moved').timeBlockLabel).toBe('Midday');
    expect(exact('moved').timeBlockLabel).toBeNull();
    expect(blocks('moved').startTimeMs).toBe(exact('moved').startTimeMs);
  });
});

