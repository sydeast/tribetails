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
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

const core = vi.hoisted(() => ({ approve: vi.fn() }));
vi.mock('../src/admin/approveBookingSeriesCore', async () => {
  const actual = await vi.importActual<any>('../src/admin/approveBookingSeriesCore');
  return { ...actual, approveBookingSeriesCore: core.approve };
});
const guards = vi.hoisted(() => ({ busy: vi.fn(), holiday: vi.fn() }));
vi.mock('../src/lib/bookingBusyConflict', () => ({ guardBookingBusyConflict: guards.busy }));
vi.mock('../src/lib/companyHolidayConflict', () => ({ guardCompanyHolidayConflict: guards.holiday }));
import { HttpsError } from 'firebase-functions/v2/https';
import { batchUpdateBookingsHandler } from '../src/admin/batchUpdateBookings';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

beforeEach(() => {
  mocks.dbFn.mockReset();
  (writeAuditEntry as any).mockClear();
  core.approve.mockReset();
  core.approve.mockResolvedValue({ found: true, affectedVisits: 1, sessionsCreated: 1, failedVisits: 0, envelopeStatus: 'confirmed', newlyConfirmed: 1, householdNotified: true });
  guards.busy.mockReset().mockResolvedValue(undefined);
  guards.holiday.mockReset().mockResolvedValue(undefined);
});

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } as any } as any) : undefined,
    rawRequest: {} as any, instanceIdToken: undefined, acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

// `docs` holds each envelope visit as the series core leaves it (confirmed): the
// core is mocked, and the callable reads every id back after it runs.
function seed() {
  return buildDbMock({
    docs: {
      'families/kf1/bookings/b1/kinCares/v1': { status: 'confirmed' },
      'families/kf1/bookings/b1/kinCares/v2': { status: 'confirmed' },
    },
    collectionGroupDocs: {
      kinCares: [
        { id: 'v1', path: 'families/kf1/bookings/b1/kinCares/v1', data: { status: 'requested' } },
        { id: 'v2', path: 'families/kf1/bookings/b1/kinCares/v2', data: { status: 'requested' } },
        { id: 'v3', path: 'families/kf2/bookings/b2/kinCares/v3', data: { status: 'confirmed' } },
      ],
    },
  });
}

/** Adds a kinCares visit whose kin_care_sessions mirror doc already exists (approved). */
function seedWithSessionMirror() {
  return buildDbMock({
    docs: {
      'kin_care_sessions/vis_v1': { status: 'SCHEDULED' },
    },
    collectionGroupDocs: {
      kinCares: [
        { id: 'v1', path: 'families/kf1/bookings/b1/kinCares/v1', data: { status: 'confirmed' } },
      ],
    },
  });
}

/** android's native enhanced_bookings table: id IS the doc, no envelope. */
function seedAndroid() {
  return buildDbMock({
    docs: {
      'enhanced_bookings/eb1': { status: 'DRAFT' },
      'enhanced_bookings/eb2': { status: 'DRAFT' },
      'enhanced_bookings/eb3': { status: 'ACCEPTED' },
    },
  });
}

/** One android enhanced_bookings id and one web/notifications kinCares visit id, together. */
function seedMixed() {
  return buildDbMock({
    docs: {
      'enhanced_bookings/eb1': { status: 'DRAFT' },
      'families/kf1/bookings/b1/kinCares/v1': { status: 'confirmed' },
    },
    collectionGroupDocs: {
      kinCares: [
        { id: 'v1', path: 'families/kf1/bookings/b1/kinCares/v1', data: { status: 'requested' } },
      ],
    },
  });
}

describe('batchUpdateBookings happy path', () => {
  it('APPROVE sends each envelope visit through the series core and counts it once it reads confirmed (#1099)', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await batchUpdateBookingsHandler(req({ ids: ['v1', 'v2'], action: 'APPROVE' }));
    expect(res.ok).toBe(true);
    expect(res.updated).toBe(2);
    expect(res.failed).toEqual([]);
    // Two visits of ONE request: one core call, not one per visit.
    expect(core.approve).toHaveBeenCalledTimes(1);
    expect(core.approve).toHaveBeenCalledWith({ kinfolkId: 'kf1', batchId: 'b1', actorUid: 'admin1', actorRole: 'AUNTIE' });
    // The callable no longer flips status itself: the core owns that write.
    expect(ctx.writes.find((w) => w.path === 'families/kf1/bookings/b1/kinCares/v1')).toBeUndefined();
  });
  it('REJECT and CANCEL both terminate the visit to cancelled', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const rej = await batchUpdateBookingsHandler(req({ ids: ['v1'], action: 'REJECT' }));
    expect(rej.updated).toBe(1);
    expect(ctx.writes.find((w) => w.path === 'families/kf1/bookings/b1/kinCares/v1')?.data.status).toBe('cancelled');

    const ctx2 = seed();
    mocks.dbFn.mockReturnValue(ctx2.db);
    await batchUpdateBookingsHandler(req({ ids: ['v2'], action: 'CANCEL' }));
    expect(ctx2.writes.find((w) => w.path === 'families/kf1/bookings/b1/kinCares/v2')?.data.status).toBe('cancelled');
  });

  it('is idempotent: a visit already confirmed WITH its session counts as updated without a write', async () => {
    const ctx = buildDbMock({
      docs: { 'kin_care_sessions/vis_v3': { status: 'SCHEDULED' } },
      collectionGroupDocs: { kinCares: [{ id: 'v3', path: 'families/kf2/bookings/b2/kinCares/v3', data: { status: 'confirmed' } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await batchUpdateBookingsHandler(req({ ids: ['v3'], action: 'APPROVE' }));
    expect(res.updated).toBe(1);
    expect(ctx.writes.find((w) => w.path === 'families/kf2/bookings/b2/kinCares/v3')).toBeUndefined();
  });

  it('collects unknown ids into failed without aborting the batch', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await batchUpdateBookingsHandler(req({ ids: ['v1', 'ghost'], action: 'APPROVE' }));
    expect(res.updated).toBe(1);
    expect(res.failed).toEqual([{ id: 'ghost', error: 'not-found' }]);
  });

  it('writes a BOOKING_BATCH_ACTION audit entry with status SUCCESS when every id updates', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await batchUpdateBookingsHandler(req({ ids: ['v1', 'v2'], action: 'APPROVE' }));
    const call = (writeAuditEntry as any).mock.calls.map((c: any[]) => c[0])
      .find((c: any) => c.event === 'BOOKING_BATCH_ACTION');
    expect(call).toBeDefined();
    expect(call.payload.action).toBe('APPROVE');
    expect(call.payload.updated).toBe(2);
    expect(call.status).toBe('SUCCESS');
  });

  // A4 audit follow-up: writeAuditEntry used to hardcode status: 'SUCCESS'
  // for this callable regardless of the `failed` array accumulated by the
  // per-id loop above, so a batch where every id failed (0 updated, N
  // failed) was still recorded as a clean SUCCESS row. An audit query
  // filtering on status could not see it; only the description string (which
  // isn't queryable) carried the truth.
  it('audits a batch with unknown ids as FAILURE, not SUCCESS', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await batchUpdateBookingsHandler(req({ ids: ['ghost1', 'ghost2'], action: 'APPROVE' }));
    expect(res.updated).toBe(0);
    expect(res.failed).toHaveLength(2);
    const call = (writeAuditEntry as any).mock.calls.map((c: any[]) => c[0])
      .find((c: any) => c.event === 'BOOKING_BATCH_ACTION');
    expect(call.status).toBe('FAILURE');
  });

  it('audits a batch with a partial failure as FAILURE, not SUCCESS', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await batchUpdateBookingsHandler(req({ ids: ['v1', 'ghost'], action: 'APPROVE' }));
    expect(res.updated).toBe(1);
    expect(res.failed).toHaveLength(1);
    const call = (writeAuditEntry as any).mock.calls.map((c: any[]) => c[0])
      .find((c: any) => c.event === 'BOOKING_BATCH_ACTION');
    expect(call.status).toBe('FAILURE');
  });
});

describe('batchUpdateBookings kinCares -> kin_care_sessions mirror', () => {
  it('APPROVE of a confirmed visit that already has its session writes nothing (#1099)', async () => {
    const ctx = seedWithSessionMirror();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await batchUpdateBookingsHandler(req({ ids: ['v1'], action: 'APPROVE' }));
    expect(res.updated).toBe(1);
    expect(ctx.writes).toEqual([]);
  });
  it('CANCEL mirrors onto kin_care_sessions as CANCELLED', async () => {
    const ctx = seedWithSessionMirror();
    mocks.dbFn.mockReturnValue(ctx.db);
    await batchUpdateBookingsHandler(req({ ids: ['v1'], action: 'CANCEL' }));
    expect(ctx.writes.find((w) => w.path === 'families/kf1/bookings/b1/kinCares/v1')?.data.status).toBe('cancelled');
    expect(ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_v1')?.data.status).toBe('CANCELLED');
  });

  it('does not write a session mirror when none exists (still-pending request, never approved)', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await batchUpdateBookingsHandler(req({ ids: ['v1'], action: 'APPROVE' }));
    expect(ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_v1')).toBeUndefined();
  });
});

describe('batchUpdateBookings android enhanced_bookings ids', () => {
  it('APPROVE flips an enhanced_bookings doc to ACCEPTED (the defect this fixes)', async () => {
    const ctx = seedAndroid();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await batchUpdateBookingsHandler(req({ ids: ['eb1', 'eb2'], action: 'APPROVE' }));
    expect(res.ok).toBe(true);
    expect(res.updated).toBe(2);
    expect(res.failed).toEqual([]);
    expect(ctx.writes.find((w) => w.path === 'enhanced_bookings/eb1')?.data.status).toBe('ACCEPTED');
    expect(ctx.writes.find((w) => w.path === 'enhanced_bookings/eb2')?.data.status).toBe('ACCEPTED');
  });

  it('writes updatedAt as an ISO string, never a server Timestamp (android decodes it as a Kotlin String)', async () => {
    const ctx = seedAndroid();
    mocks.dbFn.mockReturnValue(ctx.db);
    await batchUpdateBookingsHandler(req({ ids: ['eb1'], action: 'APPROVE' }));
    const write = ctx.writes.find((w) => w.path === 'enhanced_bookings/eb1');
    expect(typeof write?.data.updatedAt).toBe('string');
    expect(write?.data.updatedAt).not.toBe('__TS__');
  });

  it('REJECT and CANCEL both terminate an enhanced_bookings doc to REJECTED', async () => {
    const ctx = seedAndroid();
    mocks.dbFn.mockReturnValue(ctx.db);
    await batchUpdateBookingsHandler(req({ ids: ['eb1'], action: 'REJECT' }));
    expect(ctx.writes.find((w) => w.path === 'enhanced_bookings/eb1')?.data.status).toBe('REJECTED');

    const ctx2 = seedAndroid();
    mocks.dbFn.mockReturnValue(ctx2.db);
    await batchUpdateBookingsHandler(req({ ids: ['eb1'], action: 'CANCEL' }));
    expect(ctx2.writes.find((w) => w.path === 'enhanced_bookings/eb1')?.data.status).toBe('REJECTED');
  });

  it('is idempotent: an enhanced_bookings doc already in the target status counts as updated without a write', async () => {
    const ctx = seedAndroid();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await batchUpdateBookingsHandler(req({ ids: ['eb3'], action: 'APPROVE' }));
    expect(res.updated).toBe(1);
    expect(ctx.writes.find((w) => w.path === 'enhanced_bookings/eb3')).toBeUndefined();
  });

  it('collects an unknown enhanced_bookings-shaped id into failed without checking kinCares for it needlessly', async () => {
    const ctx = seedAndroid();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await batchUpdateBookingsHandler(req({ ids: ['eb1', 'ghost'], action: 'APPROVE' }));
    expect(res.updated).toBe(1);
    expect(res.failed).toEqual([{ id: 'ghost', error: 'not-found' }]);
  });

  it('never touches kinCares or kin_care_sessions for an android-only batch', async () => {
    const ctx = seedAndroid();
    mocks.dbFn.mockReturnValue(ctx.db);
    await batchUpdateBookingsHandler(req({ ids: ['eb1'], action: 'APPROVE' }));
    expect(ctx.writes.every((w) => w.path.startsWith('enhanced_bookings/'))).toBe(true);
  });
});

describe('batchUpdateBookings mixed batch (both id spaces in one call)', () => {
  it('resolves an enhanced_bookings id and a kinCares visit id in the same request', async () => {
    const ctx = seedMixed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await batchUpdateBookingsHandler(req({ ids: ['eb1', 'v1'], action: 'APPROVE' }));
    expect(res.updated).toBe(2);
    expect(res.failed).toEqual([]);
    expect(ctx.writes.find((w) => w.path === 'enhanced_bookings/eb1')?.data.status).toBe('ACCEPTED');
    expect(core.approve).toHaveBeenCalledTimes(1);
  });

  it('one invalid id alongside one of each valid space fails only the invalid one', async () => {
    const ctx = seedMixed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await batchUpdateBookingsHandler(
      req({ ids: ['eb1', 'v1', 'nope'], action: 'APPROVE' }),
    );
    expect(res.updated).toBe(2);
    expect(res.failed).toEqual([{ id: 'nope', error: 'not-found' }]);
  });

  it('a write failure on one leg is reported per-id and does not block the other leg', async () => {
    const ctx = seedMixed();
    // Patch the collection the handler asks for so `enhanced_bookings/eb1`'s
    // write throws, without touching the kinCares leg. buildDbMock mints a
    // fresh ref (and a fresh `set` spy) on every `.doc(id)` call, so the spy
    // has to be installed at the `collection()` seam the handler itself uses.
    const originalCollection = ctx.db.collection.bind(ctx.db);
    ctx.db.collection = (path: string) => {
      const coll = originalCollection(path);
      if (path !== 'enhanced_bookings') return coll;
      const originalDoc = coll.doc.bind(coll);
      coll.doc = (id?: string) => {
        const ref = originalDoc(id);
        if (id === 'eb1') ref.set = vi.fn(async () => { throw new Error('boom'); });
        return ref;
      };
      return coll;
    };
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await batchUpdateBookingsHandler(req({ ids: ['eb1', 'v1'], action: 'APPROVE' }));
    expect(res.updated).toBe(1);
    expect(res.failed).toEqual([{ id: 'eb1', error: 'boom' }]);
    expect(core.approve).toHaveBeenCalledTimes(1);
  });

  it('reports a mixed audit targetCollection when both id spaces are present', async () => {
    const ctx = seedMixed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await batchUpdateBookingsHandler(req({ ids: ['eb1', 'v1'], action: 'APPROVE' }));
    const call = (writeAuditEntry as any).mock.calls.map((c: any[]) => c[0])
      .find((c: any) => c.event === 'BOOKING_BATCH_ACTION');
    expect(call.targetCollection).toBe('mixed');
    expect(call.payload.enhancedBookingIds).toBe(1);
    expect(call.payload.kinCareVisitIds).toBe(1);
  });
});

describe('batchUpdateBookings validation + auth', () => {
  it('rejects empty ids array (invalid-argument)', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(batchUpdateBookingsHandler(req({ ids: [], action: 'APPROVE' }))).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects over-100 ids (invalid-argument)', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    const ids = Array.from({ length: 101 }, (_, i) => `x${i}`);
    await expect(batchUpdateBookingsHandler(req({ ids, action: 'APPROVE' }))).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects unknown action (invalid-argument)', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(batchUpdateBookingsHandler(req({ ids: ['v1'], action: 'DELETE' }))).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects unauthenticated caller', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(batchUpdateBookingsHandler(req({ ids: ['v1'], action: 'APPROVE' }, null))).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});

/**
 * #1098: a night awaiting its start time cannot be approved one visit at a time.
 * This path confirms without the start-time step, so it refuses that id with the
 * reason, through the same per-id `failed` list every other refusal uses, and
 * still does the rest of the batch.
 */
describe('batchUpdateBookings: a visit awaiting a start time (#1098)', () => {
  function seedPending() {
    return buildDbMock({
      docs: { 'families/kf1/bookings/b1/kinCares/v2': { status: 'confirmed' } },
      collectionGroupDocs: {
        kinCares: [
          { id: 'v1', path: 'families/kf1/bookings/b1/kinCares/v1', data: { status: 'requested', startTimePending: true, startTime: null } },
          { id: 'v2', path: 'families/kf1/bookings/b1/kinCares/v2', data: { status: 'requested', startTimePending: false } },
        ],
      },
    });
  }

  it('APPROVE refuses the pending id and approves the other', async () => {
    const ctx = seedPending();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await batchUpdateBookingsHandler(req({ ids: ['v1', 'v2'], action: 'APPROVE' }));
    expect(res.updated).toBe(1);
    expect(res.failed).toEqual([{ id: 'v1', error: 'Set the start time before approving this Overnight.' }]);
    expect(ctx.writes.find((w) => w.path === 'families/kf1/bookings/b1/kinCares/v1')).toBeUndefined();
    expect(core.approve).toHaveBeenCalledTimes(1);
  });

  it('CANCEL of a pending visit still goes through: only approving needs a time', async () => {
    const ctx = seedPending();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await batchUpdateBookingsHandler(req({ ids: ['v1'], action: 'CANCEL' }));
    expect(res).toMatchObject({ updated: 1, failed: [] });
  });
});

/**
 * #1099: quick approve used to flip an envelope visit's status and nothing else.
 * The request now goes through `approveBookingSeriesCore`, and each id is
 * reported by what its own visit ended up as.
 */
describe('batchUpdateBookings: APPROVE goes through the series core (#1099)', () => {
  const V = (id: string, batch = 'b1', kf = 'kf1') => `families/${kf}/bookings/${batch}/kinCares/${id}`;
  function seedTwoRequests(after: Record<string, Record<string, unknown>> = {}) {
    return buildDbMock({
      docs: { ...after },
      collectionGroupDocs: {
        kinCares: [
          { id: 'v1', path: V('v1'), data: { status: 'requested' } },
          { id: 'v2', path: V('v2', 'b2', 'kf2'), data: { status: 'requested' } },
        ],
      },
    });
  }
  it('calls the core once per request, with the family and batch taken from the visit path', async () => {
    const ctx = seedTwoRequests({ [V('v1')]: { status: 'confirmed' }, [V('v2', 'b2', 'kf2')]: { status: 'confirmed' } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await batchUpdateBookingsHandler(req({ ids: ['v1', 'v2'], action: 'APPROVE' }));
    expect(res).toMatchObject({ updated: 2, failed: [] });
    expect(core.approve).toHaveBeenCalledTimes(2);
    expect(core.approve).toHaveBeenCalledWith(expect.objectContaining({ kinfolkId: 'kf1', batchId: 'b1' }));
    expect(core.approve).toHaveBeenCalledWith(expect.objectContaining({ kinfolkId: 'kf2', batchId: 'b2' }));
  });
  it('reports a visit the core could not book as failed, in the busy guard words', async () => {
    const ctx = seedTwoRequests({
      [V('v1')]: { status: 'requested', startTime: '2026-10-05T16:00:00.000Z', endTime: '2026-10-05T17:00:00.000Z' },
      [V('v2', 'b2', 'kf2')]: { status: 'confirmed' },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    guards.busy.mockRejectedValueOnce(new HttpsError('failed-precondition', 'That time overlaps a busy block on your Google Calendar.'));
    const res = await batchUpdateBookingsHandler(req({ ids: ['v1', 'v2'], action: 'APPROVE' }));
    expect(res.updated).toBe(1);
    expect(res.failed).toEqual([{ id: 'v1', error: 'That time overlaps a busy block on your Google Calendar.' }]);
  });
  it('falls back to a plain line when the visit is unconfirmed for a reason the guards cannot name', async () => {
    const ctx = seedTwoRequests({
      [V('v1')]: { status: 'requested', startTime: '2026-10-05T16:00:00.000Z', endTime: '2026-10-05T17:00:00.000Z' },
      [V('v2', 'b2', 'kf2')]: { status: 'confirmed' },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await batchUpdateBookingsHandler(req({ ids: ['v1'], action: 'APPROVE' }));
    expect(res.failed).toEqual([{ id: 'v1', error: 'This visit could not be booked. Approve the whole request from Requests.' }]);
  });
  it('a refusal from the core (a sibling night with no start time) lands on every selected id of that request', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    core.approve.mockRejectedValueOnce(new HttpsError('failed-precondition', 'Set a start time for the Overnight before approving.'));
    const res = await batchUpdateBookingsHandler(req({ ids: ['v1', 'v2'], action: 'APPROVE' }));
    expect(res.updated).toBe(0);
    expect(res.failed).toEqual([
      { id: 'v1', error: 'Set a start time for the Overnight before approving.' },
      { id: 'v2', error: 'Set a start time for the Overnight before approving.' },
    ]);
  });
  it('a request the core cannot find fails its ids as not-found', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    core.approve.mockResolvedValueOnce({ found: false, affectedVisits: 0, sessionsCreated: 0, failedVisits: 0, envelopeStatus: 'requested', newlyConfirmed: 0, householdNotified: false });
    const res = await batchUpdateBookingsHandler(req({ ids: ['v1'], action: 'APPROVE' }));
    expect(res.failed).toEqual([{ id: 'v1', error: 'not-found' }]);
  });
  it('a visit confirmed by the old status flip, with no session, is repaired through the core', async () => {
    const ctx = buildDbMock({
      docs: { [V('v1')]: { status: 'confirmed' } },
      collectionGroupDocs: { kinCares: [{ id: 'v1', path: V('v1'), data: { status: 'confirmed' } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await batchUpdateBookingsHandler(req({ ids: ['v1'], action: 'APPROVE' }));
    expect(res.updated).toBe(1);
    expect(core.approve).toHaveBeenCalledTimes(1);
  });
  it('a confirmed visit that already has its session is a no-op: the core is not called', async () => {
    const ctx = seedWithSessionMirror();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await batchUpdateBookingsHandler(req({ ids: ['v1'], action: 'APPROVE' }));
    expect(res.updated).toBe(1);
    expect(core.approve).not.toHaveBeenCalled();
  });
  it('REJECT and CANCEL never touch the core', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await batchUpdateBookingsHandler(req({ ids: ['v1'], action: 'REJECT' }));
    expect(core.approve).not.toHaveBeenCalled();
  });
  it('a kinCares doc outside an envelope keeps the old status flip', async () => {
    const ctx = buildDbMock({
      collectionGroupDocs: { kinCares: [{ id: 'old1', path: 'legacy/x/kinCares/old1', data: { status: 'requested' } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await batchUpdateBookingsHandler(req({ ids: ['old1'], action: 'APPROVE' }));
    expect(res.updated).toBe(1);
    expect(core.approve).not.toHaveBeenCalled();
    expect(ctx.writes.find((w) => w.path === 'legacy/x/kinCares/old1')?.data.status).toBe('confirmed');
  });
});
