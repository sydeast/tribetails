import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
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

describe('requestBookingHandler', () => {
  it('rejects unauth', async () => {
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    await expect(requestBookingHandler({ data: { serviceType: 'walk', startTimeMs: Date.now() }, auth: undefined } as any)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects when endTime <= startTime', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const t = Date.now();
    await expect(
      requestBookingHandler({ data: { serviceType: 'walk', startTimeMs: t, endTimeMs: t - 1, kinfolkId: '3' }, auth: { uid: 'u1' } } as any),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('writes ONE parent envelope + ONE kinCare for a legacy single-visit submit', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const t = Date.now() + 60_000;
    const res: any = await requestBookingHandler({ data: { serviceType: 'walk', title: 'AM walk', startTimeMs: t, kinfolkId: '3', notes: 'short' }, auth: { uid: 'u1' } } as any);

    expect(res.batchId).toBeTypeOf('string');
    expect(res.bookingId).toBe(res.batchId);
    expect(res.bookingIds).toEqual([res.batchId]);

    // Everything happened inside one transaction → recorded as `writes`.
    expect(ctx.adds).toHaveLength(0);
    const parentWrites = ctx.writes.filter((w) => w.path === `families/3/bookings/${res.batchId}`);
    const visitWrites = ctx.writes.filter((w) =>
      w.path.startsWith(`families/3/bookings/${res.batchId}/kinCares/`),
    );
    expect(parentWrites).toHaveLength(1);
    expect(visitWrites).toHaveLength(1);

    const parent = parentWrites[0].data;
    expect(parent.envelopeStatus).toBe('requested');
    expect(parent.targetType).toBe('KIN');
    expect(parent.requestBatchId).toBe(res.batchId);
    expect(parent.familyId).toBe('3');
    expect(parent.requestedByUid).toBe('u1');
    expect(parent.visitCount).toBe(1);
    expect(parent.notes).toBe('short');
    expect(parent.firstStartTime).toBeInstanceOf(Timestamp);
    expect(parent.lastStartTime).toBeInstanceOf(Timestamp);

    const visit = visitWrites[0].data;
    expect(visit.status).toBe('requested');
    expect(visit.visitProgress).toBeNull();
    expect(visit.batchId).toBe(res.batchId);
    expect(visit.familyId).toBe('3');
    expect(visit.requestedByUid).toBe('u1');
    expect(visit.serviceName).toBe('walk');
    expect(visit.serviceType).toBe('walk');
    expect(visit.sourceBookingId).toBeNull();
    expect(visit.sessionId).toBeNull();
    expect(visit.auntieDisplayName).toBeNull();
  });

  it('emits BOOKING_SUBMITTED audit with the parent-doc targetCollection', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { requestBookingHandler } = await import('../src/portal/requestBooking');
    const t = Date.now() + 60_000;
    const res: any = await requestBookingHandler({ data: { serviceType: 'walk', startTimeMs: t, kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
    expect(mocks.writeAuditEntryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'BOOKING_SUBMITTED',
        actorRole: 'PRIMARY',
        actorUid: 'u1',
        targetCollection: `families/3/bookings/${res.batchId}`,
      }),
    );
  });
});
