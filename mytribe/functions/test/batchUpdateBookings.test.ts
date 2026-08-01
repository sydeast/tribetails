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
