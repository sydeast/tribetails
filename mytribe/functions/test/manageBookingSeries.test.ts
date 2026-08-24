import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__', delete: () => '__DELETE__' } };
});

import { manageBookingSeriesHandler } from '../src/admin/manageBookingSeries';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

beforeEach(() => {
  mocks.dbFn.mockReset();
  (writeAuditEntry as any).mockClear();
});

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } as any } as any) : undefined,
    rawRequest: {} as any, instanceIdToken: undefined, acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

/**
 * Wraps a buildDbMock() db so a doc write to `targetPath` throws, simulating
 * a per-visit failure inside the CANCEL loop's try/catch. Refs are created
 * fresh on every `.collection(x).doc(y)` call inside the handler, so this
 * intercepts at the db/collection factory level rather than mutating a
 * pre-built ref (there isn't one to grab ahead of time).
 */
function withThrowingSet(db: any, targetPaths: string[]) {
  function wrapRef(ref: any): any {
    if (targetPaths.includes(ref.path)) {
      return { ...ref, set: vi.fn(async () => { throw new Error('simulated write failure'); }) };
    }
    return { ...ref, collection: (sub: string) => wrapCollection(ref.collection(sub)) };
  }
  function wrapCollection(col: any): any {
    return { ...col, doc: (id?: string) => wrapRef(col.doc(id)) };
  }
  return {
    ...db,
    collection: (path: string) => wrapCollection(db.collection(path)),
    doc: (path: string) => wrapRef(db.doc(path)),
  };
}

function seed() {
  return buildDbMock({
    docs: { 'families/kf1/bookings/b1': { envelopeStatus: 'requested', visitCount: 2, confirmedCount: 0, cancelledCount: 0 } },
    queryDocs: {
      // Every writer of a kinCares child stamps startTime as a Timestamp:
      // requestBooking requires it through zod (`startTimeMs` positive int) and
      // writes `Timestamp.fromMillis`, and the sandbox seed does the same. A
      // child without one is a shape production cannot reach, and approve now
      // refuses it rather than minting a session no date window can ever find.
      'families/kf1/bookings/b1/kinCares': [
        { id: 'v1', data: { status: 'requested', startTime: { toDate: () => new Date('2026-06-03T09:00:00Z') } } },
        { id: 'v2', data: { status: 'requested', startTime: { toDate: () => new Date('2026-06-04T09:00:00Z') } } },
      ],
    },
  });
}

describe('manageBookingSeries', () => {
  it('APPROVE: sets envelope confirmed + every child visit confirmed', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await manageBookingSeriesHandler(req({ action: 'APPROVE', kinfolkId: 'kf1', batchId: 'b1' }));
    expect(res.ok).toBe(true);
    expect(res.affectedVisits).toBe(2);
    const parent = ctx.writes.find((w) => w.path === 'families/kf1/bookings/b1');
    expect(parent?.data.envelopeStatus).toBe('confirmed');
    expect(parent?.data.confirmedCount).toBe(2);
    expect(ctx.writes.find((w) => w.path === 'families/kf1/bookings/b1/kinCares/v1')?.data.status).toBe('confirmed');
    expect(ctx.writes.find((w) => w.path === 'families/kf1/bookings/b1/kinCares/v2')?.data.status).toBe('confirmed');
  });

  it('CANCEL: sets envelope cancelled + every child visit cancelled', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await manageBookingSeriesHandler(req({ action: 'CANCEL', kinfolkId: 'kf1', batchId: 'b1' }));
    expect(res.ok).toBe(true);
    const parent = ctx.writes.find((w) => w.path === 'families/kf1/bookings/b1');
    expect(parent?.data.envelopeStatus).toBe('cancelled');
    expect(parent?.data.cancelledCount).toBe(2);
    expect(ctx.writes.find((w) => w.path === 'families/kf1/bookings/b1/kinCares/v1')?.data.status).toBe('cancelled');
    const call = (writeAuditEntry as any).mock.calls.map((c: any[]) => c[0])
      .find((c: any) => c.event === 'CANCEL_BOOKING_SERIES');
    expect(call.status).toBe('SUCCESS');
  });

  it('writes an APPROVE_BOOKING_SERIES audit entry', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await manageBookingSeriesHandler(req({ action: 'APPROVE', kinfolkId: 'kf1', batchId: 'b1' }));
    const call = (writeAuditEntry as any).mock.calls.map((c: any[]) => c[0])
      .find((c: any) => c.event === 'APPROVE_BOOKING_SERIES');
    expect(call).toBeDefined();
  });

  // A4 audit follow-up: writeAuditEntry used to hardcode status: 'SUCCESS'
  // for CANCEL_BOOKING_SERIES regardless of failedVisits, so a cancel series
  // where every visit's write failed (0 cancelled) was still recorded as a
  // clean SUCCESS row. Same defect shape as batchUpdateBookings.
  it('audits CANCEL with status FAILURE, not SUCCESS, when every visit fails', async () => {
    const ctx = seed();
    const failingDb = withThrowingSet(ctx.db, [
      'families/kf1/bookings/b1/kinCares/v1',
      'families/kf1/bookings/b1/kinCares/v2',
    ]);
    mocks.dbFn.mockReturnValue(failingDb);
    const res = await manageBookingSeriesHandler(req({ action: 'CANCEL', kinfolkId: 'kf1', batchId: 'b1' }));
    expect(res.failedVisits).toBe(2);
    const call = (writeAuditEntry as any).mock.calls.map((c: any[]) => c[0])
      .find((c: any) => c.event === 'CANCEL_BOOKING_SERIES');
    expect(call.status).toBe('FAILURE');
  });

  it('audits CANCEL with status FAILURE, not SUCCESS, on a partial failure', async () => {
    const ctx = seed();
    const failingDb = withThrowingSet(ctx.db, ['families/kf1/bookings/b1/kinCares/v1']);
    mocks.dbFn.mockReturnValue(failingDb);
    const res = await manageBookingSeriesHandler(req({ action: 'CANCEL', kinfolkId: 'kf1', batchId: 'b1' }));
    expect(res.failedVisits).toBe(1);
    const call = (writeAuditEntry as any).mock.calls.map((c: any[]) => c[0])
      .find((c: any) => c.event === 'CANCEL_BOOKING_SERIES');
    expect(call.status).toBe('FAILURE');
  });

  it('APPROVE: creates a deterministic linked session per visit + writes sessionId back', async () => {
    const ctx = buildDbMock({
      docs: { 'families/kf1/bookings/b1': { envelopeStatus: 'requested', kinfolkName: 'Jane Doe' } },
      queryDocs: {
        'families/kf1/bookings/b1/kinCares': [
          { id: 'v1', data: { status: 'requested', serviceType: 'Walk', kinIds: ['k1'], startTime: { toDate: () => new Date('2026-06-03T09:00:00Z') }, endTime: { toDate: () => new Date('2026-06-03T10:00:00Z') } } },
          // endTime is legitimately absent here, which is why the duration
          // assertion below expects 0 for this one. startTime is not optional.
          { id: 'v2', data: { status: 'requested', serviceType: 'Walk', kinIds: ['k1'], startTime: { toDate: () => new Date('2026-06-04T09:00:00Z') } } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await manageBookingSeriesHandler(req({ action: 'APPROVE', kinfolkId: 'kf1', batchId: 'b1' }));
    expect(res.sessionsCreated).toBe(2);
    expect(res.failedVisits).toBe(0);
    // deterministic session doc id vis_{visitId}
    const sess1 = ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_v1');
    expect(sess1?.data.status).toBe('SCHEDULED');
    expect(sess1?.data.kinCareBatchId).toBe('b1');
    expect(sess1?.data.kinfolkName).toBe('Jane Doe');
    // toIso: Firestore Timestamp -> ISO string + computed duration
    expect(sess1?.data.startTime).toBe('2026-06-03T09:00:00.000Z');
    expect(sess1?.data.serviceDurationMinutes).toBe(60);
    // sessionId written back onto the child = the deterministic id
    expect(ctx.writes.find((w) => w.path === 'families/kf1/bookings/b1/kinCares/v1')?.data.sessionId).toBe('vis_v1');
  });

  it('APPROVE is idempotent: an existing deterministic session creates none + dups impossible', async () => {
    const ctx = buildDbMock({
      docs: {
        'families/kf1/bookings/b1': { envelopeStatus: 'requested' },
        // session already at the deterministic id -> reuse, never create a second
        'kin_care_sessions/vis_v1': { status: 'SCHEDULED', kinCareVisitId: 'v1' },
      },
      queryDocs: { 'families/kf1/bookings/b1/kinCares': [{ id: 'v1', data: { status: 'requested' } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await manageBookingSeriesHandler(req({ action: 'APPROVE', kinfolkId: 'kf1', batchId: 'b1' }));
    expect(res.sessionsCreated).toBe(0);
    // no fresh session write to the deterministic id (it already existed)
    expect(ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_v1' && w.data.status === 'SCHEDULED')).toBeUndefined();
    expect(ctx.writes.find((w) => w.path === 'families/kf1/bookings/b1/kinCares/v1')?.data.sessionId).toBe('vis_v1');
  });

  it('CANCEL: cancels the visit linked session by deterministic id', async () => {
    const ctx = buildDbMock({
      docs: {
        'families/kf1/bookings/b1': { envelopeStatus: 'confirmed' },
        'kin_care_sessions/vis_v1': { status: 'SCHEDULED', kinCareVisitId: 'v1' },
      },
      queryDocs: { 'families/kf1/bookings/b1/kinCares': [{ id: 'v1', data: { status: 'confirmed' } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await manageBookingSeriesHandler(req({ action: 'CANCEL', kinfolkId: 'kf1', batchId: 'b1' }));
    expect(ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_v1')?.data.status).toBe('CANCELLED');
  });

  it('SAD: missing envelope rejected (not-found)', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      manageBookingSeriesHandler(req({ action: 'APPROVE', kinfolkId: 'kf1', batchId: 'nope' })),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('SAD: unauthenticated rejected', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(
      manageBookingSeriesHandler(req({ action: 'APPROVE', kinfolkId: 'kf1', batchId: 'b1' }, null)),
    ).rejects.toThrow();
  });
});
