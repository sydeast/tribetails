import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), writeAuditEntryFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__SERVER_TS__' } };
});
beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.writeAuditEntryFn.mockReset();
  mocks.writeAuditEntryFn.mockResolvedValue('audit-id');
});

const VISIT = 'families/f1/bookings/b1/kinCares/v1';
const CALLER = { data: { kinfolkId: 'f1', batchId: 'b1', visitId: 'v1', reason: 'trip moved' }, auth: { uid: 'u1' } } as any;

// Vendor-parity (2026-07-02): kinfolk cancellation ask. Flag write, not a
// status change; onBookingsWrite fires kincare.cancel.requested off the flag.
describe('requestBookingCancellationHandler', () => {
  it('stamps the cancel-request flag on an upcoming confirmed visit', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['f1'] },
        [VISIT]: { status: 'confirmed' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingCancellationHandler } = await import('../src/portal/requestBookingCancellation');
    const res = await requestBookingCancellationHandler(CALLER);
    expect(res).toEqual({ ok: true, visitId: 'v1', alreadyPending: false });
    const write = ctx.writes.find((w) => w.path === VISIT);
    expect(write?.data?.cancelRequestedAt).toBe('__SERVER_TS__');
    expect(write?.data?.cancelRequestedByUid).toBe('u1');
    expect(write?.data?.cancelRequestReason).toBe('trip moved');
    // #438: the status the admin queue rules on. Without it the ask is
    // invisible to every admin surface, which is the defect that issue names.
    expect(write?.data?.cancelRequestStatus).toBe('pending');
  });

  it('is a no-op when a request is already pending', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['f1'] },
        [VISIT]: { status: 'confirmed', cancelRequestedAt: '__SERVER_TS__' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingCancellationHandler } = await import('../src/portal/requestBookingCancellation');
    const res = await requestBookingCancellationHandler(CALLER);
    expect(res.alreadyPending).toBe(true);
    expect(ctx.writes.find((w) => w.path === VISIT)).toBeFalsy();
  });

  it('is a no-op for a request written before the status field existed', async () => {
    // The July backlog: the stamp and nothing else. Still waiting on the
    // office, so a second ask must not overwrite it.
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['f1'] },
        [VISIT]: { status: 'confirmed', cancelRequestedAt: '__SERVER_TS__' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingCancellationHandler } = await import('../src/portal/requestBookingCancellation');
    const res = await requestBookingCancellationHandler(CALLER);
    expect(res.alreadyPending).toBe(true);
    expect(ctx.writes.find((w) => w.path === VISIT)).toBeFalsy();
  });

  it('lets a household ask again after the office declined, and clears the old answer', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['f1'] },
        [VISIT]: {
          status: 'confirmed',
          cancelRequestedAt: '__OLD_TS__',
          cancelRequestStatus: 'declined',
          cancelResponseNote: 'Inside the 48-hour window.',
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingCancellationHandler } = await import('../src/portal/requestBookingCancellation');
    const res = await requestBookingCancellationHandler(CALLER);
    expect(res.alreadyPending).toBe(false);
    const write = ctx.writes.find((w) => w.path === VISIT);
    expect(write?.data?.cancelRequestStatus).toBe('pending');
    expect(write?.data?.cancelResponseNote).toBeNull();
    expect(write?.data?.cancelResolvedAt).toBeNull();
  });

  it('rejects completed/cancelled visits', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['f1'] },
        [VISIT]: { status: 'completed' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingCancellationHandler } = await import('../src/portal/requestBookingCancellation');
    await expect(requestBookingCancellationHandler(CALLER)).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });

  it("denies a visit outside the caller's own households", async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['OTHER'] },
        [VISIT]: { status: 'confirmed' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingCancellationHandler } = await import('../src/portal/requestBookingCancellation');
    await expect(requestBookingCancellationHandler(CALLER)).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });
});

describe('listStaffHandler', () => {
  it('returns the staff roster sorted by display name', async () => {
    const ctx = buildDbMock({
      queryDocs: {
        staff: [
          { id: 'u2', data: { displayName: 'Zoe', email: 'z@t.com' } },
          { id: 'u1', data: { displayName: 'Amy' } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { listStaffHandler } = await import('../src/admin/listStaff');
    const res = await listStaffHandler({ data: {}, auth: { uid: 'a' } } as any);
    expect(res.staff.map((s) => s.displayName)).toEqual(['Amy', 'Zoe']);
    expect(res.staff[1]).toEqual({ uid: 'u2', displayName: 'Zoe', email: 'z@t.com' });
  });
});
