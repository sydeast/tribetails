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

const DAY = 86_400_000;

/**
 * DEFECT verification + fix: `requestBooking` (kinfolk-initiated) writes an
 * envelope with no check at all against Google Calendar busy imports today.
 * These pin the fix and, for the multi-visit case, prove the household
 * filter isn't needed here (the guard reads booking_time_slots directly, not
 * per-household), unlike the client-side picker.
 */
describe('requestBookingHandler busy-conflict guard', () => {
  it('multi-visit: rejects a visit landing on a GOOGLE_BUSY_IMPORT slot, naming the window, and writes nothing', async () => {
    const future = Date.now() + DAY;
    const futureIso = new Date(future).toISOString();
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] } },
      queryDocs: {
        booking_time_slots: [
          {
            id: 'gbi-1',
            data: {
              date: futureIso.slice(0, 10),
              startTime: futureIso.slice(11, 16),
              endTime: new Date(future + 3600_000).toISOString().slice(11, 16),
              source: 'GOOGLE_BUSY_IMPORT',
            },
          },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');

    await expect(
      requestBookingHandler({
        data: { kinfolkId: '3', visits: [{ startTimeMs: future + 60_000, serviceId: 'svc1', serviceName: 'Walk' }] },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toMatchObject({ code: 'failed-precondition' });

    expect(ctx.writes.filter((w) => w.path.includes('/kinCares/'))).toHaveLength(0);
    expect(ctx.writes.filter((w) => /^families\/3\/bookings\//.test(w.path))).toHaveLength(0);
  });

  it('legacy single-visit shape is checked too', async () => {
    const future = Date.now() + DAY;
    const futureIso = new Date(future).toISOString();
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] } },
      queryDocs: {
        booking_time_slots: [
          {
            id: 'gbi-1',
            data: {
              date: futureIso.slice(0, 10),
              startTime: futureIso.slice(11, 16),
              endTime: new Date(future + 3600_000).toISOString().slice(11, 16),
              source: 'GOOGLE_BUSY_IMPORT',
            },
          },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');

    await expect(
      requestBookingHandler({
        data: { kinfolkId: '3', serviceType: 'walk', startTimeMs: future + 60_000 },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('kinfolk cannot override: an overrideBusyConflict-shaped field on the payload is simply ignored (still refuses)', async () => {
    const future = Date.now() + DAY;
    const futureIso = new Date(future).toISOString();
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] } },
      queryDocs: {
        booking_time_slots: [
          {
            id: 'gbi-1',
            data: {
              date: futureIso.slice(0, 10),
              startTime: futureIso.slice(11, 16),
              endTime: new Date(future + 3600_000).toISOString().slice(11, 16),
              source: 'GOOGLE_BUSY_IMPORT',
            },
          },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');

    await expect(
      requestBookingHandler({
        data: {
          kinfolkId: '3',
          visits: [{ startTimeMs: future + 60_000, serviceId: 'svc1', serviceName: 'Walk' }],
          overrideBusyConflict: true,
        },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(mocks.writeAuditEntryFn).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'BOOKING_BUSY_CONFLICT_OVERRIDDEN' }),
    );
  });

  it('a visit on a day with no busy import at all still succeeds (non-conflicting passes unchanged)', async () => {
    const future = Date.now() + DAY;
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');

    const res: any = await requestBookingHandler({
      data: { kinfolkId: '3', visits: [{ startTimeMs: future, serviceId: 'svc1', serviceName: 'Walk' }] },
      auth: { uid: 'u1' },
    } as any);
    expect(res.batchId).toBeTypeOf('string');
    expect(ctx.writes.filter((w) => w.path.includes('/kinCares/'))).toHaveLength(1);
  });

  it('a busy import on an UNRELATED day does not block this booking', async () => {
    const future = Date.now() + DAY;
    const unrelatedDay = new Date(future + 30 * DAY).toISOString();
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['3'] } },
      queryDocs: {
        booking_time_slots: [
          {
            id: 'gbi-1',
            data: {
              date: unrelatedDay.slice(0, 10),
              startTime: '14:00',
              endTime: '15:00',
              source: 'GOOGLE_BUSY_IMPORT',
            },
          },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');

    const res: any = await requestBookingHandler({
      data: { kinfolkId: '3', visits: [{ startTimeMs: future, serviceId: 'svc1', serviceName: 'Walk' }] },
      auth: { uid: 'u1' },
    } as any);
    expect(res.batchId).toBeTypeOf('string');
  });
});
