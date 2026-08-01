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
 * C1: company holidays were stored (PR #150) but read by nothing. This pins
 * requestBooking's (kinfolk-initiated) new hard block, matching the
 * busy-conflict guard's existing coverage in requestBookingBusyConflict.test.ts.
 */
describe('requestBookingHandler company-holiday guard', () => {
  it('multi-visit: rejects a visit landing on a closed day, naming the date, and writes nothing', async () => {
    const closedIso = new Date(Date.now() + 10 * DAY).toISOString().slice(0, 10);
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'business_settings/business_settings': { companyHolidays: [`${closedIso}|Staff retreat`] },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');

    const startTimeMs = Date.parse(`${closedIso}T15:00:00.000Z`);
    await expect(
      requestBookingHandler({
        data: { kinfolkId: '3', visits: [{ startTimeMs, serviceId: 'svc1', serviceName: 'Walk' }] },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toMatchObject({ code: 'failed-precondition' });

    expect(ctx.writes.filter((w) => w.path.includes('/kinCares/'))).toHaveLength(0);
  });

  it('legacy single-visit shape is checked too', async () => {
    const closedIso = new Date(Date.now() + 10 * DAY).toISOString().slice(0, 10);
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'business_settings/business_settings': { companyHolidays: [`${closedIso}|Staff retreat`] },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');

    await expect(
      requestBookingHandler({
        data: { kinfolkId: '3', serviceType: 'walk', startTimeMs: Date.parse(`${closedIso}T15:00:00.000Z`) },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('a recurring yearly closure blocks a request in a future year, even though the entry has no year in it', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'business_settings/business_settings': { companyHolidays: ['yearly:12-25|Christmas'] },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');

    await expect(
      requestBookingHandler({
        data: { kinfolkId: '3', visits: [{ startTimeMs: Date.parse('2031-12-25T15:00:00.000Z'), serviceId: 's', serviceName: 'Walk' }] },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('an open day (not on any closure) still succeeds', async () => {
    const openMs = Date.now() + 10 * DAY;
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'business_settings/business_settings': { companyHolidays: ['2026-12-25|Christmas'] },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');

    const res: any = await requestBookingHandler({
      data: { kinfolkId: '3', visits: [{ startTimeMs: openMs, serviceId: 'svc1', serviceName: 'Walk' }] },
      auth: { uid: 'u1' },
    } as any);
    expect(res.batchId).toBeTypeOf('string');
    expect(ctx.writes.filter((w) => w.path.includes('/kinCares/'))).toHaveLength(1);
  });

  it('no companyHolidays configured at all never blocks a request', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');

    const res: any = await requestBookingHandler({
      data: { kinfolkId: '3', visits: [{ startTimeMs: Date.now() + DAY, serviceId: 'svc1', serviceName: 'Walk' }] },
      auth: { uid: 'u1' },
    } as any);
    expect(res.batchId).toBeTypeOf('string');
  });
});
