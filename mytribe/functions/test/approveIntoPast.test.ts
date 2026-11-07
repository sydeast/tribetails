import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

/**
 * #1702: approving a stale request put its visit on the calendar SCHEDULED in
 * the past. Operator ruling, 2026-11-05 docket (#1574): a past-dated visit is
 * allowed only as already Completed, never Scheduled. Both approval paths now
 * refuse a start that has gone by, with one sentence, before anything is
 * written: `transitionBookingStatus` APPROVE (a session with no household
 * request behind it) and `approveBookingSeriesCore` (a household request, via
 * `manageBookingSeries` and `batchUpdateBookings`).
 */
const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), writeAuditEntryFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { transitionBookingStatusHandler } from '../src/admin/transitionBookingStatus';
import { approveBookingSeriesCore } from '../src/admin/approveBookingSeriesCore';
import { APPROVE_IN_PAST_CODE, APPROVE_IN_PAST_MESSAGE } from '../src/lib/pastVisit';

/** 2 PM in Chicago, 20:00 UTC. */
const NOW = '2026-11-06T20:00:00.000Z';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  mocks.dbFn.mockReset();
  mocks.writeAuditEntryFn.mockReset();
  mocks.writeAuditEntryFn.mockResolvedValue('audit-1');
});
afterEach(() => {
  vi.useRealTimers();
});

function req(data: unknown): CallableRequest<unknown> {
  return {
    data,
    auth: { uid: 'admin1', token: { admin: true } },
    rawRequest: {},
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

const refusal = { code: 'failed-precondition', message: APPROVE_IN_PAST_MESSAGE, details: { code: APPROVE_IN_PAST_CODE } };

describe('transitionBookingStatus APPROVE refuses a start that has passed (#1702)', () => {
  function seed(session: Record<string, unknown>) {
    const ctx = buildDbMock({
      docs: { 'kin_care_sessions/s1': { kinfolkId: 'kf1', status: 'PENDING', ...session } },
      queryDocs: {},
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    return ctx;
  }
  const sessionWrites = (ctx: ReturnType<typeof buildDbMock>) =>
    ctx.writes.filter((w) => w.path === 'kin_care_sessions/s1');

  it('refuses a visit that started an hour ago, writes nothing, and audits the refusal', async () => {
    const ctx = seed({ startTime: '2026-11-06T19:00:00.000Z', endTime: '2026-11-06T19:30:00.000Z' });
    await expect(transitionBookingStatusHandler(req({ sessionId: 's1', action: 'APPROVE' }))).rejects.toMatchObject(
      refusal,
    );
    expect(sessionWrites(ctx)).toHaveLength(0);
    expect(mocks.writeAuditEntryFn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'FAILURE', payload: expect.objectContaining({ refusalCode: APPROVE_IN_PAST_CODE }) }),
    );
  });

  it('refuses one from last week, whatever override the client sends', async () => {
    const ctx = seed({ startTime: '2026-10-30T15:00:00.000Z', endTime: '2026-10-30T16:00:00.000Z' });
    await expect(
      transitionBookingStatusHandler(
        req({ sessionId: 's1', action: 'APPROVE', overrideBusyConflict: true, overrideVisitConflict: true }),
      ),
    ).rejects.toMatchObject(refusal);
    expect(sessionWrites(ctx)).toHaveLength(0);
  });

  it('still approves a visit whose start is ahead', async () => {
    const ctx = seed({ startTime: '2026-11-07T15:00:00.000Z', endTime: '2026-11-07T16:00:00.000Z' });
    const res = await transitionBookingStatusHandler(req({ sessionId: 's1', action: 'APPROVE' }));
    expect(res).toMatchObject({ status: 'SCHEDULED', changed: true });
    expect(sessionWrites(ctx)[0]?.data).toMatchObject({ status: 'SCHEDULED' });
  });

  it('reads a zone-less start on the business clock: 6 PM Chicago is still ahead at 2 PM', async () => {
    // Date.parse would read this as 18:00 UTC, two hours BEFORE now.
    const ctx = seed({ startTime: '2026-11-06T18:00:00', endTime: '2026-11-06T19:00:00' });
    const res = await transitionBookingStatusHandler(req({ sessionId: 's1', action: 'APPROVE' }));
    expect(res.status).toBe('SCHEDULED');
    expect(sessionWrites(ctx)).toHaveLength(1);
  });

  it('and refuses a zone-less start of 1 PM Chicago, an hour gone', async () => {
    const ctx = seed({ startTime: '2026-11-06T13:00:00', endTime: '2026-11-06T14:00:00' });
    await expect(transitionBookingStatusHandler(req({ sessionId: 's1', action: 'APPROVE' }))).rejects.toMatchObject(
      refusal,
    );
    expect(sessionWrites(ctx)).toHaveLength(0);
  });

  it('leaves the other transitions alone: a past visit can still be cancelled', async () => {
    seed({ status: 'SCHEDULED', startTime: '2026-11-06T13:00:00.000Z', endTime: '2026-11-06T14:00:00.000Z' });
    const res = await transitionBookingStatusHandler(req({ sessionId: 's1', action: 'CANCEL' }));
    expect(res.status).toBe('CANCELLED');
  });
});

describe('approveBookingSeriesCore refuses a request whose time has passed (#1702)', () => {
  function seed(
    children: Array<{ id: string; data: Record<string, unknown> }>,
    docs: Record<string, Record<string, unknown>> = {},
  ) {
    const ctx = buildDbMock({
      docs: { 'families/3/bookings/b1': { kinfolkName: 'Doe Household' }, ...docs },
      queryDocs: { 'families/3/bookings/b1/kinCares': children },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    return ctx;
  }
  const approve = (startTimes?: Record<string, number>) =>
    approveBookingSeriesCore({ kinfolkId: '3', batchId: 'b1', actorUid: 'admin1', actorRole: 'AUNTIE', startTimes });
  const visit = (id: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({
    id,
    data: { status: 'requested', startTime: start, endTime: end, kinIds: [], serviceType: 'walk', ...extra },
  });

  it('refuses a request that waited until its visit went by, before writing anything', async () => {
    const ctx = seed([visit('v1', '2026-11-05T15:00:00Z', '2026-11-05T16:00:00Z')]);
    await expect(approve()).rejects.toMatchObject(refusal);
    expect(ctx.writes).toHaveLength(0);
  });

  it('refuses the whole request when one of its visits has passed, and books none of them', async () => {
    const ctx = seed([
      visit('v1', '2026-11-06T15:00:00Z', '2026-11-06T16:00:00Z'),
      visit('v2', '2026-11-09T15:00:00Z', '2026-11-09T16:00:00Z'),
    ]);
    await expect(approve()).rejects.toMatchObject(refusal);
    expect(ctx.writes).toHaveLength(0);
  });

  it('still books a request whose visits are all ahead', async () => {
    const ctx = seed([visit('v1', '2026-11-09T15:00:00Z', '2026-11-09T16:00:00Z')]);
    const r = await approve();
    expect(r.envelopeStatus).toBe('confirmed');
    expect(ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_v1')?.data.status).toBe('SCHEDULED');
  });

  it('ignores a past visit the household called off', async () => {
    const ctx = seed([
      visit('v1', '2026-11-05T15:00:00Z', '2026-11-05T16:00:00Z', { status: 'cancelled' }),
      visit('v2', '2026-11-09T15:00:00Z', '2026-11-09T16:00:00Z'),
    ]);
    const r = await approve();
    expect(r.sessionsCreated).toBe(1);
    expect(ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_v1')).toBeUndefined();
  });

  it('does not refuse re-approving a request already booked, though its visit has since passed', async () => {
    seed(
      [visit('v1', '2026-11-05T15:00:00Z', '2026-11-05T16:00:00Z', { status: 'confirmed', sessionId: 'vis_v1' })],
      { 'kin_care_sessions/vis_v1': { status: 'COMPLETED' } },
    );
    await expect(approve()).resolves.toMatchObject({ found: true, sessionsCreated: 0 });
  });

  it('does not refuse a retry whose past visit already has its session from an earlier pass', async () => {
    seed([visit('v1', '2026-11-05T15:00:00Z', '2026-11-05T16:00:00Z')], {
      'kin_care_sessions/vis_v1': { status: 'SCHEDULED' },
    });
    await expect(approve()).resolves.toMatchObject({ found: true, sessionsCreated: 0 });
  });

  it('refuses a start the operator picks for a night when that start has passed', async () => {
    const ctx = seed([
      {
        id: 'n1',
        data: {
          status: 'requested',
          startTimePending: true,
          requestedDate: '2026-11-06',
          kinIds: [],
          serviceType: 'Overnight',
          serviceId: 'Overnight',
        },
      },
    ]);
    await expect(approve({ n1: Date.parse('2026-11-06T19:00:00Z') })).rejects.toMatchObject(refusal);
    expect(ctx.writes).toHaveLength(0);
  });
});
