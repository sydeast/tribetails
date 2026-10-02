import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest, HttpsError } from 'firebase-functions/v2/https';

/**
 * #1162: a sync removes the rows of Google busy events that were moved or
 * deleted, and nothing else. This deletes production data on the next sync,
 * so most of this file is about what it must NOT delete.
 *
 * Every handler test runs against a write-through mock: the rows are seeded as
 * documents, the sync's deletes really remove them, and the busy guard then
 * reads the same store a booking would.
 */

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  freebusyQuery: vi.fn(),
  logEventFn: vi.fn(),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));
vi.mock('../src/lib/writeAuditEntry', () => ({
  writeAuditEntry: vi.fn().mockResolvedValue('audit-1'),
}));
vi.mock('@googleapis/calendar', () => ({
  auth: { GoogleAuth: class { constructor() {} } },
  calendar: () => ({ freebusy: { query: mocks.freebusyQuery } }),
}));

import {
  syncGoogleCalendarBusyEventsHandler,
  staleBusyRowIds,
  fetchIncompleteReason,
  busyEventKeyOf,
} from '../src/admin/syncGoogleCalendarBusyEvents';
import { busyIntervalToSlots } from '../src/lib/googleBusySlot';
import { guardBookingBusyConflict } from '../src/lib/bookingBusyConflict';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

const CAL = 'team-cal@group.calendar.google.com';
const OTHER_CAL = 'other-cal@group.calendar.google.com';
const ZONE = 'America/Chicago';
/** The run's "now". The default 30-day look-ahead reaches 2026-07-04T12:00Z. */
const NOW = '2026-06-04T12:00:00.000Z';
/** Written by an earlier sync, before this run began. */
const EARLIER = '2026-06-03T00:00:00.000Z';

function req(data: unknown = {}): CallableRequest<unknown> {
  return {
    data,
    auth: { uid: 'admin1', token: { admin: true } } as any,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

type Docs = Record<string, Record<string, unknown>>;

/** Rows a previous sync wrote for `[start, end)`, keyed `prefix-0`, `prefix-1`, ... */
function importedRows(prefix: string, start: string, end: string, cal = CAL): Docs {
  const out: Docs = {};
  busyIntervalToSlots({ start, end }, cal, EARLIER, ZONE).forEach((slot, i) => {
    out[`booking_time_slots/${prefix}-${i}`] = { ...slot };
  });
  return out;
}

function store(rows: Docs) {
  const ctx = buildDbMock({
    writeThrough: true,
    docs: {
      'business_settings/business_settings': { calendarSyncId: CAL, timeZone: ZONE },
      ...rows,
    },
  });
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}

function googleSays(busy: Array<{ start: string; end: string }>) {
  mocks.freebusyQuery.mockResolvedValue({ data: { calendars: { [CAL]: { busy } } } });
}

/** Every `booking_time_slots` row left in the store, by id. */
async function slotRows(ctx: ReturnType<typeof store>): Promise<Record<string, Record<string, unknown>>> {
  const snap = await ctx.db.collection('booking_time_slots').get();
  const out: Record<string, Record<string, unknown>> = {};
  for (const d of snap.docs) out[d.id] = d.data();
  return out;
}

function book(ctx: ReturnType<typeof store>, start: string, end: string) {
  return guardBookingBusyConflict({
    firestore: ctx.db as any,
    visits: [{ startTimeMs: Date.parse(start), endTimeMs: Date.parse(end) }],
    actorUid: 'k1',
    actorRole: 'PRIMARY',
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  mocks.dbFn.mockReset();
  mocks.freebusyQuery.mockReset();
  mocks.logEventFn.mockReset();
  (writeAuditEntry as any).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('#1162 stale Google busy rows', () => {
  it('a moved event leaves only the new rows', async () => {
    const ctx = store(importedRows('old', '2026-06-10T14:00:00.000Z', '2026-06-10T15:00:00.000Z'));
    googleSays([{ start: '2026-06-11T14:00:00.000Z', end: '2026-06-11T15:00:00.000Z' }]);

    await syncGoogleCalendarBusyEventsHandler(req());

    const rows = Object.values(await slotRows(ctx));
    expect(rows.map((r) => r['externalEventId'])).toEqual([
      `busy_${CAL}_${Date.parse('2026-06-11T14:00:00.000Z')}_${Date.parse('2026-06-11T15:00:00.000Z')}`,
    ]);
    expect(ctx.deletes).toEqual(['booking_time_slots/old-0']);
    // The old time books again; the new time is refused.
    await expect(book(ctx, '2026-06-10T14:15:00.000Z', '2026-06-10T14:45:00.000Z')).resolves.toBeUndefined();
    await expect(book(ctx, '2026-06-11T14:15:00.000Z', '2026-06-11T14:45:00.000Z')).rejects.toBeInstanceOf(HttpsError);
  });

  it("a deleted event's rows are gone and no longer refuse a booking", async () => {
    const ctx = store(importedRows('gone', '2026-06-10T14:00:00.000Z', '2026-06-10T15:00:00.000Z'));
    // The fixture really does refuse the booking before the sync.
    await expect(book(ctx, '2026-06-10T14:15:00.000Z', '2026-06-10T14:45:00.000Z')).rejects.toBeInstanceOf(HttpsError);
    googleSays([]);

    await syncGoogleCalendarBusyEventsHandler(req());

    expect(await slotRows(ctx)).toEqual({});
    await expect(book(ctx, '2026-06-10T14:15:00.000Z', '2026-06-10T14:45:00.000Z')).resolves.toBeUndefined();
    const audit = (writeAuditEntry as any).mock.calls[0][0];
    expect(audit.payload).toMatchObject({ count: 0, removed: 1, cleanupSkipped: '' });
  });

  it('split rows (_d1, _d2) of a deleted event are cleaned together', async () => {
    // 22:00 CDT on the 10th to 01:00 CDT on the 12th: three business days.
    const rows = importedRows('split', '2026-06-11T03:00:00.000Z', '2026-06-12T06:00:00.000Z');
    const keys = Object.values(rows).map((r) => r['externalEventId'] as string);
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(`${keys[0]}_d1`);
    expect(keys[2]).toBe(`${keys[0]}_d2`);
    const ctx = store(rows);
    googleSays([]);

    await syncGoogleCalendarBusyEventsHandler(req());

    expect(await slotRows(ctx)).toEqual({});
    expect([...ctx.deletes].sort()).toEqual([
      'booking_time_slots/split-0',
      'booking_time_slots/split-1',
      'booking_time_slots/split-2',
    ]);
  });

  it('an unchanged event keeps its rows, split ones included', async () => {
    const rows = importedRows('kept', '2026-06-11T03:00:00.000Z', '2026-06-11T07:00:00.000Z');
    const ctx = store(rows);
    googleSays([{ start: '2026-06-11T03:00:00.000Z', end: '2026-06-11T07:00:00.000Z' }]);

    await syncGoogleCalendarBusyEventsHandler(req());

    expect(ctx.deletes).toEqual([]);
    expect(Object.keys(await slotRows(ctx)).sort()).toEqual(['kept-0', 'kept-1']);
  });

  describe('a fetch that failed or came back partial deletes nothing', () => {
    const seeded = () =>
      store({
        ...importedRows('a', '2026-06-10T14:00:00.000Z', '2026-06-10T15:00:00.000Z'),
        ...importedRows('b', '2026-06-11T03:00:00.000Z', '2026-06-11T07:00:00.000Z'),
      });

    it('Google errors out', async () => {
      const ctx = seeded();
      mocks.freebusyQuery.mockRejectedValue({ code: 500, message: 'backend error' });
      const outcome = await syncGoogleCalendarBusyEventsHandler(req()).then(() => 'resolved', (e: unknown) => e);
      // Deletes are checked first, so a run that swallowed the error fails on what it removed.
      expect(ctx.deletes).toEqual([]);
      expect(outcome).toBeInstanceOf(HttpsError);
      expect(Object.keys(await slotRows(ctx))).toHaveLength(3);
    });

    it('the calendar is not shared any more', async () => {
      const ctx = seeded();
      mocks.freebusyQuery.mockRejectedValue({ code: 403, message: 'forbidden' });
      const outcome = await syncGoogleCalendarBusyEventsHandler(req()).then(() => 'resolved', (e: unknown) => e);
      // Deletes are checked first, so a run that swallowed the error fails on what it removed.
      expect(ctx.deletes).toEqual([]);
      expect(outcome).toBeInstanceOf(HttpsError);
    });

    it('a per-calendar error inside a 200 answer', async () => {
      const ctx = seeded();
      mocks.freebusyQuery.mockResolvedValue({
        data: { calendars: { [CAL]: { errors: [{ domain: 'global', reason: 'backendError' }] } } },
      });
      const outcome = await syncGoogleCalendarBusyEventsHandler(req()).then(() => 'resolved', (e: unknown) => e);
      // Deletes are checked first, so a run that swallowed the error fails on what it removed.
      expect(ctx.deletes).toEqual([]);
      expect(outcome).toBeInstanceOf(HttpsError);
    });

    it.each([
      ['the calendar is missing from the answer', { calendars: {} }, 'calendar_missing_from_response'],
      ['there are no calendars at all', {}, 'calendar_missing_from_response'],
      ['the busy list is missing', { calendars: { [CAL]: {} } }, 'busy_list_missing'],
      [
        'one interval has no end',
        { calendars: { [CAL]: { busy: [{ start: '2026-06-12T14:00:00.000Z' }] } } },
        'busy_interval_unreadable',
      ],
      [
        'one interval does not parse',
        { calendars: { [CAL]: { busy: [{ start: 'not a date', end: 'nor this' }] } } },
        'busy_interval_unreadable',
      ],
    ])('%s', async (_label, data, reason) => {
      const ctx = seeded();
      mocks.freebusyQuery.mockResolvedValue({ data });

      await syncGoogleCalendarBusyEventsHandler(req());

      expect(ctx.deletes).toEqual([]);
      expect(Object.keys(await slotRows(ctx))).toHaveLength(3);
      const skipped = mocks.logEventFn.mock.calls.find((c) => c[0].event === 'gcal.sync.cleanup_skipped');
      expect(skipped?.[0].extra.reason).toBe(reason);
      expect((writeAuditEntry as any).mock.calls[0][0].payload.cleanupSkipped).toBe(reason);
    });

    it('an upsert that fails stops the run before any delete', async () => {
      const ctx = seeded();
      googleSays([{ start: '2026-06-20T14:00:00.000Z', end: '2026-06-20T15:00:00.000Z' }]);
      const realCollection = ctx.db.collection.bind(ctx.db);
      vi.spyOn(ctx.db as any, 'collection').mockImplementation(((name: string) => {
        const col = realCollection(name);
        if (name !== 'booking_time_slots') return col;
        return Object.assign(Object.create(col), {
          doc: (id?: string) => Object.assign(col.doc(id), { set: () => Promise.reject(new Error('write failed')) }),
        });
      }) as any);

      await expect(syncGoogleCalendarBusyEventsHandler(req())).rejects.toThrow('write failed');
      expect(ctx.deletes).toEqual([]);
    });
  });

  it('leaves operator blocks, other calendars, and rows outside the window alone', async () => {
    const inWindow = { date: '2026-06-10', startTime: '09:00', endTime: '10:00' };
    const ctx = store({
      'booking_time_slots/operator': { ...inWindow, source: 'INTERNAL_MANUAL', slotType: 'BLOCKED', isAvailable: false },
      'booking_time_slots/no-source': { ...inWindow, slotType: 'BLOCKED', isAvailable: false },
      // An operator block that happens to carry this calendar's id and a key: only `source` keeps it.
      'booking_time_slots/operator-tagged': {
        ...Object.values(importedRows('x', '2026-06-12T14:00:00.000Z', '2026-06-12T15:00:00.000Z'))[0],
        source: 'INTERNAL_MANUAL',
      },
      ...importedRows('other-cal', '2026-06-10T14:00:00.000Z', '2026-06-10T15:00:00.000Z', OTHER_CAL),
      // Past the 30-day look-ahead, left by an earlier 90-day sync.
      ...importedRows('beyond', '2026-08-01T14:00:00.000Z', '2026-08-01T15:00:00.000Z'),
      // Began before this run's start, so freebusy only reported its tail.
      ...importedRows('straddle', '2026-06-04T11:00:00.000Z', '2026-06-04T13:00:00.000Z'),
      // Already past.
      ...importedRows('past', '2026-06-01T14:00:00.000Z', '2026-06-01T15:00:00.000Z'),
    });
    googleSays([]);

    await syncGoogleCalendarBusyEventsHandler(req());

    expect(ctx.deletes).toEqual([]);
    expect(Object.keys(await slotRows(ctx)).sort()).toEqual([
      'beyond-0',
      'no-source',
      'operator',
      'operator-tagged',
      'other-cal-0',
      'past-0',
      'straddle-0',
    ]);
  });

  it('removes a stale legacy row (UTC wall clock, no instants) inside the window', async () => {
    const ctx = store({
      'booking_time_slots/legacy': {
        date: '2026-06-10',
        startTime: '14:00',
        endTime: '15:00',
        source: 'GOOGLE_BUSY_IMPORT',
        externalCalendarId: CAL,
        externalEventId: `busy_${CAL}_${Date.parse('2026-06-10T14:00:00.000Z')}_${Date.parse('2026-06-10T15:00:00.000Z')}`,
        createdAt: EARLIER,
      },
    });
    googleSays([]);

    await syncGoogleCalendarBusyEventsHandler(req());

    expect(ctx.deletes).toEqual(['booking_time_slots/legacy']);
  });

  it('deletes in batches of at most 500', async () => {
    const rows: Docs = {};
    for (let i = 0; i < 501; i += 1) {
      const start = Date.parse('2026-06-10T00:00:00.000Z') + i * 60_000;
      Object.assign(rows, importedRows(`r${i}`, new Date(start).toISOString(), new Date(start + 30_000).toISOString()));
    }
    const ctx = store(rows);
    const batchSpy = vi.spyOn(ctx.db, 'batch');
    googleSays([]);

    await syncGoogleCalendarBusyEventsHandler(req());

    expect(batchSpy).toHaveBeenCalledTimes(2);
    expect(ctx.deletes).toHaveLength(501);
    expect(await slotRows(ctx)).toEqual({});
    const removedLog = mocks.logEventFn.mock.calls.find((c) => c[0].event === 'gcal.sync.stale_removed');
    expect(removedLog?.[0].extra.removed).toBe(501);
    expect(removedLog?.[0].extra.keys).toHaveLength(50);
  });
});

describe('staleBusyRowIds (pure)', () => {
  const window = { startMs: Date.parse(NOW), endMs: Date.parse('2026-07-04T12:00:00.000Z') };
  const rowsOf = (docs: Docs) =>
    Object.entries(docs).map(([path, data]) => ({ id: path.split('/')[1]!, data }));

  it('keeps every day row of an event when any one of its keys was fetched', () => {
    const docs = importedRows('s', '2026-06-11T03:00:00.000Z', '2026-06-11T07:00:00.000Z');
    const keys = Object.values(docs).map((r) => r['externalEventId'] as string);
    expect(staleBusyRowIds(rowsOf(docs), CAL, new Set([keys[1]!]), window, NOW)).toEqual([]);
    expect(staleBusyRowIds(rowsOf(docs), CAL, new Set(), window, NOW).sort()).toEqual(['s-0', 's-1']);
  });

  it('keeps a row a newer run wrote', () => {
    const docs = importedRows('n', '2026-06-10T14:00:00.000Z', '2026-06-10T15:00:00.000Z');
    const newer = rowsOf(docs).map((r) => ({ ...r, data: { ...r.data, createdAt: '2026-06-04T12:00:05.000Z' } }));
    expect(staleBusyRowIds(newer, CAL, new Set(), window, NOW)).toEqual([]);
  });

  it('keeps a row whose time does not decode', () => {
    const rows = [
      {
        id: 'bad',
        data: { source: 'GOOGLE_BUSY_IMPORT', externalCalendarId: CAL, externalEventId: 'busy_x_1_2', date: 'garbage' },
      },
    ];
    expect(staleBusyRowIds(rows, CAL, new Set(), window, NOW)).toEqual([]);
  });

  it('busyEventKeyOf strips only a trailing day suffix', () => {
    expect(busyEventKeyOf('busy_c_1_2_d2')).toBe('busy_c_1_2');
    expect(busyEventKeyOf('busy_c_1_2')).toBe('busy_c_1_2');
    expect(busyEventKeyOf('busy_cal_d3x_1_2')).toBe('busy_cal_d3x_1_2');
  });

  it('fetchIncompleteReason accepts a complete answer, empty included', () => {
    expect(fetchIncompleteReason({ busy: [] })).toBeNull();
    expect(fetchIncompleteReason({ busy: [{ start: 'a', end: 'b' }] })).toBeNull();
    expect(fetchIncompleteReason(undefined)).toBe('calendar_missing_from_response');
  });
});
