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

  it('resolves real kin names onto the session it creates (not kinNames: [])', async () => {
    const ctx = buildDbMock({
      docs: {
        'families/3/bookings/b1': { kinfolkName: 'Doe Household' },
        'families/3/kin/k1': { name: 'Fido' },
      },
      queryDocs: {
        'families/3/bookings/b1/kinCares': [
          { id: 'v1', data: { startTime: '2026-07-01T10:00:00Z', endTime: '2026-07-01T11:00:00Z', kinIds: ['k1'], serviceType: 'walk' } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { approveBookingSeriesCore } = await import('../src/admin/approveBookingSeriesCore');

    await approveBookingSeriesCore({ kinfolkId: '3', batchId: 'b1', actorUid: 'sys', actorRole: 'SYSTEM' });

    const s1 = ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_v1');
    expect(s1?.data.kinIds).toEqual(['k1']);
    expect(s1?.data.kinNames).toEqual(['Fido']);
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

  // `toIso` degrades anything it cannot read to ''. Every window over
  // kin_care_sessions is a LEXICAL range on the ISO string, so a session
  // stored with startTime '' sorts before every real date and is invisible to
  // listUninvoicedSessions, optimizeRoute and the calendar push. It is a real
  // visit that can never be billed, and nothing raises. These pin the refusal.
  for (const [label, startTime] of [
    ['missing', undefined],
    ['null', null],
    ['a number the SDK never returns', 1_767_000_000_000],
    ['an object that is not a Timestamp', { seconds: 1 }],
  ] as Array<[string, unknown]>) {
    it(`refuses to create an unbillable session when startTime is ${label}`, async () => {
      const ctx = buildDbMock({
        docs: { 'families/3/bookings/b1': { kinfolkName: 'Doe Household' } },
        queryDocs: {
          'families/3/bookings/b1/kinCares': [
            { id: 'v1', data: { startTime, endTime: '2026-07-01T11:00:00Z', kinIds: ['k1'], serviceType: 'walk' } },
          ],
        },
      });
      mocks.dbFn.mockReturnValue(ctx.db);
      const { approveBookingSeriesCore } = await import('../src/admin/approveBookingSeriesCore');

      const r = await approveBookingSeriesCore({ kinfolkId: '3', batchId: 'b1', actorUid: 'sys', actorRole: 'SYSTEM' });

      // No session doc at all. A missing visit the operator can see beats an
      // invisible one they cannot.
      expect(ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_v1')).toBeUndefined();
      expect(r.sessionsCreated).toBe(0);
      expect(r.failedVisits).toBe(1);
      // The child is NOT flipped to confirmed, so a retry can still fix it.
      expect(ctx.writes.find((w) => w.path === 'families/3/bookings/b1/kinCares/v1')).toBeUndefined();
      // And the envelope refuses to claim it is done.
      expect(r.envelopeStatus).toBe('requested');
    });
  }

  it('one unreadable visit does not stop the readable ones in the same batch', async () => {
    const ctx = buildDbMock({
      docs: { 'families/3/bookings/b1': { kinfolkName: 'Doe Household' } },
      queryDocs: {
        'families/3/bookings/b1/kinCares': [
          { id: 'bad', data: { startTime: null, endTime: '2026-07-01T11:00:00Z', kinIds: [], serviceType: 'walk' } },
          { id: 'good', data: { startTime: '2026-07-02T10:00:00Z', endTime: '2026-07-02T11:00:00Z', kinIds: [], serviceType: 'walk' } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { approveBookingSeriesCore } = await import('../src/admin/approveBookingSeriesCore');

    const r = await approveBookingSeriesCore({ kinfolkId: '3', batchId: 'b1', actorUid: 'sys', actorRole: 'SYSTEM' });

    expect(ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_good')).toBeDefined();
    expect(ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_bad')).toBeUndefined();
    expect(r.sessionsCreated).toBe(1);
    expect(r.failedVisits).toBe(1);
    expect(r.envelopeStatus).toBe('requested');
  });
});
