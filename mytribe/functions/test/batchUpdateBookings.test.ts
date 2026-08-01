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

import { batchUpdateBookingsHandler } from '../src/admin/batchUpdateBookings';
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

function seed() {
  return buildDbMock({
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
    },
    collectionGroupDocs: {
      kinCares: [
        { id: 'v1', path: 'families/kf1/bookings/b1/kinCares/v1', data: { status: 'requested' } },
      ],
    },
  });
}

describe('batchUpdateBookings happy path', () => {
  it('APPROVE flips each requested visit to confirmed and counts updated', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await batchUpdateBookingsHandler(req({ ids: ['v1', 'v2'], action: 'APPROVE' }));
    expect(res.ok).toBe(true);
    expect(res.updated).toBe(2);
    expect(res.failed).toEqual([]);
    expect(ctx.writes.find((w) => w.path === 'families/kf1/bookings/b1/kinCares/v1')?.data.status).toBe('confirmed');
    expect(ctx.writes.find((w) => w.path === 'families/kf1/bookings/b1/kinCares/v2')?.data.status).toBe('confirmed');
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

  it('is idempotent: a visit already in the target status counts as updated without a write', async () => {
    const ctx = seed();
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

  it('writes a BOOKING_BATCH_ACTION audit entry', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await batchUpdateBookingsHandler(req({ ids: ['v1', 'v2'], action: 'APPROVE' }));
    const call = (writeAuditEntry as any).mock.calls.map((c: any[]) => c[0])
      .find((c: any) => c.event === 'BOOKING_BATCH_ACTION');
    expect(call).toBeDefined();
    expect(call.payload.action).toBe('APPROVE');
    expect(call.payload.updated).toBe(2);
  });
});

describe('batchUpdateBookings kinCares -> kin_care_sessions mirror', () => {
  it('APPROVE mirrors onto the paired kin_care_sessions doc when one exists', async () => {
    const ctx = seedWithSessionMirror();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await batchUpdateBookingsHandler(req({ ids: ['v1'], action: 'APPROVE' }));
    expect(res.updated).toBe(1);
    // kinCares was already 'confirmed' (idempotent, no write), but the session
    // mirror still gets synced to the uppercase vocabulary.
    expect(ctx.writes.find((w) => w.path === 'families/kf1/bookings/b1/kinCares/v1')).toBeUndefined();
    expect(ctx.writes.find((w) => w.path === 'kin_care_sessions/vis_v1')?.data.status).toBe('SCHEDULED');
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
    expect(ctx.writes.find((w) => w.path === 'families/kf1/bookings/b1/kinCares/v1')?.data.status).toBe('confirmed');
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
    expect(ctx.writes.find((w) => w.path === 'families/kf1/bookings/b1/kinCares/v1')?.data.status).toBe('confirmed');
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
