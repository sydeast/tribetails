import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #541 / #543 / #546, server side.
 *
 * A booking day may now carry several KinCares — two different durations
 * (#541), or the same duration twice at two times (#543) — so this pins what
 * the callable does with a richer visit list: it accepts it, it refuses the one
 * case that is not two visits at all (the exact duplicate), it bounds the batch,
 * and it prices every visit from the catalog the wizard quoted from (#546).
 */

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

/** Tomorrow, so no visit trips the past-start rejection. */
const DAY = 86_400_000;
function at(hour: number, dayOffset = 1): number {
  const d = new Date(Date.now() + dayOffset * DAY);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

/**
 * The real catalog shape: AuntieOS's "KinCare types" live in
 * `business_settings.serviceRates` as name -> dollars-as-string, and that is
 * what `getServiceCatalog` builds the wizard's duration cards from.
 */
const SERVICE_RATES = { '30Minute': '25', '60Minute': '45' };

function ctxWithRates() {
  return buildDbMock({
    docs: {
      'clients/u1': { kinfolkIds: ['3'] },
      'business_settings/business_settings': { serviceRates: SERVICE_RATES },
    },
  });
}

function visitsOf(ctx: ReturnType<typeof buildDbMock>, batchId: string) {
  return ctx.writes.filter((w) => w.path.startsWith(`families/3/bookings/${batchId}/kinCares/`));
}

describe('requestBookingHandler — several KinCares in one booking', () => {
  /** #543: two of the SAME duration on one day, an hour apart. */
  it('writes two visits for one day when the same duration is asked for at two times', async () => {
    const ctx = ctxWithRates();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const res: any = await requestBookingHandler({
      data: {
        kinfolkId: '3',
        kinIds: ['k1'],
        pattern: 'individual',
        visits: [
          { startTimeMs: at(9), endTimeMs: null, serviceId: '30Minute', serviceName: '30 Minute', priceCents: 2500 },
          { startTimeMs: at(17), endTimeMs: null, serviceId: '30Minute', serviceName: '30 Minute', priceCents: 2500 },
        ],
      },
      auth: { uid: 'u1' },
    } as any);

    const visits = visitsOf(ctx, res.batchId);
    expect(visits).toHaveLength(2);
    expect(visits.map((v) => v.data?.serviceId)).toEqual(['30Minute', '30Minute']);
    const envelope = ctx.writes.find((w) => w.path === `families/3/bookings/${res.batchId}`);
    expect(envelope?.data?.visitCount).toBe(2);
    // One duration throughout, so the envelope's rollup still names it.
    expect(envelope?.data?.serviceId).toBe('30Minute');
  });

  /** #541: two DIFFERENT durations. The envelope rollup has no single answer and says so. */
  it('accepts two different durations and rolls the envelope service up to null', async () => {
    const ctx = ctxWithRates();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const res: any = await requestBookingHandler({
      data: {
        kinfolkId: '3',
        kinIds: ['k1'],
        pattern: 'individual',
        visits: [
          { startTimeMs: at(9), endTimeMs: null, serviceId: '30Minute', serviceName: '30 Minute', priceCents: 2500 },
          { startTimeMs: at(17), endTimeMs: null, serviceId: '60Minute', serviceName: '60 Minute', priceCents: 4500 },
        ],
      },
      auth: { uid: 'u1' },
    } as any);

    const visits = visitsOf(ctx, res.batchId);
    expect(visits.map((v) => v.data?.serviceName)).toEqual(['30 Minute', '60 Minute']);
    const envelope = ctx.writes.find((w) => w.path === `families/3/bookings/${res.batchId}`);
    expect(envelope?.data?.serviceId).toBeNull();
    expect(envelope?.data?.serviceName).toBeNull();
  });

  /**
   * The one case that is not two visits: the same duration at the same instant
   * is one KinCare asked for twice, and would put two indistinguishable
   * `kinCares` docs in front of an Auntie.
   */
  it('refuses the same duration at the same time, and writes nothing', async () => {
    const ctx = ctxWithRates();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const same = at(9);
    await expect(
      requestBookingHandler({
        data: {
          kinfolkId: '3',
          kinIds: ['k1'],
          pattern: 'individual',
          visits: [
            { startTimeMs: same, endTimeMs: null, serviceId: '30Minute', serviceName: '30 Minute', priceCents: 2500 },
            { startTimeMs: same, endTimeMs: null, serviceId: '30Minute', serviceName: '30 Minute', priceCents: 2500 },
          ],
        },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toThrow(/same duration at the same time/);
    expect(ctx.writes).toHaveLength(0);
  });

  /** Two DIFFERENT durations at the same instant are a scheduling question for the office, not a refusal. */
  it('does not refuse two different durations that happen to share a start time', async () => {
    const ctx = ctxWithRates();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const same = at(9);
    const res: any = await requestBookingHandler({
      data: {
        kinfolkId: '3',
        kinIds: ['k1'],
        pattern: 'individual',
        visits: [
          { startTimeMs: same, endTimeMs: null, serviceId: '30Minute', serviceName: '30 Minute', priceCents: 2500 },
          { startTimeMs: same, endTimeMs: null, serviceId: '60Minute', serviceName: '60 Minute', priceCents: 4500 },
        ],
      },
      auth: { uid: 'u1' },
    } as any);
    expect(visitsOf(ctx, res.batchId)).toHaveLength(2);
  });

  it('bounds one request at MAX_VISITS_PER_REQUEST rather than handing Firestore an oversized transaction', async () => {
    const ctx = ctxWithRates();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler, MAX_VISITS_PER_REQUEST } = await import('../src/portal/requestBooking');
    const visits = Array.from({ length: MAX_VISITS_PER_REQUEST + 1 }, (_, i) => ({
      startTimeMs: at(9) + i * 60_000,
      endTimeMs: null,
      serviceId: '30Minute',
      serviceName: '30 Minute',
      priceCents: 2500,
    }));
    await expect(
      requestBookingHandler({
        data: { kinfolkId: '3', kinIds: ['k1'], pattern: 'individual', visits },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toThrow(new RegExp(`at most ${MAX_VISITS_PER_REQUEST} visits`));
    expect(ctx.writes).toHaveLength(0);
  });
});

/**
 * #546, server half. The wizard's estimate is only honest if the price it
 * quotes is the price the visit is written with. `getServiceCatalog` resolves
 * `serviceRates` FIRST and this business's whole catalog lives there, but
 * `resolveService` only ever read `base_services` — so every booking made from
 * the real catalog persisted `priceCents: null`.
 */
describe('requestBookingHandler — catalog price resolution', () => {
  it('prices a visit from business_settings.serviceRates, which is where the real catalog lives', async () => {
    const ctx = ctxWithRates();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const res: any = await requestBookingHandler({
      data: {
        kinfolkId: '3',
        kinIds: ['k1'],
        pattern: 'individual',
        // The client's own price is deliberately a lie; the catalog must win.
        visits: [{ startTimeMs: at(9), endTimeMs: null, serviceId: '30Minute', serviceName: 'whatever', priceCents: 0 }],
      },
      auth: { uid: 'u1' },
    } as any);

    const visit = visitsOf(ctx, res.batchId)[0];
    expect(visit?.data?.priceCents).toBe(2500);
    expect(visit?.data?.serviceName).toBe('30 Minute');
  });

  it('prices each of a multi-KinCare day from its own catalog entry', async () => {
    const ctx = ctxWithRates();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const res: any = await requestBookingHandler({
      data: {
        kinfolkId: '3',
        kinIds: ['k1'],
        pattern: 'individual',
        visits: [
          { startTimeMs: at(9), endTimeMs: null, serviceId: '30Minute', serviceName: '30 Minute', priceCents: null },
          { startTimeMs: at(17), endTimeMs: null, serviceId: '60Minute', serviceName: '60 Minute', priceCents: null },
        ],
      },
      auth: { uid: 'u1' },
    } as any);
    // $25.00 + $45.00 — the same $70.00 the wizard's estimate showed.
    expect(visitsOf(ctx, res.batchId).map((v) => v.data?.priceCents)).toEqual([2500, 4500]);
  });

  it('still falls back to the base_services document when the rates map does not carry the id', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'business_settings/business_settings': { serviceRates: SERVICE_RATES },
        'base_services/legacy1': { name: "Auntie's In", priceCents: 1500 },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const res: any = await requestBookingHandler({
      data: {
        kinfolkId: '3',
        kinIds: ['k1'],
        pattern: 'individual',
        visits: [{ startTimeMs: at(9), endTimeMs: null, serviceId: 'legacy1', serviceName: 'client label', priceCents: 99 }],
      },
      auth: { uid: 'u1' },
    } as any);
    const visit = visitsOf(ctx, res.batchId)[0];
    expect(visit?.data?.priceCents).toBe(1500);
    expect(visit?.data?.serviceName).toBe("Auntie's In");
  });

  it('persists no price at all for a serviceId in neither source, rather than trusting the client', async () => {
    const ctx = ctxWithRates();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const res: any = await requestBookingHandler({
      data: {
        kinfolkId: '3',
        kinIds: ['k1'],
        pattern: 'individual',
        visits: [{ startTimeMs: at(9), endTimeMs: null, serviceId: 'ghost', serviceName: 'Ghost', priceCents: 999_999 }],
      },
      auth: { uid: 'u1' },
    } as any);
    const visit = visitsOf(ctx, res.batchId)[0];
    expect(visit?.data?.priceCents).toBeNull();
    expect(visit?.data?.serviceName).toBe('Ghost');
  });
});

describe('duplicateVisitKey', () => {
  it('names the repeated (duration, start) pair and is null otherwise', async () => {
    const { duplicateVisitKey } = await import('../src/portal/requestBooking');
    expect(duplicateVisitKey([{ startTimeMs: 1, serviceId: 'a' }, { startTimeMs: 2, serviceId: 'a' }])).toBeNull();
    expect(duplicateVisitKey([{ startTimeMs: 1, serviceId: 'a' }, { startTimeMs: 1, serviceId: 'b' }])).toBeNull();
    expect(duplicateVisitKey([{ startTimeMs: 1, serviceId: 'a' }, { startTimeMs: 1, serviceId: 'a' }])).toBe('a@1');
    expect(duplicateVisitKey([])).toBeNull();
  });
});
