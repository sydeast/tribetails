import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { callableRequest } from './_helpers/callableRequest';
import { zonedNow } from '../src/lib/businessHours';

/**
 * #1382: a NEW booking is judged by the same weekly business hours a
 * reschedule is (#1284), with the same sentences. Mirrors
 * requestBookingRescheduleRules.test.ts for requestBooking.
 */
const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), writeAuditEntryFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('firebase-admin/firestore');
  return {
    ...actual,
    FieldValue: { serverTimestamp: () => '__SERVER_TS__' },
    Timestamp: { fromMillis: (ms: number) => ({ __ms: ms, toMillis: () => ms }) },
  };
});

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.writeAuditEntryFn.mockReset();
  mocks.writeAuditEntryFn.mockResolvedValue('audit-id');
});

const SETTINGS = 'business_settings/business_settings';
const ZONE = 'America/Chicago';
const HALF_HOUR = 30 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

/** The first instant at least three days out that reads as `dayName` `hhmm` on the Chicago wall clock. */
function chicago(dayName: string, hhmm: string, minDaysOut = 3): number {
  const first = Math.ceil((Date.now() + minDaysOut * DAY) / HALF_HOUR) * HALF_HOUR;
  for (let t = first; t < first + 14 * DAY; t += HALF_HOUR) {
    const z = zonedNow(t, ZONE);
    if (z?.dayName === dayName && z.timeHHmm === hhmm) return t;
  }
  throw new Error(`no ${dayName} ${hhmm} found`);
}

const HOURS = {
  Monday: '09:00-17:00',
  Tuesday: '09:00-17:00',
  Wednesday: '09:00-17:00',
  Thursday: '09:00-17:00',
  Friday: '09:00-17:00',
  Saturday: '10:00-14:00',
  Sunday: '',
};

function ctxWith(settings: Record<string, unknown> | null) {
  const docs: Record<string, Record<string, unknown>> = { 'clients/u1': { kinfolkIds: ['f1'] } };
  if (settings) docs[SETTINGS] = settings;
  const ctx = buildDbMock({ docs });
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}

const kinCareWrites = (ctx: ReturnType<typeof ctxWith>) => ctx.writes.filter((w) => w.path.includes('/kinCares/'));

async function book(visits: Array<Record<string, unknown>>) {
  const { requestBookingHandler } = await import('../src/portal/requestBooking');
  return requestBookingHandler(
    callableRequest(
      { kinfolkId: 'f1', visits: visits.map((v) => ({ serviceId: 'svc1', serviceName: 'Walk', ...v })) },
      { uid: 'u1' },
    ),
  );
}

async function bookLegacy(startTimeMs: number) {
  const { requestBookingHandler } = await import('../src/portal/requestBooking');
  return requestBookingHandler(
    callableRequest({ kinfolkId: 'f1', serviceType: 'walk', startTimeMs }, { uid: 'u1' }),
  );
}

describe('requestBooking: business hours (#1382)', () => {
  it('refuses 2:00 AM on a day the business is open, with the reschedule sentence', async () => {
    const ctx = ctxWith({ businessHours: HOURS, timeZone: ZONE });
    await expect(book([{ startTimeMs: chicago('Monday', '02:00') }])).rejects.toMatchObject({
      code: 'invalid-argument',
      message: 'That time is outside our hours on Mondays (09:00 to 17:00). Pick a time inside them.',
    });
    expect(ctx.writes).toHaveLength(0);
  });

  it('refuses a closed weekday', async () => {
    const ctx = ctxWith({ businessHours: HOURS, timeZone: ZONE });
    await expect(book([{ startTimeMs: chicago('Sunday', '10:00') }])).rejects.toMatchObject({
      code: 'invalid-argument',
      message: 'We are closed on Sundays. Pick another day for this visit.',
    });
    expect(ctx.writes).toHaveLength(0);
  });

  it('accepts a time inside the day hours, read on the business clock not UTC', async () => {
    const ctx = ctxWith({ businessHours: HOURS, timeZone: ZONE });
    await book([{ startTimeMs: chicago('Tuesday', '09:00') }]);
    expect(kinCareWrites(ctx).length).toBeGreaterThan(0);
  });

  it('treats the closing minute as outside, like the phone line', async () => {
    ctxWith({ businessHours: HOURS, timeZone: ZONE });
    await expect(book([{ startTimeMs: chicago('Tuesday', '17:00') }])).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('falls back to America/Chicago when the stored zone is blank', async () => {
    ctxWith({ businessHours: HOURS, timeZone: '' });
    await expect(book([{ startTimeMs: chicago('Monday', '02:00') }])).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('fails open when no weekly hours are configured', async () => {
    const ctx = ctxWith({ timeZone: ZONE });
    await book([{ startTimeMs: chicago('Monday', '02:00') }]);
    expect(kinCareWrites(ctx).length).toBeGreaterThan(0);
  });

  it('fails open when the settings document is missing', async () => {
    const ctx = ctxWith(null);
    await book([{ startTimeMs: chicago('Sunday', '02:00') }]);
    expect(kinCareWrites(ctx).length).toBeGreaterThan(0);
  });

  it('fails open when a day hours string is unreadable', async () => {
    const ctx = ctxWith({ businessHours: { ...HOURS, Monday: 'whenever' }, timeZone: ZONE });
    await book([{ startTimeMs: chicago('Monday', '02:00') }]);
    expect(kinCareWrites(ctx).length).toBeGreaterThan(0);
  });

  it('fails open when the settings read throws', async () => {
    const ctx = ctxWith({ businessHours: HOURS, timeZone: ZONE });
    // Only the booking-policy read (the first read of the settings doc) fails;
    // the closure guard's own read behaves as it always has.
    const realCollection = ctx.db.collection.bind(ctx.db);
    let failed = false;
    ctx.db.collection = ((name: string) => {
      const c = realCollection(name);
      if (name !== 'business_settings') return c;
      return {
        ...c,
        doc: (id: string) => {
          const d = c.doc(id);
          return {
            ...d,
            get: () => {
              if (failed) return d.get();
              failed = true;
              return Promise.reject(new Error('unavailable'));
            },
          };
        },
      };
    }) as typeof ctx.db.collection;
    await book([{ startTimeMs: chicago('Sunday', '02:00') }]);
    expect(kinCareWrites(ctx).length).toBeGreaterThan(0);
  });

  it('does not hold an overnight-style start-time service to the weekly hours', async () => {
    const ctx = ctxWith({ businessHours: HOURS, timeZone: ZONE, serviceStartTimeBooking: { overnight: true } });
    await book([{ serviceId: 'overnight', serviceName: 'Overnight', date: '2099-01-05', startTimeMs: undefined }]);
    expect(kinCareWrites(ctx).length).toBeGreaterThan(0);
  });

  it('checks the legacy single-visit shape too', async () => {
    const ctx = ctxWith({ businessHours: HOURS, timeZone: ZONE });
    await expect(bookLegacy(chicago('Sunday', '10:00'))).rejects.toMatchObject({
      code: 'invalid-argument',
      message: 'We are closed on Sundays. Pick another day for this visit.',
    });
    expect(ctx.writes).toHaveLength(0);
  });
});

describe('requestBooking: business hours across a series (#1382)', () => {
  it('refuses the whole request and names the first bad date', async () => {
    const ctx = ctxWith({ businessHours: HOURS, timeZone: ZONE });
    const good = chicago('Tuesday', '10:00');
    const badEarly = chicago('Wednesday', '03:00', 4);
    const badLate = chicago('Thursday', '03:00', 10);
    const firstBadDate = zonedNow(Math.min(badEarly, badLate), ZONE)!.dateIso;
    await expect(
      book([{ startTimeMs: badLate }, { startTimeMs: good }, { startTimeMs: badEarly }]),
    ).rejects.toMatchObject({
      code: 'invalid-argument',
      message: expect.stringMatching(new RegExp(`^${firstBadDate}: That time is outside our hours on `)),
    });
    expect(ctx.writes).toHaveLength(0);
  });

  it('accepts a series whose every visit is inside the hours', async () => {
    const ctx = ctxWith({ businessHours: HOURS, timeZone: ZONE });
    await book([
      { startTimeMs: chicago('Monday', '09:00'), serviceId: 'a' },
      { startTimeMs: chicago('Tuesday', '09:00'), serviceId: 'b' },
    ]);
    expect(kinCareWrites(ctx).length).toBe(2);
  });
});

describe('requestBooking: business hours with time blocks (#1382)', () => {
  const blockSettings = {
    businessHours: HOURS,
    timeZone: ZONE,
    allowTimeBlockBooking: true,
    allowSpecificTimeBooking: false,
    defaultBookingMode: 'TIME_BLOCK',
    timeBlocks: [{ id: 'morning', label: 'Morning', startTime: '08:00', endTime: '12:00', active: true }],
  };

  it('still refuses a closed weekday when the visit books a block', async () => {
    ctxWith(blockSettings);
    await expect(
      book([{ startTimeMs: chicago('Sunday', '09:00'), timeBlockId: 'morning' }]),
    ).rejects.toMatchObject({ message: 'We are closed on Sundays. Pick another day for this visit.' });
  });

  it('does not second-guess a block start against the clock hours', async () => {
    const ctx = ctxWith(blockSettings);
    await book([{ startTimeMs: chicago('Monday', '08:00'), timeBlockId: 'morning' }]);
    expect(kinCareWrites(ctx).length).toBeGreaterThan(0);
  });
});
