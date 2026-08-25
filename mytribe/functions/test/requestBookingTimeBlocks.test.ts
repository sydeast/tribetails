import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * Time-block booking, write side. Operator requirement 2026-08-24: "kinfolk
 * book within time blocks, not at a specific set time."
 *
 * The test this file exists for is the refusal: a client that sends an
 * arbitrary time while the business only allows block booking must be REFUSED,
 * not trusted — on both payload shapes the callable accepts, because a guard on
 * one branch of a two-branch handler is not a guard.
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

const DAY = 86_400_000;

/**
 * A UTC instant, tomorrow at `hour`. The fixtures below pin the business zone
 * to `UTC` so "11:00 in the business's zone" is a fixed number here rather than
 * whatever the machine running the suite happens to think 11:00 is.
 */
function atUtc(hour: number, minute = 0, dayOffset = 1): number {
  const d = new Date(Date.now() + dayOffset * DAY);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute, 0, 0);
}

const MIDDAY = { id: 'midday', label: 'Midday', startTime: '11:00', endTime: '15:00', active: true };
const EVENING = { id: 'evening', label: 'Evening', startTime: '17:00', endTime: '21:00', active: true };
const SERVICE_RATES = { '30Minute': '25', '60Minute': '45' };

function ctxWith(settings: Record<string, unknown>) {
  return buildDbMock({
    docs: {
      'clients/u1': { kinfolkIds: ['3'] },
      'business_settings/business_settings': {
        serviceRates: SERVICE_RATES,
        timeZone: 'UTC',
        ...settings,
      },
    },
  });
}

const BLOCK_ONLY = {
  allowTimeBlockBooking: true,
  allowSpecificTimeBooking: false,
  defaultBookingMode: 'TIME_BLOCK',
  timeBlocks: [MIDDAY, EVENING],
};
const BOTH_MODES = {
  allowTimeBlockBooking: true,
  allowSpecificTimeBooking: true,
  defaultBookingMode: 'TIME_BLOCK',
  timeBlocks: [MIDDAY, EVENING],
};

function visit(over: Record<string, unknown> = {}) {
  return {
    startTimeMs: atUtc(11),
    endTimeMs: null,
    serviceId: '30Minute',
    serviceName: '30 Minute',
    priceCents: 2500,
    timeBlockId: 'midday',
    ...over,
  };
}

function multi(visits: unknown[]) {
  return { data: { kinfolkId: '3', kinIds: ['k1'], pattern: 'individual', visits }, auth: { uid: 'u1' } } as any;
}

function visitsOf(ctx: ReturnType<typeof buildDbMock>, batchId: string) {
  return ctx.writes.filter((w) => w.path.startsWith(`families/3/bookings/${batchId}/kinCares/`));
}

describe('requestBookingHandler — time-block booking', () => {
  it('REFUSES an arbitrary time when the business only allows block booking', async () => {
    const ctx = ctxWith(BLOCK_ONLY);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    await expect(
      requestBookingHandler(multi([visit({ timeBlockId: undefined, startTimeMs: atUtc(9, 17) })])),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    // Nothing was written: the refusal happens before the envelope.
    expect(ctx.writes).toHaveLength(0);
  });

  it('REFUSES the legacy single-visit shape too, which can never carry a block', async () => {
    const ctx = ctxWith(BLOCK_ONLY);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    await expect(
      requestBookingHandler({
        data: { kinfolkId: '3', serviceType: 'walk', startTimeMs: atUtc(12) },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('refuses a block that does not exist', async () => {
    mocks.dbFn.mockReturnValue(ctxWith(BLOCK_ONLY).db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    await expect(requestBookingHandler(multi([visit({ timeBlockId: 'brunch' })])))
      .rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('refuses a block the operator deactivated, exactly as it refuses one that never existed', async () => {
    mocks.dbFn.mockReturnValue(
      ctxWith({ ...BLOCK_ONLY, timeBlocks: [MIDDAY, { ...EVENING, active: false }] }).db,
    );
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    await expect(requestBookingHandler(multi([visit({ timeBlockId: 'evening', startTimeMs: atUtc(18) })])))
      .rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('refuses a real block whose window does not contain the time that was sent', async () => {
    mocks.dbFn.mockReturnValue(ctxWith(BLOCK_ONLY).db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    // 09:00 UTC under the name of the 11:00-15:00 block: the exact "arbitrary
    // time wearing a block's name" attempt.
    await expect(requestBookingHandler(multi([visit({ startTimeMs: atUtc(9) })])))
      .rejects.toMatchObject({ code: 'invalid-argument' });
    // 15:00 is the closing minute and the window is end-exclusive.
    await expect(requestBookingHandler(multi([visit({ startTimeMs: atUtc(15) })])))
      .rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('refuses a block when the business has block booking switched off', async () => {
    mocks.dbFn.mockReturnValue(
      ctxWith({
        allowTimeBlockBooking: false,
        allowSpecificTimeBooking: true,
        timeBlocks: [MIDDAY],
      }).db,
    );
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    await expect(requestBookingHandler(multi([visit()]))).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('persists the chosen block on every visit, so the admin side sees the household’s answer', async () => {
    const ctx = ctxWith(BLOCK_ONLY);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const res: any = await requestBookingHandler(
      multi([visit(), visit({ serviceId: '60Minute', serviceName: '60 Minute', timeBlockId: 'evening', startTimeMs: atUtc(17) })]),
    );
    const written = visitsOf(ctx, res.batchId).map((w) => w.data);
    expect(written).toHaveLength(2);
    expect(written.map((v: any) => [v.timeBlockId, v.timeBlockLabel]).sort()).toEqual([
      ['evening', 'Evening'],
      ['midday', 'Midday'],
    ]);
  });

  it('prices a block-booked visit from the catalog, exactly as a clock-booked one', async () => {
    const ctx = ctxWith(BLOCK_ONLY);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    // The client lies about the price, as it always might; the catalog wins.
    const res: any = await requestBookingHandler(multi([visit({ priceCents: 1 })]));
    const written = visitsOf(ctx, res.batchId).map((w) => w.data);
    expect(written[0].priceCents).toBe(2500);
    expect(written[0].serviceName).toBe('30 Minute');
    expect(written[0].timeBlockId).toBe('midday');
  });

  it('accepts SEVERAL KinCares in the same block when their durations differ', async () => {
    const ctx = ctxWith(BLOCK_ONLY);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const res: any = await requestBookingHandler(
      multi([visit(), visit({ serviceId: '60Minute', serviceName: '60 Minute' })]),
    );
    // Both start at the block's first minute, which under the old
    // serviceId@startTimeMs rule would have looked like a duplicate.
    expect(visitsOf(ctx, res.batchId)).toHaveLength(2);
  });

  it('refuses the SAME KinCare in the SAME block twice, and says so in block words', async () => {
    mocks.dbFn.mockReturnValue(ctxWith(BLOCK_ONLY).db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    await expect(requestBookingHandler(multi([visit(), visit()]))).rejects.toMatchObject({
      code: 'invalid-argument',
      message: expect.stringContaining('same time block'),
    });
  });

  it('accepts the same KinCare in two DIFFERENT blocks on the same day', async () => {
    const ctx = ctxWith(BLOCK_ONLY);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const res: any = await requestBookingHandler(
      multi([visit(), visit({ timeBlockId: 'evening', startTimeMs: atUtc(17) })]),
    );
    expect(visitsOf(ctx, res.batchId)).toHaveLength(2);
  });

  it('still refuses the same KinCare at the same instant when booking by clock', async () => {
    mocks.dbFn.mockReturnValue(ctxWith(BOTH_MODES).db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const clockVisit = visit({ timeBlockId: undefined, startTimeMs: atUtc(9, 30) });
    await expect(requestBookingHandler(multi([clockVisit, { ...clockVisit }]))).rejects.toMatchObject({
      code: 'invalid-argument',
      message: expect.stringContaining('same time'),
    });
  });

  it('lets a clock-booked visit through when both modes are allowed, with a null block', async () => {
    const ctx = ctxWith(BOTH_MODES);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const res: any = await requestBookingHandler(multi([visit({ timeBlockId: undefined, startTimeMs: atUtc(9, 30) })]));
    const written = visitsOf(ctx, res.batchId).map((w) => w.data);
    expect(written[0].timeBlockId).toBeNull();
    expect(written[0].timeBlockLabel).toBeNull();
  });

  it('a business with only a legacy id-only block row still takes clock bookings', async () => {
    const ctx = ctxWith({
      allowTimeBlockBooking: true,
      allowSpecificTimeBooking: false,
      defaultBookingMode: 'TIME_BLOCK',
      // The row `auntieos-admin/src/api/settings.ts` warns throws on `.trim()`.
      timeBlocks: [{ id: 'midday' }],
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    // No usable block -> block booking degrades OFF and specific time comes
    // back on, so the household is not locked out by a bad settings row.
    const res: any = await requestBookingHandler(multi([visit({ timeBlockId: undefined, startTimeMs: atUtc(9, 30) })]));
    expect(visitsOf(ctx, res.batchId)).toHaveLength(1);
  });

  it('skips the window check, but not the block check, when the stored timezone is unusable', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'business_settings/business_settings': { serviceRates: SERVICE_RATES, timeZone: '', ...BLOCK_ONLY },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    // A time nowhere near the window is let through: we cannot tell, and a
    // wrong refusal costs a household a booking it was entitled to make.
    const res: any = await requestBookingHandler(multi([visit({ startTimeMs: atUtc(3) })]));
    expect(visitsOf(ctx, res.batchId)).toHaveLength(1);
    // The id is still checked, because that we can always answer.
    await expect(requestBookingHandler(multi([visit({ timeBlockId: 'brunch' })])))
      .rejects.toMatchObject({ code: 'invalid-argument' });
  });
});
