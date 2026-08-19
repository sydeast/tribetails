import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { callableRequest } from './_helpers/callableRequest';

/**
 * #399 item 2: a kinfolk PROPOSES a new time. The load-bearing assertion in
 * this file is the one that says the visit did not move. Before this callable
 * existed the portal's "Reschedule visit" control was an inert span, and the
 * only thing that could have made it work was handing the household
 * `admin/rescheduleBooking`, which writes the schedule directly.
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
    Timestamp: {
      fromMillis: (ms: number) => ({ __ms: ms, toMillis: () => ms }),
    },
  };
});

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.writeAuditEntryFn.mockReset();
  mocks.writeAuditEntryFn.mockResolvedValue('audit-id');
});

const VISIT = 'families/f1/bookings/b1/kinCares/v1';
const HOUR = 60 * 60 * 1000;
const tomorrow = () => Date.now() + 24 * HOUR;

/** A Timestamp-shaped value the handler's `toMillis()` reads. */
const ts = (ms: number) => ({ toMillis: () => ms });

function args(overrides: Record<string, unknown> = {}) {
  return {
    kinfolkId: 'f1',
    batchId: 'b1',
    visitId: 'v1',
    proposedStartTimeMs: tomorrow(),
    reason: 'Flight moved',
    ...overrides,
  };
}

describe('requestBookingRescheduleHandler', () => {
  it('rejects an unauthenticated caller', async () => {
    const { requestBookingRescheduleHandler } = await import('../src/portal/requestBookingReschedule');
    await expect(requestBookingRescheduleHandler(callableRequest(args()))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('records the proposal WITHOUT moving the visit or changing its status', async () => {
    const start = Date.now() + 48 * HOUR;
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['f1'] },
        [VISIT]: { status: 'confirmed', startTime: ts(start), endTime: ts(start + HOUR) },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingRescheduleHandler } = await import('../src/portal/requestBookingReschedule');

    const proposed = Date.now() + 72 * HOUR;
    const res = await requestBookingRescheduleHandler(
      callableRequest(args({ proposedStartTimeMs: proposed }), { uid: 'u1' }),
    );

    expect(res.ok).toBe(true);
    expect(res.proposedStartTimeMs).toBe(proposed);
    // Duration carried over from the visit, since no end was proposed.
    expect(res.proposedEndTimeMs).toBe(proposed + HOUR);

    const write = ctx.writes.find((w) => w.path === VISIT);
    expect(write?.data?.['rescheduleRequestStatus']).toBe('pending');
    expect(write?.data?.['rescheduleRequestedByUid']).toBe('u1');
    expect(write?.data?.['rescheduleRequestReason']).toBe('Flight moved');
    expect(write?.data?.['rescheduleRequestedAt']).toBe('__SERVER_TS__');
    // THE POINT: the schedule is untouched.
    expect(write?.data).not.toHaveProperty('startTime');
    expect(write?.data).not.toHaveProperty('endTime');
    expect(write?.data).not.toHaveProperty('status');
  });

  it('honours an explicit proposed end', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['f1'] }, [VISIT]: { status: 'requested' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingRescheduleHandler } = await import('../src/portal/requestBookingReschedule');
    const start = Date.now() + 5 * HOUR;
    const res = await requestBookingRescheduleHandler(
      callableRequest(args({ proposedStartTimeMs: start, proposedEndTimeMs: start + 2 * HOUR }), { uid: 'u1' }),
    );
    expect(res.proposedEndTimeMs).toBe(start + 2 * HOUR);
  });

  it('leaves the proposed end null when the visit has no end on record', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['f1'] }, [VISIT]: { status: 'confirmed', startTime: ts(Date.now()) } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingRescheduleHandler } = await import('../src/portal/requestBookingReschedule');
    const res = await requestBookingRescheduleHandler(callableRequest(args(), { uid: 'u1' }));
    expect(res.proposedEndTimeMs).toBeNull();
  });

  it('refuses a time in the past', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['f1'] }, [VISIT]: { status: 'confirmed' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingRescheduleHandler } = await import('../src/portal/requestBookingReschedule');
    await expect(
      requestBookingRescheduleHandler(
        callableRequest(args({ proposedStartTimeMs: Date.now() - HOUR }), { uid: 'u1' }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('refuses a time more than a year out', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['f1'] }, [VISIT]: { status: 'confirmed' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingRescheduleHandler } = await import('../src/portal/requestBookingReschedule');
    await expect(
      requestBookingRescheduleHandler(
        callableRequest(args({ proposedStartTimeMs: Date.now() + 400 * 24 * HOUR }), { uid: 'u1' }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('refuses an end that is not after the start', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['f1'] }, [VISIT]: { status: 'confirmed' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingRescheduleHandler } = await import('../src/portal/requestBookingReschedule');
    const start = tomorrow();
    await expect(
      requestBookingRescheduleHandler(
        callableRequest(args({ proposedStartTimeMs: start, proposedEndTimeMs: start }), { uid: 'u1' }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('reports a missing batchId as a validation failure, not a crash', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['f1'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingRescheduleHandler } = await import('../src/portal/requestBookingReschedule');
    await expect(
      requestBookingRescheduleHandler(
        callableRequest({ visitId: 'v1', proposedStartTimeMs: tomorrow() }, { uid: 'u1' }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('refuses a completed visit', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['f1'] }, [VISIT]: { status: 'completed' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingRescheduleHandler } = await import('../src/portal/requestBookingReschedule');
    await expect(requestBookingRescheduleHandler(callableRequest(args(), { uid: 'u1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });

  it('refuses a second proposal while one is pending, rather than overwriting it', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['f1'] },
        [VISIT]: { status: 'confirmed', rescheduleRequestStatus: 'pending' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingRescheduleHandler } = await import('../src/portal/requestBookingReschedule');
    await expect(requestBookingRescheduleHandler(callableRequest(args(), { uid: 'u1' }))).rejects.toMatchObject({
      code: 'already-exists',
    });
    expect(ctx.writes).toHaveLength(0);
  });

  it('allows a fresh proposal after a decline, and clears the old answer', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['f1'] },
        [VISIT]: {
          status: 'confirmed',
          rescheduleRequestStatus: 'declined',
          rescheduleResponseNote: 'That morning is full.',
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingRescheduleHandler } = await import('../src/portal/requestBookingReschedule');
    await requestBookingRescheduleHandler(callableRequest(args(), { uid: 'u1' }));
    const write = ctx.writes.find((w) => w.path === VISIT);
    expect(write?.data?.['rescheduleRequestStatus']).toBe('pending');
    expect(write?.data?.['rescheduleResponseNote']).toBeNull();
    expect(write?.data?.['rescheduleResolvedAt']).toBeNull();
  });

  it("denies a visit outside the caller's own households", async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { kinfolkIds: ['OTHER'] }, [VISIT]: { status: 'confirmed' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingRescheduleHandler } = await import('../src/portal/requestBookingReschedule');
    await expect(requestBookingRescheduleHandler(callableRequest(args(), { uid: 'u1' }))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(ctx.writes).toHaveLength(0);
  });

  it('reports a visit that does not exist as not-found', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['f1'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingRescheduleHandler } = await import('../src/portal/requestBookingReschedule');
    await expect(requestBookingRescheduleHandler(callableRequest(args(), { uid: 'u1' }))).rejects.toMatchObject({
      code: 'not-found',
    });
  });
});
