import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), writeAuditEntryFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__SERVER_TS__' } };
});

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.writeAuditEntryFn.mockReset();
  mocks.writeAuditEntryFn.mockResolvedValue('audit-id');
});

/**
 * #1093: the portal sends every visit with `endTimeMs: null`, so the busy guard
 * saw a 1 ms point at the start and the holiday guard saw the start's UTC date.
 * These pin the whole visit being checked, on the business's own calendar.
 *
 * Dates are January 2031: safely in the future, and Los Angeles is a fixed
 * UTC-8 then, so every instant below reads unambiguously.
 */
const LA = 'America/Los_Angeles';

/** A Google busy import, stored the way `syncGoogleCalendarBusyEvents` stores it (UTC strings). */
function busySlot(id: string, date: string, startTime: string, endTime: string) {
  return { id, data: { date, startTime, endTime, source: 'GOOGLE_BUSY_IMPORT' } };
}

const multi = (visits: unknown[]) =>
  ({ data: { kinfolkId: '3', kinIds: ['k1'], visits }, auth: { uid: 'u1' } }) as any;

function kinCareWrites(ctx: { writes: Array<{ path: string; data: any }> }) {
  return ctx.writes.filter((w) => /^families\/3\/bookings\/[^/]+\/kinCares\//.test(w.path));
}

describe('requestBooking checks the whole visit (#1093)', () => {
  it('a 10:00 two-hour visit is refused by an 11:00 busy block, and nothing is written', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'business_settings/business_settings': { serviceDurations: { '2Hrs': '120' } },
      },
      queryDocs: { booking_time_slots: [busySlot('gbi-1', '2031-01-14', '11:00', '12:00')] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');

    await expect(
      requestBookingHandler(
        multi([{ startTimeMs: Date.parse('2031-01-14T10:00:00.000Z'), endTimeMs: null, serviceId: '2Hrs', serviceName: '2 Hrs' }]),
      ),
    ).rejects.toMatchObject({ code: 'failed-precondition', details: { code: 'booking_busy_conflict' } });
    expect(kinCareWrites(ctx)).toHaveLength(0);
  });

  it('the same visit clear of the block is booked, and stored with the end its KinCare length gives it', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'business_settings/business_settings': { serviceDurations: { '2Hrs': '120' } },
      },
      queryDocs: { booking_time_slots: [busySlot('gbi-1', '2031-01-14', '12:00', '13:00')] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');

    await requestBookingHandler(
      multi([{ startTimeMs: Date.parse('2031-01-14T10:00:00.000Z'), endTimeMs: null, serviceId: '2Hrs', serviceName: '2 Hrs' }]),
    );
    const [child] = kinCareWrites(ctx);
    expect(child?.data.endTime?.toMillis()).toBe(Date.parse('2031-01-14T12:00:00.000Z'));
  });

  it('a client-sent end shorter than the KinCare cannot shrink the window under a busy block', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'business_settings/business_settings': { serviceDurations: { '2Hrs': '120' } },
      },
      queryDocs: { booking_time_slots: [busySlot('gbi-1', '2031-01-14', '11:00', '12:00')] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');

    await expect(
      requestBookingHandler(
        multi([
          {
            startTimeMs: Date.parse('2031-01-14T10:00:00.000Z'),
            endTimeMs: Date.parse('2031-01-14T10:30:00.000Z'),
            serviceId: '2Hrs',
            serviceName: '2 Hrs',
          },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('an evening visit in a US zone is checked against its business date, not the next UTC day', async () => {
    // 21:00 in Los Angeles on Jan 14 is 05:00 UTC on Jan 15.
    const start = Date.parse('2031-01-14T21:00:00.000-08:00');
    const settings = (companyHolidays: string[]) => ({
      timeZone: LA,
      serviceDurations: { '1Hr': '60' },
      companyHolidays,
    });

    const closedOnItsDay = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] }, 'business_settings/business_settings': settings(['2031-01-14|Closed']) },
    });
    mocks.dbFn.mockReturnValue(closedOnItsDay.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    await expect(
      requestBookingHandler(multi([{ startTimeMs: start, endTimeMs: null, serviceId: '1Hr', serviceName: '1 Hr' }])),
    ).rejects.toMatchObject({ code: 'failed-precondition', message: expect.stringContaining('2031-01-14') });

    // The UTC day it used to be checked against is closed, but the business's day is open.
    const closedOnUtcDay = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] }, 'business_settings/business_settings': settings(['2031-01-15|Closed']) },
    });
    mocks.dbFn.mockReturnValue(closedOnUtcDay.db);
    await requestBookingHandler(multi([{ startTimeMs: start, endTimeMs: null, serviceId: '1Hr', serviceName: '1 Hr' }]));
    expect(kinCareWrites(closedOnUtcDay)).toHaveLength(1);
  });

  it('a 21:00 overnight booked by clock is refused when the morning it runs into is closed', async () => {
    // A business on UTC, so the start's own date is Jan 14 on every reading:
    // only the twelve hours after it reach the closed Jan 15.
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'business_settings/business_settings': {
          timeZone: 'UTC',
          serviceDurations: { Overnight: '720' },
          companyHolidays: ['2031-01-15|Closed'],
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');

    await expect(
      requestBookingHandler(
        multi([
          { startTimeMs: Date.parse('2031-01-14T21:00:00.000Z'), endTimeMs: null, serviceId: 'Overnight', serviceName: 'Overnight' },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'failed-precondition', message: expect.stringContaining('2031-01-15') });
    expect(kinCareWrites(ctx)).toHaveLength(0);
  });

  it('an overnight awaiting its start time is stored exactly as #1098 left it: no time, no end, checked by its night only', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'business_settings/business_settings': {
          timeZone: LA,
          serviceDurations: { Overnight: '720' },
          serviceStartTimeBooking: { Overnight: true },
          // The morning after is closed. The night has no time yet, so the
          // operator answers that when they set one on approval.
          companyHolidays: ['2031-01-15|Closed'],
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');

    await requestBookingHandler(multi([{ date: '2031-01-14', serviceId: 'Overnight', serviceName: 'Overnight' }]));
    const [child] = kinCareWrites(ctx);
    expect(child?.data).toMatchObject({
      startTime: null,
      endTime: null,
      startTimePending: true,
      requestedDate: '2031-01-14',
    });
  });
});

describe('approveBookingSeriesCore re-checks the same whole-visit windows (#1093)', () => {
  it('a stored visit with no end gets its KinCare length: refused by a later-hour busy block, and its sibling session is stored with a real end', async () => {
    const ctx = buildDbMock({
      docs: {
        'families/3/bookings/b1': { kinfolkName: 'Doe Household' },
        'business_settings/business_settings': { serviceDurations: { '2Hrs': '120' } },
      },
      queryDocs: {
        'families/3/bookings/b1/kinCares': [
          { id: 'v1', data: { startTime: '2031-01-14T10:00:00.000Z', endTime: null, serviceId: '2Hrs', kinIds: ['k1'], serviceType: '2 Hrs' } },
          { id: 'v2', data: { startTime: '2031-01-16T10:00:00.000Z', endTime: null, serviceId: '2Hrs', kinIds: ['k1'], serviceType: '2 Hrs' } },
        ],
        booking_time_slots: [busySlot('gbi-1', '2031-01-14', '11:00', '12:00')],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { approveBookingSeriesCore } = await import('../src/admin/approveBookingSeriesCore');

    const r = await approveBookingSeriesCore({ kinfolkId: '3', batchId: 'b1', actorUid: 'sys', actorRole: 'SYSTEM' });

    expect(r.failedVisits).toBe(1);
    expect(ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_v1')).toBeUndefined();
    const s2 = ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_v2');
    expect(s2?.data).toMatchObject({ endTime: '2031-01-16T12:00:00.000Z', serviceDurationMinutes: 120 });
  });

  it('an evening visit is re-checked against its business date, not the next UTC day', async () => {
    const ctx = buildDbMock({
      docs: {
        'families/3/bookings/b1': { kinfolkName: 'Doe Household' },
        'business_settings/business_settings': { timeZone: LA, companyHolidays: ['2031-01-14|Closed'] },
      },
      queryDocs: {
        'families/3/bookings/b1/kinCares': [
          // 21:00 to 22:00 in Los Angeles on Jan 14; both instants are Jan 15 in UTC.
          { id: 'v1', data: { startTime: '2031-01-15T05:00:00.000Z', endTime: '2031-01-15T06:00:00.000Z', kinIds: ['k1'], serviceType: 'walk' } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { approveBookingSeriesCore } = await import('../src/admin/approveBookingSeriesCore');

    const r = await approveBookingSeriesCore({ kinfolkId: '3', batchId: 'b1', actorUid: 'sys', actorRole: 'SYSTEM' });
    expect(r.failedVisits).toBe(1);
    expect(ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_v1')).toBeUndefined();
  });
});
