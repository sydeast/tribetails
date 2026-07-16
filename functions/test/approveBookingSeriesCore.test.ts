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

describe('approveBookingSeriesCore', () => {
  it('returns found=false when the parent envelope does not exist', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { approveBookingSeriesCore } = await import('../src/admin/approveBookingSeriesCore');
    const r = await approveBookingSeriesCore({ kinfolkId: '3', batchId: 'b1', actorUid: 'sys', actorRole: 'SYSTEM' });
    expect(r.found).toBe(false);
    expect(r.sessionsCreated).toBe(0);
    expect(ctx.writes).toHaveLength(0);
  });

  it('confirms every visit, creates one session each, rolls the envelope, audits', async () => {
    const ctx = buildDbMock({
      docs: { 'families/3/bookings/b1': { kinfolkName: 'Doe Household' } },
      queryDocs: {
        'families/3/bookings/b1/kinCares': [
          { id: 'v1', data: { startTime: '2026-07-01T10:00:00Z', endTime: '2026-07-01T11:00:00Z', kinIds: ['k1'], serviceType: 'walk', notes: 'AM' } },
          { id: 'v2', data: { startTime: '2026-07-02T10:00:00Z', endTime: '2026-07-02T10:30:00Z', kinIds: ['k1'], serviceType: 'walk' } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { approveBookingSeriesCore } = await import('../src/admin/approveBookingSeriesCore');

    const r = await approveBookingSeriesCore({ kinfolkId: '3', batchId: 'b1', actorUid: 'sys', actorRole: 'SYSTEM' });

    expect(r.found).toBe(true);
    expect(r.affectedVisits).toBe(2);
    expect(r.sessionsCreated).toBe(2);
    expect(r.failedVisits).toBe(0);
    expect(r.envelopeStatus).toBe('confirmed');

    // One kin_care_sessions doc per visit, deterministic vis_{id}.
    const s1 = ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_v1');
    const s2 = ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_v2');
    expect(s1?.data.status).toBe('SCHEDULED');
    expect(s1?.data.kinfolkName).toBe('Doe Household');
    expect(s1?.data.serviceDurationMinutes).toBe(60);
    expect(s1?.data.createdBy).toBe('sys');
    expect(s2?.data.serviceDurationMinutes).toBe(30);

    // Each child flipped to confirmed + linked to its session.
    const c1 = ctx.writes.find((w) => w.path === 'families/3/bookings/b1/kinCares/v1');
    expect(c1?.data.status).toBe('confirmed');
    expect(c1?.data.sessionId).toBe('vis_v1');

    // Envelope rolled.
    const env = ctx.writes.find((w) => w.path === 'families/3/bookings/b1');
    expect(env?.data.envelopeStatus).toBe('confirmed');
    expect(env?.data.confirmedCount).toBe(2);

    // Audited as an APPROVE.
    expect(mocks.writeAuditEntryFn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'APPROVE_BOOKING_SERIES', actorRole: 'SYSTEM' }),
    );
  });

  it('is idempotent: a re-approve with an existing session creates 0 sessions', async () => {
    const ctx = buildDbMock({
      docs: {
        'families/3/bookings/b1': { kinfolkName: 'Doe Household' },
        'kin_care_sessions/vis_v1': { status: 'SCHEDULED' }, // already exists
      },
      queryDocs: {
        'families/3/bookings/b1/kinCares': [
          { id: 'v1', data: { startTime: '2026-07-01T10:00:00Z', endTime: '2026-07-01T11:00:00Z', kinIds: [], serviceType: 'walk' } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { approveBookingSeriesCore } = await import('../src/admin/approveBookingSeriesCore');
    const r = await approveBookingSeriesCore({ kinfolkId: '3', batchId: 'b1', actorUid: 'sys', actorRole: 'SYSTEM' });
    expect(r.sessionsCreated).toBe(0);
    expect(r.affectedVisits).toBe(1);
  });
});
