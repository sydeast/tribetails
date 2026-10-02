import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));

import {
  groupByEnvelope,
  listPendingBookingRequestsHandler,
} from '../src/admin/pendingBookingRequests';

beforeEach(() => mocks.dbFn.mockReset());

const ts = (ms: number) => ({ toMillis: () => ms });
const SEP4 = Date.UTC(2026, 8, 4, 16, 0);
const SEP5 = Date.UTC(2026, 8, 5, 16, 0);
const SEP6 = Date.UTC(2026, 8, 6, 16, 0);
const SEP7 = Date.UTC(2026, 8, 7, 16, 0);

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } } as never) : undefined,
    rawRequest: {} as never,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

const visitPath = (fam: string, batch: string, visit: string) =>
  `families/${fam}/bookings/${batch}/kinCares/${visit}`;

describe('groupByEnvelope — four visits are ONE request (#533)', () => {
  it('collapses a long weekend into a single row with its dates sorted', () => {
    const groups = groupByEnvelope([
      { path: visitPath('fam1', 'req_1', 'v3'), data: { startTime: ts(SEP6) } },
      { path: visitPath('fam1', 'req_1', 'v1'), data: { startTime: ts(SEP4), serviceType: 'Dog Walk' } },
      { path: visitPath('fam1', 'req_1', 'v4'), data: { startTime: ts(SEP7) } },
      { path: visitPath('fam1', 'req_1', 'v2'), data: { startTime: ts(SEP5) } },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.batchId).toBe('req_1');
    expect(groups[0]!.kinfolkId).toBe('fam1');
    expect(groups[0]!.startTimeMsList).toEqual([SEP4, SEP5, SEP6, SEP7]);
    expect(groups[0]!.serviceType).toBe('Dog Walk');
  });

  it('keeps two households apart even when their batch ids collide', () => {
    const groups = groupByEnvelope([
      { path: visitPath('fam1', 'req_1', 'v1'), data: { startTime: ts(SEP4) } },
      { path: visitPath('fam2', 'req_1', 'v1'), data: { startTime: ts(SEP5) } },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.kinfolkId).sort()).toEqual(['fam1', 'fam2']);
  });

  it('a later visit that names no service does not blank one that did', () => {
    const groups = groupByEnvelope([
      { path: visitPath('fam1', 'req_1', 'v1'), data: { startTime: ts(SEP4), serviceType: 'Dog Walk' } },
      { path: visitPath('fam1', 'req_1', 'v2'), data: { startTime: ts(SEP5) } },
    ]);
    expect(groups[0]!.serviceType).toBe('Dog Walk');
  });

  it('drops a row whose path is not a kinCare under a booking', () => {
    expect(groupByEnvelope([{ path: 'families/fam1', data: {} }])).toEqual([]);
  });
});

describe('listPendingBookingRequests', () => {
  function dbWith(visits: Array<{ path: string; data: Record<string, unknown> }>, envelopes: Record<string, unknown> = {}) {
    return buildDbMock({
      docs: {
        'families/fam1': { displayName: 'The Rivera Home' },
        ...envelopes,
      },
      collectionGroupDocs: {
        kinCares: visits.map((v) => ({ id: v.path.split('/').pop()!, path: v.path, data: v.data })),
      },
    });
  }

  it('refuses an unauthenticated caller', async () => {
    mocks.dbFn.mockReturnValue(dbWith([]).db);
    await expect(listPendingBookingRequestsHandler(req({}, null))).rejects.toThrow(/Sign-in required/);
  });

  it('rejects a limit outside the allowed range', async () => {
    mocks.dbFn.mockReturnValue(dbWith([]).db);
    await expect(listPendingBookingRequestsHandler(req({ limit: 0 }))).rejects.toThrow(
      /validation failed/,
    );
  });

  it('returns one row per envelope, carrying the span and the household name', async () => {
    const ctx = dbWith(
      [
        { path: visitPath('fam1', 'req_1', 'v1'), data: { status: 'requested', startTime: ts(SEP4), serviceType: 'Dog Walk', kinNames: ['Rex'] } },
        { path: visitPath('fam1', 'req_1', 'v2'), data: { status: 'requested', startTime: ts(SEP7) } },
      ],
      { 'families/fam1/bookings/req_1': { createdAt: ts(SEP4 - 86400000), notes: 'Back door code 1234' } },
    );
    mocks.dbFn.mockReturnValue(ctx.db);

    const out = await listPendingBookingRequestsHandler(req({}));

    expect(out.requests).toHaveLength(1);
    const row = out.requests[0]!;
    expect(row.batchId).toBe('req_1');
    expect(row.visitCount).toBe(2);
    expect(row.firstStartTimeMs).toBe(SEP4);
    expect(row.lastStartTimeMs).toBe(SEP7);
    expect(row.kinfolkName).toBe('The Rivera Home');
    expect(row.notes).toBe('Back door code 1234');
    expect(row.kinNames).toEqual(['Rex']);
  });

  it('sorts oldest ask first, and an unreadable ask date sorts LAST not to 1970', async () => {
    const ctx = dbWith(
      [
        { path: visitPath('fam1', 'req_new', 'v1'), data: { status: 'requested', startTime: ts(SEP4) } },
        { path: visitPath('fam1', 'req_old', 'v1'), data: { status: 'requested', startTime: ts(SEP5) } },
        { path: visitPath('fam1', 'req_unknown', 'v1'), data: { status: 'requested', startTime: ts(SEP6) } },
      ],
      {
        'families/fam1/bookings/req_new': { createdAt: ts(2000) },
        'families/fam1/bookings/req_old': { createdAt: ts(1000) },
        // req_unknown has no envelope doc at all, so no requestedAtMs.
      },
    );
    mocks.dbFn.mockReturnValue(ctx.db);

    const out = await listPendingBookingRequestsHandler(req({}));
    expect(out.requests.map((r) => r.batchId)).toEqual(['req_old', 'req_new', 'req_unknown']);
  });

  it('still lists a request whose envelope doc is missing, rather than dropping it', async () => {
    // An unanswerable request the office cannot see is the whole of #533.
    const ctx = dbWith([
      { path: visitPath('fam1', 'req_1', 'v1'), data: { status: 'requested', startTime: ts(SEP4), serviceType: 'Dog Walk' } },
    ]);
    mocks.dbFn.mockReturnValue(ctx.db);

    const out = await listPendingBookingRequestsHandler(req({}));
    expect(out.requests).toHaveLength(1);
    expect(out.requests[0]!.serviceType).toBe('Dog Walk');
    expect(out.requests[0]!.requestedAtMs).toBeNull();
  });

  it('honours the limit after grouping, so the cap counts requests not visits', async () => {
    const ctx = dbWith(
      [
        { path: visitPath('fam1', 'req_a', 'v1'), data: { status: 'requested', startTime: ts(SEP4) } },
        { path: visitPath('fam1', 'req_a', 'v2'), data: { status: 'requested', startTime: ts(SEP5) } },
        { path: visitPath('fam1', 'req_b', 'v1'), data: { status: 'requested', startTime: ts(SEP6) } },
      ],
      {
        'families/fam1/bookings/req_a': { createdAt: ts(1000) },
        'families/fam1/bookings/req_b': { createdAt: ts(2000) },
      },
    );
    mocks.dbFn.mockReturnValue(ctx.db);

    const out = await listPendingBookingRequestsHandler(req({ limit: 1 }));
    expect(out.requests).toHaveLength(1);
    expect(out.requests[0]!.batchId).toBe('req_a');
    expect(out.requests[0]!.visitCount).toBe(2);
  });
});

/**
 * #1098: the operator sets an Overnight's start time in this queue, so each row
 * carries its visits: which ones still await a time, for which night, and how
 * long each runs. A night with no time must still be counted and listed.
 */
describe('listPendingBookingRequests: per-visit detail (#1098)', () => {
  const HOUR = 3_600_000;
  function dbWith(visits: Array<{ path: string; data: Record<string, unknown> }>) {
    return buildDbMock({
      docs: {
        'families/fam1': { displayName: 'The Rivera Home' },
        'families/fam1/bookings/req_1': { createdAt: ts(1000) },
        'business_settings/business_settings': { serviceDurations: { Overnight: '720' } },
      },
      collectionGroupDocs: {
        kinCares: visits.map((v) => ({ id: v.path.split('/').pop()!, path: v.path, data: v.data })),
      },
    });
  }

  it('lists a night awaiting its time next to a timed visit, and keeps the instant lists to the timed one', async () => {
    const ctx = dbWith([
      {
        path: visitPath('fam1', 'req_1', 'v2'),
        data: {
          status: 'requested', startTime: null, endTime: null, startTimePending: true, requestedDate: '2026-09-05',
          serviceId: 'Overnight', serviceType: 'Overnight', timeBlockLabel: null,
        },
      },
      {
        path: visitPath('fam1', 'req_1', 'v1'),
        data: {
          status: 'requested', startTime: ts(SEP4), endTime: ts(SEP4 + HOUR / 2), startTimePending: false, requestedDate: null,
          serviceId: '30Minute', serviceType: '30 Minute', timeBlockLabel: 'Midday',
        },
      },
    ]);
    mocks.dbFn.mockReturnValue(ctx.db);
    const [row] = (await listPendingBookingRequestsHandler(req({}))).requests;
    expect(row!.visitCount).toBe(2);
    expect(row!.startTimeMsList).toEqual([SEP4]);
    expect(row!.firstStartTimeMs).toBe(SEP4);
    expect(row!.lastStartTimeMs).toBe(SEP4);
    expect(row!.visits).toEqual([
      {
        visitId: 'v1', serviceId: '30Minute', serviceType: '30 Minute', startTimeMs: SEP4,
        startTimePending: false, requestedDate: null, timeBlockLabel: 'Midday', lengthMinutes: 30,
      },
      {
        visitId: 'v2', serviceId: 'Overnight', serviceType: 'Overnight', startTimeMs: null,
        startTimePending: true, requestedDate: '2026-09-05', timeBlockLabel: null, lengthMinutes: 720,
      },
    ]);
  });

  it('an all-night request has null instants, not a dropped row', async () => {
    const ctx = dbWith([
      {
        path: visitPath('fam1', 'req_1', 'v1'),
        data: { status: 'requested', startTime: null, startTimePending: true, requestedDate: '2026-09-05', serviceId: 'Overnight', serviceType: 'Overnight' },
      },
    ]);
    mocks.dbFn.mockReturnValue(ctx.db);
    const [row] = (await listPendingBookingRequestsHandler(req({}))).requests;
    expect(row).toMatchObject({ visitCount: 1, firstStartTimeMs: null, lastStartTimeMs: null, startTimeMsList: [] });
    expect(row!.visits[0]).toMatchObject({ startTimePending: true, requestedDate: '2026-09-05', lengthMinutes: 720 });
  });

  it('a visit written before #1098 reads as not pending, with no requested date', async () => {
    const ctx = dbWith([
      { path: visitPath('fam1', 'req_1', 'v1'), data: { status: 'requested', startTime: ts(SEP4), serviceType: 'Dog Walk' } },
    ]);
    mocks.dbFn.mockReturnValue(ctx.db);
    const [row] = (await listPendingBookingRequestsHandler(req({}))).requests;
    expect(row!.visits[0]).toEqual({
      visitId: 'v1', serviceId: null, serviceType: 'Dog Walk', startTimeMs: SEP4,
      startTimePending: false, requestedDate: null, timeBlockLabel: null, lengthMinutes: null,
    });
  });
});
