import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { callableRequest } from './_helpers/callableRequest';

/**
 * The office's end of the kinfolk reschedule ask (#399 item 2).
 *
 * Two assertions here carry the design. First: accepting writes BOTH records,
 * the kinCares doc the portal reads and the flat `kin_care_sessions` row the
 * admin schedule reads, because `admin/rescheduleBooking` only ever wrote the
 * second and a visit moved through it alone still reads at its old time in the
 * portal. Second: the mirror is written only when it exists, and its id is
 * `vis_{visitId}` unless the visit carries its own, the same rule
 * batchUpdateBookings follows.
 *
 * Authorisation is `wrapAdminCallable`, which these tests do not exercise
 * because they call the handler directly, the convention in this suite. The
 * gate is asserted once, over the wrapper, in wrapAdminCallable.test.ts.
 */
const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  writeAuditEntryFn: vi.fn(),
  guardCompanyHolidayConflictFn: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));
vi.mock('../src/lib/companyHolidayConflict', () => ({
  guardCompanyHolidayConflict: mocks.guardCompanyHolidayConflictFn,
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__SERVER_TS__' } };
});

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.writeAuditEntryFn.mockReset();
  mocks.writeAuditEntryFn.mockResolvedValue('audit-id');
  mocks.guardCompanyHolidayConflictFn.mockReset();
  mocks.guardCompanyHolidayConflictFn.mockResolvedValue(undefined);
});

const VISIT = 'families/f1/bookings/b1/kinCares/v1';
const NEW_START_MS = Date.UTC(2026, 8, 1, 15, 0, 0);
const NEW_END_MS = NEW_START_MS + 60 * 60 * 1000;

/** A Timestamp-shaped value with the two methods the handler calls. */
const ts = (ms: number) => ({ toMillis: () => ms, toDate: () => new Date(ms) });

function pendingVisit(extra: Record<string, unknown> = {}) {
  return {
    status: 'confirmed',
    startTime: ts(Date.UTC(2026, 7, 20, 9, 0, 0)),
    rescheduleRequestStatus: 'pending',
    rescheduleRequestedStartTime: ts(NEW_START_MS),
    rescheduleRequestedEndTime: ts(NEW_END_MS),
    rescheduleRequestReason: 'Flight moved',
    ...extra,
  };
}

const acceptArgs = { kinfolkId: 'f1', batchId: 'b1', visitId: 'v1', decision: 'accept' as const };

describe('resolveBookingRescheduleRequestHandler', () => {
  it('rejects an unauthenticated caller', async () => {
    const { resolveBookingRescheduleRequestHandler } = await import('../src/admin/rescheduleRequests');
    await expect(
      resolveBookingRescheduleRequestHandler(callableRequest(acceptArgs)),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('accepting moves the visit AND the flat session row', async () => {
    const ctx = buildDbMock({
      docs: {
        [VISIT]: pendingVisit(),
        'kin_care_sessions/vis_v1': { startTime: '2026-08-20T09:00:00.000Z' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveBookingRescheduleRequestHandler } = await import('../src/admin/rescheduleRequests');

    const res = await resolveBookingRescheduleRequestHandler(
      callableRequest(acceptArgs, { uid: 'op-1', token: { admin: true } }),
    );

    expect(res).toMatchObject({ ok: true, decision: 'accept', startTimeMs: NEW_START_MS, sessionUpdated: true });

    const visitWrite = ctx.writes.find((w) => w.path === VISIT);
    expect(visitWrite?.data?.['rescheduleRequestStatus']).toBe('accepted');
    expect((visitWrite?.data?.['startTime'] as { toMillis: () => number }).toMillis()).toBe(NEW_START_MS);

    const sessionWrite = ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_v1');
    // ISO on the flat row, Timestamp on the subcollection doc. Two shapes, on purpose.
    expect(sessionWrite?.data?.['startTime']).toBe(new Date(NEW_START_MS).toISOString());
    expect(sessionWrite?.data?.['endTime']).toBe(new Date(NEW_END_MS).toISOString());
  });

  it('prefers the visit’s own sessionId over the derived vis_ id', async () => {
    const ctx = buildDbMock({
      docs: {
        [VISIT]: pendingVisit({ sessionId: 'sess-abc' }),
        'kin_care_sessions/sess-abc': { startTime: '2026-08-20T09:00:00.000Z' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveBookingRescheduleRequestHandler } = await import('../src/admin/rescheduleRequests');
    const res = await resolveBookingRescheduleRequestHandler(
      callableRequest(acceptArgs, { uid: 'op-1', token: { admin: true } }),
    );
    expect(res.sessionUpdated).toBe(true);
    expect(ctx.writes.some((w) => w.path === 'kin_care_sessions/sess-abc')).toBe(true);
  });

  it('still moves the visit when no mirror session exists, and says so', async () => {
    const ctx = buildDbMock({ docs: { [VISIT]: pendingVisit({ status: 'requested' }) } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveBookingRescheduleRequestHandler } = await import('../src/admin/rescheduleRequests');
    const res = await resolveBookingRescheduleRequestHandler(
      callableRequest(acceptArgs, { uid: 'op-1', token: { admin: true } }),
    );
    expect(res.sessionUpdated).toBe(false);
    expect(ctx.writes.filter((w) => w.path.startsWith('kin_care_sessions/'))).toHaveLength(0);
    expect(ctx.writes.find((w) => w.path === VISIT)?.data?.['rescheduleRequestStatus']).toBe('accepted');
  });

  it('refuses a proposal that lands on a company closure, before any write', async () => {
    mocks.guardCompanyHolidayConflictFn.mockRejectedValue(
      Object.assign(new Error('Tribe Tails is closed that day.'), { code: 'failed-precondition' }),
    );
    const ctx = buildDbMock({ docs: { [VISIT]: pendingVisit() } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveBookingRescheduleRequestHandler } = await import('../src/admin/rescheduleRequests');
    await expect(
      resolveBookingRescheduleRequestHandler(callableRequest(acceptArgs, { uid: 'op-1', token: { admin: true } })),
    ).rejects.toMatchObject({ message: 'Tribe Tails is closed that day.' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('declining records the answer and leaves the visit where it is', async () => {
    const ctx = buildDbMock({ docs: { [VISIT]: pendingVisit() } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveBookingRescheduleRequestHandler } = await import('../src/admin/rescheduleRequests');
    const res = await resolveBookingRescheduleRequestHandler(
      callableRequest(
        { ...acceptArgs, decision: 'decline', note: 'That morning is fully booked.' },
        { uid: 'op-1', token: { admin: true } },
      ),
    );
    expect(res.decision).toBe('decline');
    const write = ctx.writes.find((w) => w.path === VISIT);
    expect(write?.data?.['rescheduleRequestStatus']).toBe('declined');
    expect(write?.data?.['rescheduleResponseNote']).toBe('That morning is fully booked.');
    expect(write?.data).not.toHaveProperty('startTime');
  });

  it('refuses a decline with no reason', async () => {
    const ctx = buildDbMock({ docs: { [VISIT]: pendingVisit() } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveBookingRescheduleRequestHandler } = await import('../src/admin/rescheduleRequests');
    await expect(
      resolveBookingRescheduleRequestHandler(
        callableRequest({ ...acceptArgs, decision: 'decline' }, { uid: 'op-1', token: { admin: true } }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('refuses an unknown decision', async () => {
    const ctx = buildDbMock({ docs: { [VISIT]: pendingVisit() } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveBookingRescheduleRequestHandler } = await import('../src/admin/rescheduleRequests');
    await expect(
      resolveBookingRescheduleRequestHandler(
        callableRequest({ ...acceptArgs, decision: 'maybe' }, { uid: 'op-1', token: { admin: true } }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('refuses a visit with no request waiting', async () => {
    const ctx = buildDbMock({ docs: { [VISIT]: { status: 'confirmed' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveBookingRescheduleRequestHandler } = await import('../src/admin/rescheduleRequests');
    await expect(
      resolveBookingRescheduleRequestHandler(callableRequest(acceptArgs, { uid: 'op-1', token: { admin: true } })),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('reports a visit that does not exist as not-found', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: {} }).db);
    const { resolveBookingRescheduleRequestHandler } = await import('../src/admin/rescheduleRequests');
    await expect(
      resolveBookingRescheduleRequestHandler(callableRequest(acceptArgs, { uid: 'op-1', token: { admin: true } })),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('listRescheduleRequestsHandler', () => {
  it('rejects an unauthenticated caller', async () => {
    const { listRescheduleRequestsHandler } = await import('../src/admin/rescheduleRequests');
    await expect(listRescheduleRequestsHandler(callableRequest({}))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('returns the pending queue with the household and both windows on each row', async () => {
    const ctx = buildDbMock({
      collectionGroupDocs: {
        kinCares: [
          {
            id: 'v1',
            path: VISIT,
            data: {
              ...pendingVisit(),
              title: 'Morning drop-in',
              kinNames: ['Biscuit'],
              rescheduleRequestedAt: ts(1_700_000_000_000),
            },
          },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { listRescheduleRequestsHandler } = await import('../src/admin/rescheduleRequests');
    const res = await listRescheduleRequestsHandler(
      callableRequest({}, { uid: 'op-1', token: { admin: true } }),
    );

    expect(res.requests).toHaveLength(1);
    expect(res.requests[0]).toMatchObject({
      kinfolkId: 'f1',
      batchId: 'b1',
      visitId: 'v1',
      title: 'Morning drop-in',
      kinNames: ['Biscuit'],
      proposedStartTimeMs: NEW_START_MS,
      proposedEndTimeMs: NEW_END_MS,
      reason: 'Flight moved',
    });
  });

  it('refuses a limit outside the allowed range', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ collectionGroupDocs: { kinCares: [] } }).db);
    const { listRescheduleRequestsHandler } = await import('../src/admin/rescheduleRequests');
    await expect(
      listRescheduleRequestsHandler(callableRequest({ limit: 5000 }, { uid: 'op-1', token: { admin: true } })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('returns an empty queue rather than failing when nothing is waiting', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ collectionGroupDocs: { kinCares: [] } }).db);
    const { listRescheduleRequestsHandler } = await import('../src/admin/rescheduleRequests');
    const res = await listRescheduleRequestsHandler(
      callableRequest({}, { uid: 'op-1', token: { admin: true } }),
    );
    expect(res.requests).toEqual([]);
  });
});
