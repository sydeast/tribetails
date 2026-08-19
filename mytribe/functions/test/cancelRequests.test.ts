import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { callableRequest } from './_helpers/callableRequest';

/**
 * The office's end of the kinfolk cancellation ask (#438).
 *
 * Three assertions carry the design. First: accepting writes BOTH records, the
 * kinCares doc the portal reads and the flat `kin_care_sessions` row the admin
 * schedule reads, in the two different status vocabularies those collections
 * use. A one-sided write is the trap PR #436 documents for reschedule, and it
 * ends with the household believing a visit is cancelled while the schedule
 * still books an Auntie for it.
 *
 * Second: a request written before this issue carries `cancelRequestedAt` and
 * NO status field, because the status arrives with #438. Those are the July
 * backlog, and they have to be listable and resolvable, so the "is it pending"
 * test is not a status-equality test anywhere.
 *
 * Third: accepting closes any reschedule ask still open on the same visit,
 * because that queue filters on its own status and would otherwise keep asking
 * an operator to move a visit that no longer happens.
 *
 * Authorisation is `wrapAdminCallable`, which these tests do not exercise
 * because they call the handler directly, the convention in this suite. The
 * gate is asserted once, over the wrapper, in wrapAdminCallable.test.ts; what
 * is asserted here is the handler's own unauthenticated refusal.
 */
const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  writeAuditEntryFn: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__SERVER_TS__' } };
});

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.writeAuditEntryFn.mockReset();
  mocks.writeAuditEntryFn.mockResolvedValue('audit-id');
});

const VISIT = 'families/f1/bookings/b1/kinCares/v1';
const START_MS = Date.UTC(2026, 7, 20, 9, 0, 0);
const REQUESTED_AT_MS = Date.UTC(2026, 6, 4, 12, 0, 0);

/** A Timestamp-shaped value with the two methods the handler calls. */
const ts = (ms: number) => ({ toMillis: () => ms, toDate: () => new Date(ms) });

function pendingVisit(extra: Record<string, unknown> = {}) {
  return {
    status: 'confirmed',
    startTime: ts(START_MS),
    cancelRequestedAt: ts(REQUESTED_AT_MS),
    cancelRequestStatus: 'pending',
    cancelRequestReason: 'We are away that week',
    ...extra,
  };
}

/** The shape a request written before #438 has: the stamp, and nothing else. */
function legacyVisit(extra: Record<string, unknown> = {}) {
  return {
    status: 'confirmed',
    startTime: ts(START_MS),
    cancelRequestedAt: ts(REQUESTED_AT_MS),
    cancelRequestReason: 'Booked a kennel instead',
    ...extra,
  };
}

const acceptArgs = { kinfolkId: 'f1', batchId: 'b1', visitId: 'v1', decision: 'accept' as const };
const operator = { uid: 'op-1', token: { admin: true } };

describe('resolveBookingCancellationRequestHandler', () => {
  it('rejects an unauthenticated caller', async () => {
    const { resolveBookingCancellationRequestHandler } = await import('../src/admin/cancelRequests');
    await expect(
      resolveBookingCancellationRequestHandler(callableRequest(acceptArgs)),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('accepting cancels the visit AND the flat session row', async () => {
    const ctx = buildDbMock({
      docs: {
        [VISIT]: pendingVisit(),
        'kin_care_sessions/vis_v1': { status: 'SCHEDULED' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveBookingCancellationRequestHandler } = await import('../src/admin/cancelRequests');

    const res = await resolveBookingCancellationRequestHandler(callableRequest(acceptArgs, operator));

    expect(res).toMatchObject({
      ok: true,
      decision: 'accept',
      status: 'cancelled',
      sessionUpdated: true,
      rescheduleRequestClosed: false,
    });

    const visitWrite = ctx.writes.find((w) => w.path === VISIT);
    expect(visitWrite?.data?.['status']).toBe('cancelled');
    expect(visitWrite?.data?.['cancelRequestStatus']).toBe('accepted');
    expect(visitWrite?.data?.['cancelResolvedByUid']).toBe('op-1');

    // Uppercase on the flat row, lowercase on the subcollection doc. Two
    // vocabularies, on purpose; see batchUpdateBookings.
    const sessionWrite = ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_v1');
    expect(sessionWrite?.data?.['status']).toBe('CANCELLED');
  });

  it('prefers the visit’s own sessionId over the derived vis_ id', async () => {
    const ctx = buildDbMock({
      docs: {
        [VISIT]: pendingVisit({ sessionId: 'sess-abc' }),
        'kin_care_sessions/sess-abc': { status: 'SCHEDULED' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveBookingCancellationRequestHandler } = await import('../src/admin/cancelRequests');
    const res = await resolveBookingCancellationRequestHandler(callableRequest(acceptArgs, operator));
    expect(res.sessionUpdated).toBe(true);
    expect(ctx.writes.some((w) => w.path === 'kin_care_sessions/sess-abc')).toBe(true);
  });

  it('still cancels the visit when no mirror session exists, and says so', async () => {
    const ctx = buildDbMock({ docs: { [VISIT]: pendingVisit({ status: 'requested' }) } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveBookingCancellationRequestHandler } = await import('../src/admin/cancelRequests');
    const res = await resolveBookingCancellationRequestHandler(callableRequest(acceptArgs, operator));
    expect(res.sessionUpdated).toBe(false);
    expect(ctx.writes.filter((w) => w.path.startsWith('kin_care_sessions/'))).toHaveLength(0);
    expect(ctx.writes.find((w) => w.path === VISIT)?.data?.['status']).toBe('cancelled');
  });

  it('accepting resolves a request that predates the status field', async () => {
    const ctx = buildDbMock({ docs: { [VISIT]: legacyVisit() } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveBookingCancellationRequestHandler } = await import('../src/admin/cancelRequests');
    const res = await resolveBookingCancellationRequestHandler(callableRequest(acceptArgs, operator));
    expect(res.status).toBe('cancelled');
    expect(ctx.writes.find((w) => w.path === VISIT)?.data?.['cancelRequestStatus']).toBe('accepted');
  });

  it('accepting closes a reschedule request still open on the same visit', async () => {
    const ctx = buildDbMock({
      docs: { [VISIT]: pendingVisit({ rescheduleRequestStatus: 'pending' }) },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveBookingCancellationRequestHandler } = await import('../src/admin/cancelRequests');
    const res = await resolveBookingCancellationRequestHandler(callableRequest(acceptArgs, operator));
    expect(res.rescheduleRequestClosed).toBe(true);
    const write = ctx.writes.find((w) => w.path === VISIT);
    expect(write?.data?.['rescheduleRequestStatus']).toBe('declined');
    expect(write?.data?.['rescheduleResponseNote']).toContain('cancelled');
  });

  it('declining records the answer and leaves the visit on the schedule', async () => {
    const ctx = buildDbMock({
      docs: { [VISIT]: pendingVisit(), 'kin_care_sessions/vis_v1': { status: 'SCHEDULED' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveBookingCancellationRequestHandler } = await import('../src/admin/cancelRequests');
    const res = await resolveBookingCancellationRequestHandler(
      callableRequest(
        { ...acceptArgs, decision: 'decline', note: 'We are inside the 48-hour window.' },
        operator,
      ),
    );
    expect(res).toMatchObject({ decision: 'decline', status: 'confirmed', sessionUpdated: false });
    const write = ctx.writes.find((w) => w.path === VISIT);
    expect(write?.data?.['cancelRequestStatus']).toBe('declined');
    expect(write?.data?.['cancelResponseNote']).toBe('We are inside the 48-hour window.');
    expect(write?.data).not.toHaveProperty('status');
    // The flat row is untouched: nothing about the visit changed.
    expect(ctx.writes.filter((w) => w.path.startsWith('kin_care_sessions/'))).toHaveLength(0);
  });

  it('refuses a decline with no reason', async () => {
    const ctx = buildDbMock({ docs: { [VISIT]: pendingVisit() } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveBookingCancellationRequestHandler } = await import('../src/admin/cancelRequests');
    await expect(
      resolveBookingCancellationRequestHandler(
        callableRequest({ ...acceptArgs, decision: 'decline' }, operator),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('refuses an unknown decision', async () => {
    const ctx = buildDbMock({ docs: { [VISIT]: pendingVisit() } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveBookingCancellationRequestHandler } = await import('../src/admin/cancelRequests');
    await expect(
      resolveBookingCancellationRequestHandler(
        callableRequest({ ...acceptArgs, decision: 'maybe' }, operator),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('refuses a visit with no request waiting', async () => {
    const ctx = buildDbMock({ docs: { [VISIT]: { status: 'confirmed' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveBookingCancellationRequestHandler } = await import('../src/admin/cancelRequests');
    await expect(
      resolveBookingCancellationRequestHandler(callableRequest(acceptArgs, operator)),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('refuses a request that has already been ruled on', async () => {
    const ctx = buildDbMock({
      docs: { [VISIT]: pendingVisit({ cancelRequestStatus: 'declined' }) },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { resolveBookingCancellationRequestHandler } = await import('../src/admin/cancelRequests');
    await expect(
      resolveBookingCancellationRequestHandler(callableRequest(acceptArgs, operator)),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('reports a visit that does not exist as not-found', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: {} }).db);
    const { resolveBookingCancellationRequestHandler } = await import('../src/admin/cancelRequests');
    await expect(
      resolveBookingCancellationRequestHandler(callableRequest(acceptArgs, operator)),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('listCancelRequestsHandler', () => {
  it('rejects an unauthenticated caller', async () => {
    const { listCancelRequestsHandler } = await import('../src/admin/cancelRequests');
    await expect(listCancelRequestsHandler(callableRequest({}))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('returns the waiting queue with the household and the visit window on each row', async () => {
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
              endTime: ts(START_MS + 3_600_000),
            },
          },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { listCancelRequestsHandler } = await import('../src/admin/cancelRequests');
    const res = await listCancelRequestsHandler(callableRequest({}, operator));

    expect(res.requests).toHaveLength(1);
    expect(res.requests[0]).toMatchObject({
      kinfolkId: 'f1',
      batchId: 'b1',
      visitId: 'v1',
      title: 'Morning drop-in',
      kinNames: ['Biscuit'],
      status: 'confirmed',
      startTimeMs: START_MS,
      endTimeMs: START_MS + 3_600_000,
      reason: 'We are away that week',
      requestedAtMs: REQUESTED_AT_MS,
    });
  });

  it('lists the July backlog: a request with the stamp and no status field', async () => {
    const ctx = buildDbMock({
      collectionGroupDocs: {
        kinCares: [{ id: 'v1', path: VISIT, data: legacyVisit() }],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { listCancelRequestsHandler } = await import('../src/admin/cancelRequests');
    const res = await listCancelRequestsHandler(callableRequest({}, operator));
    expect(res.requests).toHaveLength(1);
    expect(res.requests[0]!.reason).toBe('Booked a kennel instead');
  });

  it('drops requests that have already been accepted or declined', async () => {
    const ctx = buildDbMock({
      collectionGroupDocs: {
        kinCares: [
          {
            id: 'v1',
            path: VISIT,
            data: pendingVisit({ cancelRequestStatus: 'accepted', status: 'cancelled' }),
          },
          {
            id: 'v2',
            path: 'families/f1/bookings/b1/kinCares/v2',
            data: pendingVisit({ cancelRequestStatus: 'declined' }),
          },
          { id: 'v3', path: 'families/f2/bookings/b9/kinCares/v3', data: pendingVisit() },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { listCancelRequestsHandler } = await import('../src/admin/cancelRequests');
    const res = await listCancelRequestsHandler(callableRequest({}, operator));
    expect(res.requests.map((r) => r.visitId)).toEqual(['v3']);
  });

  it('ignores visits that never carried a cancellation ask', async () => {
    const ctx = buildDbMock({
      collectionGroupDocs: {
        kinCares: [{ id: 'v9', path: 'families/f3/bookings/b3/kinCares/v9', data: { status: 'confirmed' } }],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { listCancelRequestsHandler } = await import('../src/admin/cancelRequests');
    const res = await listCancelRequestsHandler(callableRequest({}, operator));
    expect(res.requests).toEqual([]);
  });

  it('honours the caller’s limit after the resolved rows are dropped', async () => {
    const rows = [1, 2, 3].map((n) => ({
      id: `v${n}`,
      path: `families/f${n}/bookings/b${n}/kinCares/v${n}`,
      data: pendingVisit({ cancelRequestedAt: ts(REQUESTED_AT_MS + n) }),
    }));
    const ctx = buildDbMock({ collectionGroupDocs: { kinCares: rows } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { listCancelRequestsHandler } = await import('../src/admin/cancelRequests');
    const res = await listCancelRequestsHandler(callableRequest({ limit: 2 }, operator));
    // Oldest first: the household that has been waiting longest is answered first.
    expect(res.requests.map((r) => r.visitId)).toEqual(['v1', 'v2']);
  });

  it('refuses a limit outside the allowed range', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ collectionGroupDocs: { kinCares: [] } }).db);
    const { listCancelRequestsHandler } = await import('../src/admin/cancelRequests');
    await expect(
      listCancelRequestsHandler(callableRequest({ limit: 5000 }, operator)),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('returns an empty queue rather than failing when nothing is waiting', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ collectionGroupDocs: { kinCares: [] } }).db);
    const { listCancelRequestsHandler } = await import('../src/admin/cancelRequests');
    const res = await listCancelRequestsHandler(callableRequest({}, operator));
    expect(res.requests).toEqual([]);
  });
});
