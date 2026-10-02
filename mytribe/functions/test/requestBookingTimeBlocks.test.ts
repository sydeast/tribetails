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

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), writeAuditEntryFn: vi.fn(), logEventFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__SERVER_TS__' } };
});

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.logEventFn.mockReset();
  mocks.writeAuditEntryFn.mockReset();
  mocks.writeAuditEntryFn.mockResolvedValue('audit-id');
});

/** Every `event` name the handler logged during a call, so a named line can be asserted. */
function loggedEvents(): string[] {
  return mocks.logEventFn.mock.calls.map((c) => (c[0] as { event: string }).event);
}

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

  /**
   * #597, the case that regressed. `duplicateVisitKey` keyed a block-mode visit
   * as (KinCare, block) with no date, and `buildVisits` loops dates x slots — so
   * a household picking Sep 4, Sep 5 and Sep 6 in the Midday block was told it
   * had asked for the same visit three times. That broke Pattern = Dates (#547)
   * and weekly recurring the moment block mode was on.
   */
  it('accepts the SAME KinCare in the SAME block on DIFFERENT DAYS', async () => {
    const ctx = ctxWith(BLOCK_ONLY);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const res: any = await requestBookingHandler(
      multi([
        visit({ startTimeMs: atUtc(11, 0, 1) }),
        visit({ startTimeMs: atUtc(11, 0, 2) }),
        visit({ startTimeMs: atUtc(11, 0, 3) }),
      ]),
    );
    expect(visitsOf(ctx, res.batchId)).toHaveLength(3);
  });

  it('still refuses the same KinCare in the same block on ONE day, with the multi-day rule in force', async () => {
    mocks.dbFn.mockReturnValue(ctxWith(BLOCK_ONLY).db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    // Three good days plus a repeat of the first: the repeat is the only thing
    // wrong, and it is still refused.
    await expect(
      requestBookingHandler(
        multi([
          visit({ startTimeMs: atUtc(11, 0, 1) }),
          visit({ startTimeMs: atUtc(11, 0, 2) }),
          visit({ startTimeMs: atUtc(11, 0, 1) }),
        ]),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument', message: expect.stringContaining('same time block') });
  });

  it('keys the duplicate rule on the BUSINESS day, so a stray space cannot walk one past it', async () => {
    mocks.dbFn.mockReturnValue(ctxWith(BLOCK_ONLY).db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    await expect(
      requestBookingHandler(multi([visit(), visit({ timeBlockId: ' midday ' })])),
    ).rejects.toMatchObject({ code: 'invalid-argument', message: expect.stringContaining('same time block') });
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

  /**
   * #596: `formatHHmm` emitted "24:00" for a block ending at midnight and
   * `parseHHmm` rejected it, so `visitMatchesBlock` answered `zone-unusable` —
   * and `assertVisitBookingMode` refuses only on 'outside'. For any such block
   * the guarantee "a client cannot send an arbitrary time under a block's name"
   * was not enforced at all. Both fixtures below produce the 24:00 end: one from
   * the 4-hour default, one typed outright.
   */
  describe('a block that runs to the end of the day', () => {
    const LATE_DEFAULTED = { id: 'evening', label: 'Evening', startTime: '20:00', active: true };
    const LATE_EXPLICIT = { id: 'evening', label: 'Evening', startTime: '20:00', endTime: '24:00', active: true };

    for (const [name, row] of [['defaulted end', LATE_DEFAULTED], ['explicit 24:00 end', LATE_EXPLICIT]] as const) {
      it(`refuses an arbitrary time under its name (${name})`, async () => {
        const ctx = ctxWith({ ...BLOCK_ONLY, timeBlocks: [row] });
        mocks.dbFn.mockReturnValue(ctx.db);
        const { requestBookingHandler } = await import('../src/portal/requestBooking');
        // 12:00 UTC wearing the 20:00-24:00 block's name: the exact attempt the
        // shipped code accepted.
        await expect(
          requestBookingHandler(multi([visit({ timeBlockId: 'evening', startTimeMs: atUtc(12) })])),
        ).rejects.toMatchObject({ code: 'invalid-argument' });
        expect(ctx.writes).toHaveLength(0);
      });

      it(`still accepts a time genuinely inside it (${name})`, async () => {
        const ctx = ctxWith({ ...BLOCK_ONLY, timeBlocks: [row] });
        mocks.dbFn.mockReturnValue(ctx.db);
        const { requestBookingHandler } = await import('../src/portal/requestBooking');
        const res: any = await requestBookingHandler(
          multi([visit({ timeBlockId: 'evening', startTimeMs: atUtc(23, 59) })]),
        );
        expect(visitsOf(ctx, res.batchId)).toHaveLength(1);
      });
    }
  });

  /**
   * #596, the wider half. Fail-open on an unreadable zone is deliberate and
   * stays — but it must not be silent, because it means rule 4 is not running
   * for ANY block in the business.
   */
  it('logs a named line when a blank timezone leaves containment inert', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'business_settings/business_settings': { serviceRates: SERVICE_RATES, timeZone: '', ...BLOCK_ONLY },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    await requestBookingHandler(multi([visit({ startTimeMs: atUtc(3) })]));
    expect(loggedEvents()).toContain('timeblock.containment.inert');
    expect(mocks.logEventFn.mock.calls.map((c) => c[0]).find((f: any) => f.event === 'timeblock.containment.inert'))
      .toMatchObject({ severity: 'error' });
  });

  it('says nothing about inert containment when the timezone is usable', async () => {
    mocks.dbFn.mockReturnValue(ctxWith(BLOCK_ONLY).db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    await requestBookingHandler(multi([visit()]));
    expect(loggedEvents()).not.toContain('timeblock.containment.inert');
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

/**
 * #1092 / #1098: a KinCare the operator set to "book at a start time". An
 * overnight is twelve consecutive hours, which no time block can hold, so it is
 * the one KinCare exempt from block-only booking.
 *
 * #1098 moved WHO picks the start. The household asks for a NIGHT (a date); the
 * operator sets the start when approving, because they finish other evening
 * visits first. So the request stores the visit as awaiting a start time, and a
 * stale client that still sends a clock time has that time discarded.
 */
describe('requestBookingHandler: KinCares that book at a start time (#1092, #1098)', () => {
  const OVERNIGHT_SETTINGS = {
    ...BLOCK_ONLY,
    serviceRates: { ...SERVICE_RATES, Overnight: '120' },
    serviceDurations: { Overnight: '720' },
    serviceStartTimeBooking: { Overnight: true },
  };

  /** The UTC (= business, the fixtures pin `timeZone: 'UTC'`) calendar date `dayOffset` days from now. */
  const dateIn = (dayOffset: number) => new Date(Date.now() + dayOffset * DAY).toISOString().slice(0, 10);
  /** A night, as the #1098 client sends it: a date and no time. */
  const night = (over: Record<string, unknown> = {}) => ({
    serviceId: 'Overnight',
    serviceName: 'Overnight',
    priceCents: 12000,
    date: dateIn(1),
    ...over,
  });

  it('stores a night as awaiting a start time: no time, no block, the requested date kept', async () => {
    const ctx = ctxWith(OVERNIGHT_SETTINGS);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const res: any = await requestBookingHandler(multi([night()]));
    const written = visitsOf(ctx, res.batchId).map((w) => w.data);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      startTime: null,
      endTime: null,
      startTimePending: true,
      requestedDate: dateIn(1),
      timeBlockId: null,
      timeBlockLabel: null,
      status: 'requested',
    });
  });

  it('rolls the envelope up with null instants when every visit awaits a start time', async () => {
    const ctx = ctxWith(OVERNIGHT_SETTINGS);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const res: any = await requestBookingHandler(multi([night()]));
    const envelope = ctx.writes.find((w) => w.path === `families/3/bookings/${res.batchId}`)?.data;
    expect(envelope?.firstStartTime).toBeNull();
    expect(envelope?.lastStartTime).toBeNull();
    expect(envelope?.visitCount).toBe(1);
  });

  it('a stale client that sends a clock time gets the business date of it, and the time is DISCARDED', async () => {
    const ctx = ctxWith(OVERNIGHT_SETTINGS);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const stale = { ...night(), date: undefined, startTimeMs: atUtc(21), endTimeMs: null };
    const res: any = await requestBookingHandler(multi([stale]));
    const [written]: any[] = visitsOf(ctx, res.batchId).map((w) => w.data);
    expect(written.startTimePending).toBe(true);
    expect(written.requestedDate).toBe(new Date(atUtc(21)).toISOString().slice(0, 10));
    expect(written.startTime).toBeNull();
    expect(written.endTime).toBeNull();
  });

  it('derives the stale client date in the BUSINESS zone, not UTC', async () => {
    // 01:30 UTC tomorrow is still the evening BEFORE in New York.
    const ctx = ctxWith({ ...OVERNIGHT_SETTINGS, timeZone: 'America/New_York' });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const startTimeMs = atUtc(1, 30, 2);
    const res: any = await requestBookingHandler(multi([{ ...night(), date: undefined, startTimeMs }]));
    const [written]: any[] = visitsOf(ctx, res.batchId).map((w) => w.data);
    expect(written.requestedDate).toBe(new Date(startTimeMs - DAY).toISOString().slice(0, 10));
  });

  it('REFUSES a flagged visit that sends neither a date nor a time', async () => {
    const ctx = ctxWith(OVERNIGHT_SETTINGS);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    await expect(requestBookingHandler(multi([{ ...night(), date: undefined }])))
      .rejects.toMatchObject({ code: 'invalid-argument' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('REFUSES any other KinCare that sends no start time, even with a date', async () => {
    const ctx = ctxWith(OVERNIGHT_SETTINGS);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    await expect(
      requestBookingHandler(multi([{ ...visit(), startTimeMs: undefined, date: dateIn(1) }])),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('REFUSES a night already past in the business zone, and accepts tonight', async () => {
    const ctx = ctxWith(OVERNIGHT_SETTINGS);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    await expect(requestBookingHandler(multi([night({ date: dateIn(-1) })])))
      .rejects.toMatchObject({ code: 'invalid-argument' });
    const res: any = await requestBookingHandler(multi([night({ date: dateIn(0) })]));
    const [written]: any[] = visitsOf(ctx, res.batchId).map((w) => w.data);
    expect(written.requestedDate).toBe(dateIn(0));
  });

  it('REFUSES a date that is shaped right but does not exist', async () => {
    const ctx = ctxWith(OVERNIGHT_SETTINGS);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    await expect(requestBookingHandler(multi([night({ date: '2099-02-31' })])))
      .rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('REFUSES the same overnight on the same night twice, and takes two nights', async () => {
    const ctx = ctxWith(OVERNIGHT_SETTINGS);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const err: any = await requestBookingHandler(multi([night(), night()])).catch((e) => e);
    expect(err.code).toBe('invalid-argument');
    expect(err.message).toMatch(/same night/i);
    expect(ctx.writes).toHaveLength(0);
    const res: any = await requestBookingHandler(multi([night(), night({ date: dateIn(2) })]));
    const written = visitsOf(ctx, res.batchId).map((w) => w.data.requestedDate).sort();
    expect(written).toEqual([dateIn(1), dateIn(2)]);
  });

  it('a stale clock-time copy of a dated night is still the same night', async () => {
    const ctx = ctxWith(OVERNIGHT_SETTINGS);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    await expect(
      requestBookingHandler(multi([night(), { ...night(), date: undefined, startTimeMs: atUtc(21) }])),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('books a night next to a Midday block visit in one plan; only the night awaits a time', async () => {
    const ctx = ctxWith(OVERNIGHT_SETTINGS);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const res: any = await requestBookingHandler(multi([visit(), night()]));
    const written = visitsOf(ctx, res.batchId).map((w) => w.data);
    const block: any = written.find((v: any) => v.timeBlockId === 'midday');
    const pending: any = written.find((v: any) => v.serviceId === 'Overnight');
    expect(block).toMatchObject({ startTimePending: false, requestedDate: null });
    expect(block.startTime.toMillis()).toBe(atUtc(11));
    expect(pending).toMatchObject({ startTimePending: true, startTime: null, timeBlockId: null });
    // The envelope's instant rollups come from the visit that has an instant.
    const envelope: any = ctx.writes.find((w) => w.path === `families/3/bookings/${res.batchId}`)?.data;
    expect(envelope.firstStartTime.toMillis()).toBe(atUtc(11));
    expect(envelope.lastStartTime.toMillis()).toBe(atUtc(11));
  });

  it('ignores a block named on a night: the operator sets the time, not a block', async () => {
    const ctx = ctxWith(OVERNIGHT_SETTINGS);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const res: any = await requestBookingHandler(multi([night({ timeBlockId: 'evening' })]));
    const [written]: any[] = visitsOf(ctx, res.batchId).map((w) => w.data);
    expect(written).toMatchObject({ startTimePending: true, timeBlockId: null, timeBlockLabel: null });
  });

  it('still REFUSES every other KinCare at a clock time in the same business', async () => {
    const ctx = ctxWith(OVERNIGHT_SETTINGS);
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    await expect(
      requestBookingHandler(multi([night(), visit({ timeBlockId: undefined, startTimeMs: atUtc(9, 30) })])),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(ctx.writes).toHaveLength(0);
  });
  it('ignores a flag that is not exactly true', async () => {
    const ctx = ctxWith({ ...OVERNIGHT_SETTINGS, serviceStartTimeBooking: { Overnight: 'yes' } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    await expect(requestBookingHandler(multi([night()]))).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('does NOT run the busy guard on a night: there is no time to check until the operator sets one', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'business_settings/business_settings': { timeZone: 'UTC', ...OVERNIGHT_SETTINGS },
      },
      queryDocs: {
        booking_time_slots: [
          { id: 'gbi-late', data: { date: dateIn(1), startTime: '23:00', endTime: '23:30', source: 'GOOGLE_BUSY_IMPORT' } },
          { id: 'gbi-all', data: { date: dateIn(1), startTime: '00:00', endTime: '23:59', source: 'GOOGLE_BUSY_IMPORT' } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const res: any = await requestBookingHandler(multi([night()]));
    expect(visitsOf(ctx, res.batchId)).toHaveLength(1);
  });

  it('REFUSES a night that falls on a company holiday, by its requested date', async () => {
    const ctx = ctxWith({ ...OVERNIGHT_SETTINGS, companyHolidays: [`${dateIn(3)}|Staff retreat`] });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const err: any = await requestBookingHandler(multi([night({ date: dateIn(3) })])).catch((e) => e);
    expect(err.code).toBe('failed-precondition');
    expect(err.message).toContain(dateIn(3));
    expect(ctx.writes.filter((w) => w.path.includes('/kinCares/'))).toHaveLength(0);
  });
});
