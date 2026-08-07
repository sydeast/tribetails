import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__SERVER_TS__' } };
});

beforeEach(() => {
  mocks.dbFn.mockReset();
});

describe('submitRatingHandler', () => {
  it('rejects unauthenticated', async () => {
    const { submitRatingHandler } = await import('../src/portal/submitRating');
    await expect(
      submitRatingHandler({ data: { bookingId: 'b1', score: 5 }, auth: undefined } as any),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('single linked household, kinfolkId omitted -> resolves and submits (the normal path, unchanged)', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'families/3/bookings/b1/kinCares/v1': { familyId: '3' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { submitRatingHandler } = await import('../src/portal/submitRating');
    const res = await submitRatingHandler({
      data: { batchId: 'b1', visitId: 'v1', score: 5 },
      auth: { uid: 'u1' },
    } as any);
    expect(res.ratingId).toBe('v1');
    const w = ctx.writes.find((w) => w.path === 'families/3/ratings/v1');
    expect(w).toBeDefined();
    expect(w!.data.score).toBe(5);
  });

  it('MULTIPLE linked households, kinfolkId omitted -> refuses to guess and writes nothing (PR28b)', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3', '5'] },
        'families/3/bookings/b1/kinCares/v1': { familyId: '3' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { submitRatingHandler } = await import('../src/portal/submitRating');
    await expect(
      submitRatingHandler({ data: { batchId: 'b1', visitId: 'v1', score: 5 }, auth: { uid: 'u1' } } as any),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(ctx.writes).toHaveLength(0);
  });

  it("MULTIPLE linked households, kinfolkId '' -> refuses to guess ('' pinned as omitted)", async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3', '5'] },
        'families/3/bookings/b1/kinCares/v1': { familyId: '3' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { submitRatingHandler } = await import('../src/portal/submitRating');
    await expect(
      submitRatingHandler({
        data: { kinfolkId: '', batchId: 'b1', visitId: 'v1', score: 5 },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('explicit kinfolkId not in caller allowed set -> permission-denied (unchanged)', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'families/999/bookings/b1/kinCares/v1': { familyId: '999' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { submitRatingHandler } = await import('../src/portal/submitRating');
    await expect(
      submitRatingHandler({
        data: { kinfolkId: '999', batchId: 'b1', visitId: 'v1', score: 5 },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });
});
