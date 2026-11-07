import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

/**
 * #1574, operator ruling 2026-11-05: a visit created with a past date is
 * "allowed only as already completed ... never Scheduled"; moving an existing
 * visit into the past stays blocked; a backdated Completed visit fires no
 * household notice and no live-visit flow.
 */
const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  writeAuditEntryFn: vi.fn(),
  busyFn: vi.fn(),
  holidayFn: vi.fn(),
  overlapFn: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));
vi.mock('../src/lib/bookingBusyConflict', () => ({ guardBookingBusyConflict: mocks.busyFn }));
vi.mock('../src/lib/companyHolidayConflict', () => ({ guardCompanyHolidayConflict: mocks.holidayFn }));
vi.mock('../src/lib/visitOverlapConflict', () => ({ guardVisitOverlapConflict: mocks.overlapFn }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import {
  classifyVisitWindow,
  classifyVisitTimes,
  newVisitStatusFor,
  assertRescheduleStartAhead,
  VISIT_IN_PAST_MESSAGE,
  VISIT_UNDERWAY_MESSAGE,
  COMPLETED_NOT_OVER_MESSAGE,
  RESCHEDULE_IN_PAST_MESSAGE,
} from '../src/lib/pastVisit';
import { createKinCareSessionHandler } from '../src/admin/createKinCareSession';
import { rescheduleBookingHandler } from '../src/admin/rescheduleBooking';

const NOW = Date.parse('2026-11-06T18:00:00.000Z');
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } as any } as any) : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  for (const fn of [mocks.dbFn, mocks.writeAuditEntryFn, mocks.busyFn, mocks.holidayFn, mocks.overlapFn]) fn.mockReset();
  mocks.writeAuditEntryFn.mockResolvedValue('audit-1');
  mocks.busyFn.mockResolvedValue(undefined);
  mocks.holidayFn.mockResolvedValue(undefined);
  mocks.overlapFn.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('classifyVisitWindow', () => {
  it('names the three windows', () => {
    expect(classifyVisitWindow(NOW + HOUR, NOW + 2 * HOUR, NOW)).toBe('ahead');
    expect(classifyVisitWindow(NOW - 2 * HOUR, NOW - HOUR, NOW)).toBe('ended');
    expect(classifyVisitWindow(NOW - HOUR, NOW + HOUR, NOW)).toBe('underway');
  });

  it('a start exactly at now is ahead, an end exactly at now has ended', () => {
    expect(classifyVisitWindow(NOW, NOW + HOUR, NOW)).toBe('ahead');
    expect(classifyVisitWindow(NOW - HOUR, NOW, NOW)).toBe('ended');
  });

  it('an unreadable or backwards end is read as the start, never as underway', () => {
    expect(classifyVisitWindow(NOW - HOUR, Number.NaN, NOW)).toBe('ended');
    expect(classifyVisitWindow(NOW - HOUR, NOW - 2 * HOUR, NOW)).toBe('ended');
  });
});

describe('newVisitStatusFor', () => {
  const chicago = async () => 'America/Chicago';
  const at = (startMs: number, endMs: number, recordAsCompleted: boolean) =>
    newVisitStatusFor({ startTime: iso(startMs), endTime: iso(endMs), nowMs: NOW, recordAsCompleted, timeZone: chicago });

  it('ahead is SCHEDULED; ended and recorded is COMPLETED', async () => {
    await expect(at(NOW + HOUR, NOW + 2 * HOUR, false)).resolves.toBe('SCHEDULED');
    await expect(at(NOW - 2 * HOUR, NOW - HOUR, true)).resolves.toBe('COMPLETED');
  });

  it('never SCHEDULED in the past', async () => {
    await expect(at(NOW - 2 * HOUR, NOW - HOUR, false)).rejects.toThrow(VISIT_IN_PAST_MESSAGE);
  });

  it('never COMPLETED ahead of time', async () => {
    await expect(at(NOW + HOUR, NOW + 2 * HOUR, true)).rejects.toThrow(COMPLETED_NOT_OVER_MESSAGE);
  });

  it('underway is refused both ways', async () => {
    await expect(at(NOW - HOUR, NOW + HOUR, false)).rejects.toThrow(VISIT_UNDERWAY_MESSAGE);
    await expect(at(NOW - HOUR, NOW + HOUR, true)).rejects.toThrow(VISIT_UNDERWAY_MESSAGE);
  });

  it('an unreadable start is left to the caller, as before', async () => {
    await expect(
      newVisitStatusFor({ startTime: 'soon', endTime: 'later', nowMs: NOW, recordAsCompleted: false, timeZone: chicago }),
    ).resolves.toBe('SCHEDULED');
  });
});

/**
 * Android's reschedule sends a zone-less wall clock. NOW is 2026-11-06 18:00Z,
 * which is 12:00 in Chicago. Read on the server's own clock (UTC), a move to
 * 14:00 Chicago would look four hours past; read on the business clock it is
 * two hours ahead, which is what the operator meant.
 */
describe('a zone-less time is read on the business clock', () => {
  const chicago = vi.fn(async () => 'America/Chicago');
  beforeEach(() => chicago.mockClear());

  it('14:00 wall clock is ahead at 12:00 Chicago', async () => {
    await expect(classifyVisitTimes('2026-11-06T14:00:00', '2026-11-06T15:00:00', NOW, chicago)).resolves.toBe('ahead');
    await expect(assertRescheduleStartAhead('2026-11-06T14:00:00', NOW, chicago)).resolves.toBeUndefined();
  });

  it('11:00 wall clock has passed at 12:00 Chicago', async () => {
    await expect(assertRescheduleStartAhead('2026-11-06T11:00:00', NOW, chicago)).rejects.toThrow(RESCHEDULE_IN_PAST_MESSAGE);
    await expect(classifyVisitTimes('2026-11-06T11:00', '2026-11-06T11:30', NOW, chicago)).resolves.toBe('ended');
    await expect(classifyVisitTimes('2026-11-06T11:30:00', '2026-11-06T12:30:00', NOW, chicago)).resolves.toBe('underway');
  });

  it('an instant never reads the settings at all', async () => {
    await classifyVisitTimes(iso(NOW + HOUR), iso(NOW + 2 * HOUR), NOW, chicago);
    await assertRescheduleStartAhead(iso(NOW + HOUR), NOW, chicago);
    expect(chicago).not.toHaveBeenCalled();
  });
});

describe('createKinCareSession, #1574', () => {
  const base = { kinfolkId: 'kf1', kinIds: ['k1'], serviceType: '30Minute', serviceDurationMinutes: 30 };

  it('refuses a past window sent as a scheduled visit, and writes nothing', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      createKinCareSessionHandler(req({ ...base, startTime: '2025-11-01T14:00:00.000Z', endTime: '2025-11-01T14:30:00.000Z' })),
    ).rejects.toMatchObject({ code: 'failed-precondition', message: VISIT_IN_PAST_MESSAGE, details: { code: 'visit_in_past' } });
    expect(ctx.adds).toHaveLength(0);
    expect(ctx.writes).toHaveLength(0);
  });

  it('records a past window as COMPLETED, completed when it ended, marked as recorded after the fact', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const start = '2025-11-01T14:00:00.000Z';
    const end = '2025-11-01T14:30:00.000Z';

    const res = await createKinCareSessionHandler(req({ ...base, startTime: start, endTime: end, recordAsCompleted: true }));

    expect(res.ok).toBe(true);
    const write = ctx.adds.find((a) => a.collection === 'kin_care_sessions');
    expect(write?.data).toMatchObject({ status: 'COMPLETED', completedAt: end, recordedAfterTheFact: true, startTime: start });
    expect(mocks.writeAuditEntryFn).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ status: 'COMPLETED', recordedAfterTheFact: true }) }),
    );
  });

  /**
   * The ruling's own check: "a backdated Completed visit must not fire
   * household notices or the live-visit flow". The handler writes exactly one
   * document, the session; nothing lands in a notification, message or
   * envelope collection, and the status is never one Auntie Time works.
   */
  it('a backdated record writes the session and nothing else: no notice, no envelope, no live visit', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);

    await createKinCareSessionHandler(
      req({ ...base, startTime: '2025-11-01T14:00:00.000Z', endTime: '2025-11-01T14:30:00.000Z', recordAsCompleted: true }),
    );

    expect(ctx.adds.map((a) => a.collection)).toEqual(['kin_care_sessions']);
    expect(ctx.writes.filter((w) => !w.path.startsWith('kin_care_sessions/'))).toEqual([]);
    const status = ctx.adds[0]!.data.status;
    expect(['SCHEDULED', 'CONFIRMED', 'ARRIVED', 'IN_PROGRESS', 'DEPARTED']).not.toContain(status);
  });

  it('a backdated record skips the busy and closure guards and still runs the overlap guard', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({}).db);
    await createKinCareSessionHandler(
      req({ ...base, startTime: '2025-12-25T14:00:00.000Z', endTime: '2025-12-25T14:30:00.000Z', recordAsCompleted: true }),
    );
    expect(mocks.busyFn).not.toHaveBeenCalled();
    expect(mocks.holidayFn).not.toHaveBeenCalled();
    expect(mocks.overlapFn).toHaveBeenCalledTimes(1);
  });

  it('a visit still ahead cannot be recorded as completed', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      createKinCareSessionHandler(req({ ...base, startTime: iso(NOW + HOUR), endTime: iso(NOW + 2 * HOUR), recordAsCompleted: true })),
    ).rejects.toMatchObject({ code: 'failed-precondition', details: { code: 'completed_visit_not_over' } });
    expect(ctx.adds).toHaveLength(0);
  });

  it('a visit ahead is SCHEDULED exactly as before, every guard run', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await createKinCareSessionHandler(req({ ...base, startTime: iso(NOW + HOUR), endTime: iso(NOW + 2 * HOUR) }));
    const write = ctx.adds.find((a) => a.collection === 'kin_care_sessions');
    expect(write?.data.status).toBe('SCHEDULED');
    expect(write?.data).not.toHaveProperty('completedAt');
    expect(write?.data).not.toHaveProperty('recordedAfterTheFact');
    expect(mocks.busyFn).toHaveBeenCalledTimes(1);
    expect(mocks.holidayFn).toHaveBeenCalledTimes(1);
    expect(mocks.overlapFn).toHaveBeenCalledTimes(1);
  });
});

describe('rescheduleBooking, #1574', () => {
  it('refuses a move into the past before reading the visit or running a guard', async () => {
    const ctx = buildDbMock({ docs: { 'kin_care_sessions/s1': { startTime: iso(NOW + HOUR), endTime: iso(NOW + 2 * HOUR) } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      rescheduleBookingHandler(req({ sessionId: 's1', startTime: '2025-11-01T14:00:00.000Z', endTime: '2025-11-01T14:30:00.000Z' })),
    ).rejects.toMatchObject({ code: 'failed-precondition', message: RESCHEDULE_IN_PAST_MESSAGE, details: { code: 'reschedule_in_past' } });
    expect(ctx.writes).toHaveLength(0);
    expect(mocks.busyFn).not.toHaveBeenCalled();
    expect(mocks.overlapFn).not.toHaveBeenCalled();
  });

  it('still moves a visit to a time ahead', async () => {
    const ctx = buildDbMock({ docs: { 'kin_care_sessions/s1': { startTime: iso(NOW + HOUR), endTime: iso(NOW + 2 * HOUR) } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await rescheduleBookingHandler(req({ sessionId: 's1', startTime: iso(NOW + 3 * HOUR), endTime: iso(NOW + 4 * HOUR) }));
    expect(ctx.writes.find((w) => w.path === 'kin_care_sessions/s1')?.data.startTime).toBe(iso(NOW + 3 * HOUR));
  });

  it('the guard on its own: past refused, now and unreadable let through', async () => {
    const utc = async () => 'UTC';
    await expect(assertRescheduleStartAhead(iso(NOW - 1), NOW, utc)).rejects.toThrow(RESCHEDULE_IN_PAST_MESSAGE);
    await expect(assertRescheduleStartAhead(iso(NOW), NOW, utc)).resolves.toBeUndefined();
    await expect(assertRescheduleStartAhead('whenever', NOW, utc)).resolves.toBeUndefined();
  });

  it('reads a zone-less Android move on the stored business zone', async () => {
    const ctx = buildDbMock({
      docs: {
        'kin_care_sessions/s1': { startTime: '2026-11-07T09:00:00', endTime: '2026-11-07T10:00:00' },
        'business_settings/business_settings': { timeZone: 'America/Chicago' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    // 14:00 Chicago is ahead at 12:00 Chicago, though 14:00 UTC is not ahead of 18:00Z.
    await rescheduleBookingHandler(req({ sessionId: 's1', startTime: '2026-11-06T14:00:00', endTime: '2026-11-06T15:00:00' }));
    expect(ctx.writes.find((w) => w.path === 'kin_care_sessions/s1')?.data.startTime).toBe('2026-11-06T14:00:00');
  });
});
