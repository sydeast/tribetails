import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), writeAuditEntryFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
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

/**
 * C1: a closure added AFTER a request was submitted, but BEFORE it is
 * approved, must still stop the session from being created at APPROVE time --
 * this is the moment the real, billable kin_care_sessions doc appears. Each
 * visit is isolated (mirrors the busy-conflict re-check already covered in
 * approveBookingSeriesCore.test.ts): one visit landing on a closure fails
 * just that visit, the rest of the series still confirms.
 */
describe('approveBookingSeriesCore company-holiday re-check', () => {
  it('a visit whose date is closed fails in isolation; the other visit in the series still confirms', async () => {
    const ctx = buildDbMock({
      docs: {
        'families/3/bookings/b1': { kinfolkName: 'Doe Household' },
        'business_settings/business_settings': { companyHolidays: ['2026-12-25|Christmas'] },
      },
      queryDocs: {
        'families/3/bookings/b1/kinCares': [
          { id: 'v1', data: { startTime: '2026-12-25T10:00:00Z', endTime: '2026-12-25T11:00:00Z', kinIds: ['k1'], serviceType: 'walk' } },
          { id: 'v2', data: { startTime: '2026-12-26T10:00:00Z', endTime: '2026-12-26T11:00:00Z', kinIds: ['k1'], serviceType: 'walk' } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { approveBookingSeriesCore } = await import('../src/admin/approveBookingSeriesCore');

    const r = await approveBookingSeriesCore({ kinfolkId: '3', batchId: 'b1', actorUid: 'sys', actorRole: 'SYSTEM' });

    expect(r.found).toBe(true);
    expect(r.failedVisits).toBe(1);
    expect(r.sessionsCreated).toBe(1);
    expect(r.envelopeStatus).toBe('requested'); // partial failure never claims 'confirmed'

    expect(ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_v1')).toBeUndefined();
    const s2 = ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_v2');
    expect(s2?.data.status).toBe('SCHEDULED');

    // The failed visit's child doc is NOT flipped to confirmed.
    const c1 = ctx.writes.find((w) => w.path === 'families/3/bookings/b1/kinCares/v1');
    expect(c1).toBeUndefined();
  });

  it('no closures at all: every visit confirms as before', async () => {
    const ctx = buildDbMock({
      docs: { 'families/3/bookings/b1': { kinfolkName: 'Doe Household' } },
      queryDocs: {
        'families/3/bookings/b1/kinCares': [
          { id: 'v1', data: { startTime: '2026-12-25T10:00:00Z', endTime: '2026-12-25T11:00:00Z', kinIds: ['k1'], serviceType: 'walk' } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { approveBookingSeriesCore } = await import('../src/admin/approveBookingSeriesCore');

    const r = await approveBookingSeriesCore({ kinfolkId: '3', batchId: 'b1', actorUid: 'sys', actorRole: 'SYSTEM' });
    expect(r.failedVisits).toBe(0);
    expect(r.sessionsCreated).toBe(1);
    expect(r.envelopeStatus).toBe('confirmed');
  });
});
