import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { callableRequest } from './_helpers/callableRequest';
import { zonedNow } from '../src/lib/businessHours';
/**
 * #1284: a household's proposed new time is judged by the rules the booking
 * path uses. A 2:00 AM ask on a Sunday used to land in the office's queue; the
 * cases below pin each refusal, and the cases that must still pass.
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
const VISIT = 'families/f1/bookings/b1/kinCares/v1';
const SETTINGS = 'business_settings/business_settings';
const ZONE = 'America/Chicago';
const HALF_HOUR = 30 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
/** The first instant at least three days out that reads as `dayName` `hhmm` on the Chicago wall clock. */
function chicago(dayName: string, hhmm: string): number {
  const first = Math.ceil((Date.now() + 3 * DAY) / HALF_HOUR) * HALF_HOUR;
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
const BLOCKS = [
  { id: 'morning', label: 'Morning', startTime: '08:00', endTime: '12:00', active: true },
  { id: 'afternoon', label: 'Afternoon', startTime: '12:00', endTime: '17:00', active: true },
];
function ctxWith(settings: Record<string, unknown> | null, visit: Record<string, unknown> = {}) {
  const docs: Record<string, Record<string, unknown>> = {
    'clients/u1': { kinfolkIds: ['f1'] },
    [VISIT]: { status: 'confirmed', ...visit },
  };
  if (settings) docs[SETTINGS] = settings;
  const ctx = buildDbMock({ docs });
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}
async function ask(over: Record<string, unknown>) {
  const { requestBookingRescheduleHandler } = await import('../src/portal/requestBookingReschedule');
  return requestBookingRescheduleHandler(
    callableRequest({ kinfolkId: 'f1', batchId: 'b1', visitId: 'v1', ...over }, { uid: 'u1' }),
  );
}
describe('requestBookingReschedule: business hours (#1284)', () => {
  it('refuses 2:00 AM on a day the business is open', async () => {
    const ctx = ctxWith({ businessHours: HOURS, timeZone: ZONE });
    await expect(ask({ proposedStartTimeMs: chicago('Monday', '02:00') })).rejects.toMatchObject({
      code: 'invalid-argument',
      message: expect.stringContaining('outside our hours on Mondays (09:00 to 17:00)'),
    });
    expect(ctx.writes).toHaveLength(0);
  });
  it('refuses a closed weekday', async () => {
    const ctx = ctxWith({ businessHours: HOURS, timeZone: ZONE });
    await expect(ask({ proposedStartTimeMs: chicago('Sunday', '10:00') })).rejects.toMatchObject({
      code: 'invalid-argument',
      message: 'We are closed on Sundays. Pick another day for this visit.',
    });
    expect(ctx.writes).toHaveLength(0);
  });
  it('accepts a time inside the day hours, read on the business clock not UTC', async () => {
    const ctx = ctxWith({ businessHours: HOURS, timeZone: ZONE });
    const t = chicago('Tuesday', '09:00');
    await ask({ proposedStartTimeMs: t });
    expect(ctx.writes.find((w) => w.path === VISIT)?.data?.['rescheduleRequestStatus']).toBe('pending');
  });
  it('treats the closing minute as outside, like the phone line', async () => {
    ctxWith({ businessHours: HOURS, timeZone: ZONE });
    await expect(ask({ proposedStartTimeMs: chicago('Tuesday', '17:00') })).rejects.toMatchObject({ code: 'invalid-argument' });
  });
  it('falls back to America/Chicago when the stored zone is blank', async () => {
    ctxWith({ businessHours: HOURS, timeZone: '' });
    await expect(ask({ proposedStartTimeMs: chicago('Monday', '02:00') })).rejects.toMatchObject({ code: 'invalid-argument' });
  });
  it('fails open when no weekly hours are configured', async () => {
    const ctx = ctxWith({ timeZone: ZONE });
    await ask({ proposedStartTimeMs: chicago('Monday', '02:00') });
    expect(ctx.writes.some((w) => w.path === VISIT)).toBe(true);
  });
  it('fails open when the settings document is missing', async () => {
    const ctx = ctxWith(null);
    await ask({ proposedStartTimeMs: chicago('Sunday', '02:00') });
    expect(ctx.writes.some((w) => w.path === VISIT)).toBe(true);
  });
  it('does not hold an overnight-style start-time service to the weekly hours', async () => {
    const ctx = ctxWith(
      { businessHours: HOURS, timeZone: ZONE, serviceStartTimeBooking: { overnight: true } },
      { serviceId: 'overnight' },
    );
    await ask({ proposedStartTimeMs: chicago('Monday', '20:00') });
    expect(ctx.writes.some((w) => w.path === VISIT)).toBe(true);
  });
});
describe('requestBookingReschedule: closures (#1284)', () => {
  it('refuses a company closure and names the date', async () => {
    const t = chicago('Wednesday', '10:00');
    const z = zonedNow(t, ZONE)!;
    const ctx = ctxWith({ businessHours: HOURS, timeZone: ZONE, companyHolidays: [`${z.dateIso}|Owner away`] });
    await expect(ask({ proposedStartTimeMs: t })).rejects.toMatchObject({
      code: 'failed-precondition',
      message: expect.stringContaining(z.dateIso),
    });
    expect(ctx.writes).toHaveLength(0);
  });
});
describe('requestBookingReschedule: time blocks (#1284)', () => {
  const blockSettings = {
    businessHours: HOURS,
    timeZone: ZONE,
    allowTimeBlockBooking: true,
    allowSpecificTimeBooking: false,
    defaultBookingMode: 'TIME_BLOCK',
    timeBlocks: BLOCKS,
  };
  it('refuses a clock time when the business books by block only', async () => {
    const ctx = ctxWith(blockSettings);
    await expect(ask({ proposedStartTimeMs: chicago('Tuesday', '10:00') })).rejects.toMatchObject({
      code: 'invalid-argument',
      message: expect.stringContaining('time blocks'),
    });
    expect(ctx.writes).toHaveLength(0);
  });
  it('refuses a block id the business does not have', async () => {
    ctxWith(blockSettings);
    await expect(ask({ proposedStartTimeMs: chicago('Tuesday', '10:00'), timeBlockId: 'midnight' })).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });
  it('refuses a start that is outside the named block', async () => {
    ctxWith(blockSettings);
    await expect(ask({ proposedStartTimeMs: chicago('Tuesday', '14:00'), timeBlockId: 'morning' })).rejects.toMatchObject({
      code: 'invalid-argument',
      message: expect.stringContaining('outside the Morning block'),
    });
  });
  it('accepts a start inside the named block and stores the block beside the proposal', async () => {
    const ctx = ctxWith(blockSettings);
    await ask({ proposedStartTimeMs: chicago('Tuesday', '08:00'), timeBlockId: 'morning' });
    const data = ctx.writes.find((w) => w.path === VISIT)?.data;
    expect(data?.['rescheduleRequestedTimeBlockId']).toBe('morning');
    expect(data?.['rescheduleRequestedTimeBlockLabel']).toBe('Morning');
  });
  it('still refuses a closed weekday for a block', async () => {
    ctxWith(blockSettings);
    await expect(ask({ proposedStartTimeMs: chicago('Sunday', '08:00'), timeBlockId: 'morning' })).rejects.toMatchObject({
      message: 'We are closed on Sundays. Pick another day for this visit.',
    });
  });
  it('stores a null block for a clock time', async () => {
    const ctx = ctxWith({ businessHours: HOURS, timeZone: ZONE });
    await ask({ proposedStartTimeMs: chicago('Tuesday', '11:00') });
    const data = ctx.writes.find((w) => w.path === VISIT)?.data;
    expect(data?.['rescheduleRequestedTimeBlockId']).toBeNull();
  });
});
