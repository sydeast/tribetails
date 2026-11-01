import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { buildDbMock } from './_helpers/mockDb';
import { callableRequest } from './_helpers/callableRequest';

/**
 * #1281: a successful save looked like a failure for 5 to 20 seconds, because
 * the portal kept showing its pre-save list until an invalidated refetch came
 * back. The fix on the server is that every portal booking write hands back
 * the record it just wrote, in the exact `getMyBookings` shape, for the client
 * to drop into its cache.
 *
 * And the duplicate booking half: a second press of Create Booking with the
 * same key must get the FIRST booking back, not write another. These tests run
 * the mock with `writeThrough` so the second attempt really sees what the
 * first one wrote, and they count documents rather than trusting the reply.
 */
const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), writeAuditEntryFn: vi.fn(), approveFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));
vi.mock('../src/lib/defaultAssignee', () => ({ resolveDefaultAssignee: vi.fn().mockResolvedValue(null) }));
vi.mock('../src/admin/approveBookingSeriesCore', () => ({ approveBookingSeriesCore: mocks.approveFn }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { requestBookingHandler } from '../src/portal/requestBooking';
import { requestBookingRescheduleHandler } from '../src/portal/requestBookingReschedule';
import { requestBookingCancellationHandler } from '../src/portal/requestBookingCancellation';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const KEY = 'req_1756400000000_a1b2c3';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.writeAuditEntryFn.mockReset();
  mocks.writeAuditEntryFn.mockResolvedValue('audit-1');
  mocks.approveFn.mockReset();
  mocks.approveFn.mockResolvedValue({ sessionsCreated: 0, failedVisits: [] });
});

function portalDocs(): Record<string, Record<string, unknown> | null> {
  return {
    'clients/u1': { kinfolkIds: ['kf1'] },
    'base_services/svc_walk': { name: 'Dog Walk', priceCents: 2500 },
  };
}

function bookingData(startTimeMs: number) {
  return {
    kinfolkId: 'kf1',
    idempotencyKey: KEY,
    visits: [{ startTimeMs, endTimeMs: startTimeMs + HOUR, serviceId: 'svc_walk', serviceName: 'Dog Walk' }],
  };
}

const envelopeWrites = (ctx: ReturnType<typeof buildDbMock>) =>
  ctx.writes.filter((w) => /^families\/kf1\/bookings\/[^/]+$/.test(w.path));
const visitWrites = (ctx: ReturnType<typeof buildDbMock>) => ctx.writes.filter((w) => w.path.includes('/kinCares/'));

describe('#1281 requestBooking hands back the booking it wrote', () => {
  it('returns the new envelope and its visit in the getMyBookings shape', async () => {
    const ctx = buildDbMock({ docs: portalDocs(), writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);
    const start = Date.now() + DAY;

    const res = await requestBookingHandler(callableRequest(bookingData(start), { uid: 'u1' }));

    expect(res.batchId).toBe(KEY);
    expect(res.envelope).not.toBeNull();
    expect(res.envelope!.batchId).toBe(KEY);
    expect(res.envelope!.envelopeStatus).toBe('requested');
    expect(res.envelope!.firstStartTimeMs).toBe(start);
    expect(res.envelope!.kinCares).toHaveLength(1);
    const visit = res.envelope!.kinCares[0]!;
    expect(visit.batchId).toBe(KEY);
    expect(visit.kinfolkId).toBe('kf1');
    expect(visit.status).toBe('requested');
    expect(visit.startTimeMs).toBe(start);
    expect(visit.serviceType).toBe('Dog Walk');
  });

  it('a double submit with the same key writes ONE booking and returns it both times', async () => {
    const ctx = buildDbMock({ docs: portalDocs(), writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);
    const start = Date.now() + DAY;

    const first = await requestBookingHandler(callableRequest(bookingData(start), { uid: 'u1' }));
    const writesAfterFirst = ctx.writes.length;
    const second = await requestBookingHandler(callableRequest(bookingData(start), { uid: 'u1' }));

    // The duplicate #1281 reported, asserted as documents written.
    expect(envelopeWrites(ctx)).toHaveLength(1);
    expect(visitWrites(ctx)).toHaveLength(1);
    expect(ctx.writes.length).toBe(writesAfterFirst);
    expect(mocks.writeAuditEntryFn).toHaveBeenCalledTimes(1);
    // ...and the second press is told about the first booking, visit ids included.
    expect(second.batchId).toBe(first.batchId);
    expect(second.envelope!.kinCares.map((v) => v.id)).toEqual(first.envelope!.kinCares.map((v) => v.id));
  });

  it('a read-back failure does not fail a booking that committed', async () => {
    const ctx = buildDbMock({ docs: portalDocs(), writeThrough: true });
    mocks.dbFn.mockReturnValue(ctx.db);
    // Refs are memoised, so this is the same object the handler reads. Reads
    // before the write go through; the read-back after it fails.
    const envelopePath = `families/kf1/bookings/${KEY}`;
    const ref = ctx.db.doc(envelopePath);
    const realGet = ref.get;
    ref.get = vi.fn(async () => {
      if (ctx.writes.some((w) => w.path === envelopePath)) throw new Error('read-back down');
      return realGet();
    });
    const res = await requestBookingHandler(callableRequest(bookingData(Date.now() + DAY), { uid: 'u1' }));

    expect(res.batchId).toBe(KEY);
    expect(res.envelope).toBeNull();
    expect(envelopeWrites(ctx)).toHaveLength(1);
  });
});

describe('#1281 reschedule and cancellation asks hand back the visit as stored', () => {
  const VISIT = 'families/kf1/bookings/b1/kinCares/v1';

  it('a reschedule ask returns the visit with the proposal pending on it', async () => {
    const start = Date.now() + 2 * DAY;
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['kf1'] },
        [VISIT]: {
          batchId: 'b1',
          status: 'confirmed',
          startTime: Timestamp.fromMillis(start),
          endTime: Timestamp.fromMillis(start + HOUR),
        },
      },
      writeThrough: true,
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const proposed = Date.now() + 3 * DAY;

    const res = await requestBookingRescheduleHandler(
      callableRequest({ kinfolkId: 'kf1', batchId: 'b1', visitId: 'v1', proposedStartTimeMs: proposed }, { uid: 'u1' }),
    );

    expect(res.visit).not.toBeNull();
    expect(res.visit!.id).toBe('v1');
    expect(res.visit!.rescheduleRequestStatus).toBe('pending');
    expect(res.visit!.rescheduleRequestedStartTimeMs).toBe(proposed);
    expect(res.visit!.rescheduleRequestedEndTimeMs).toBe(proposed + HOUR);
    // The visit did not move; only the ask is recorded.
    expect(res.visit!.startTimeMs).toBe(start);
  });

  it('a cancellation ask returns the visit with the ask pending on it', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['kf1'] },
        [VISIT]: { batchId: 'b1', status: 'confirmed', startTime: Timestamp.fromMillis(Date.now() + 2 * DAY) },
      },
      writeThrough: true,
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await requestBookingCancellationHandler(
      callableRequest({ kinfolkId: 'kf1', batchId: 'b1', visitId: 'v1', reason: 'Trip cancelled' }, { uid: 'u1' }),
    );

    expect(res.alreadyPending).toBe(false);
    expect(res.visit).not.toBeNull();
    expect(res.visit!.cancelRequested).toBe(true);
    expect(res.visit!.cancelRequestStatus).toBe('pending');
    expect(res.visit!.cancelRequestReason).toBe('Trip cancelled');
    expect(res.visit!.status).toBe('confirmed');
  });
});
/**
 * #1301 meets #1281: the record a writer hands back goes straight into the
 * portal's cache, so a block-booked visit must carry its window's hours there
 * too, or it reads as a bare label until the refetch lands.
 */
describe('#1301 read-back carries a block visit\'s window', () => {
  it('readVisitDto and readEnvelopeDto return the label with the current hours', async () => {
    const { readVisitDto, readEnvelopeDto } = await import('../src/lib/portalBookingDto');
    const blockVisit = {
      status: 'requested', batchId: 'b1', timeBlockId: 'midday', timeBlockLabel: 'Midday',
      startTime: Timestamp.fromMillis(Date.now() + DAY),
    };
    const ctx = buildDbMock({
      docs: {
        'business_settings/business_settings': {
          allowTimeBlockBooking: true,
          timeBlocks: [{ id: 'midday', label: 'Midday', startTime: '11:00', endTime: '15:00' }],
        },
        'families/kf1/bookings/b1': { envelopeStatus: 'requested', pattern: 'individual' },
        'families/kf1/bookings/b1/kinCares/v1': blockVisit,
      },
      queryDocs: { 'families/kf1/bookings/b1/kinCares': [{ id: 'v1', data: blockVisit }] },
    });
    const visit = await readVisitDto(ctx.db as any, 'kf1', 'b1', 'v1');
    expect(visit).toMatchObject({ timeBlockLabel: 'Midday', timeBlockStartTime: '11:00', timeBlockEndTime: '15:00' });
    const env = await readEnvelopeDto(ctx.db as any, 'kf1', 'b1');
    expect(env?.kinCares[0]).toMatchObject({ timeBlockLabel: 'Midday', timeBlockStartTime: '11:00', timeBlockEndTime: '15:00' });
  });
  it('keeps the stored label with no hours when the window has been removed', async () => {
    const { readVisitDto } = await import('../src/lib/portalBookingDto');
    const ctx = buildDbMock({
      docs: {
        'business_settings/business_settings': { allowTimeBlockBooking: true, timeBlocks: [] },
        'families/kf1/bookings/b1/kinCares/v1': {
          status: 'requested', batchId: 'b1', timeBlockId: 'brunch', timeBlockLabel: 'Brunch',
          startTime: Timestamp.fromMillis(Date.now() + DAY),
        },
      },
    });
    const visit = await readVisitDto(ctx.db as any, 'kf1', 'b1', 'v1');
    expect(visit).toMatchObject({ timeBlockLabel: 'Brunch', timeBlockStartTime: null, timeBlockEndTime: null });
  });
});
