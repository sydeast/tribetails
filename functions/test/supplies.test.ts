import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('firebase-admin/firestore', () => ({ FieldValue: { serverTimestamp: () => '__TS__' } }));

import {
  AdjustSupplyArgs,
  UpsertSupplyArgs,
  listSuppliesHandler,
  adjustSupplyHandler,
  upsertSupplyHandler,
} from '../src/admin/supplies';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

function req(data: unknown, uid: string | null = 'auntie-1'): CallableRequest<unknown> {
  return { data, auth: uid ? ({ uid, token: { admin: true } } as any) : undefined } as unknown as CallableRequest<unknown>;
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  (writeAuditEntry as any).mockClear();
});

describe('args validation', () => {
  it('AdjustSupplyArgs requires an integer delta', () => {
    expect(AdjustSupplyArgs.safeParse({ supplyId: 's1', delta: -3 }).success).toBe(true);
    expect(AdjustSupplyArgs.safeParse({ supplyId: 's1', delta: 1.5 }).success).toBe(false);
  });
  it('UpsertSupplyArgs requires name/unit and non-negative counts', () => {
    expect(UpsertSupplyArgs.safeParse({ name: 'Poop bags', onHand: 10, par: 5, unit: 'rolls' }).success).toBe(true);
    expect(UpsertSupplyArgs.safeParse({ name: '', onHand: 10, par: 5, unit: 'rolls' }).success).toBe(false);
    expect(UpsertSupplyArgs.safeParse({ name: 'x', onHand: -1, par: 5, unit: 'rolls' }).success).toBe(false);
  });
});

describe('listSuppliesHandler', () => {
  it('returns supplies sorted by name with a lowCount of onHand<=par', async () => {
    const ctx = buildDbMock({
      queryDocs: {
        supplies: [
          { id: 's2', data: { name: 'Wipes', onHand: 2, par: 5, unit: 'packs' } }, // low
          { id: 's1', data: { name: 'Bags', onHand: 20, par: 5, unit: 'rolls' } }, // ok
          { id: 's3', data: { name: 'Treats', onHand: 5, par: 5, unit: 'bags' } }, // low (== par)
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await listSuppliesHandler(req({}));
    expect(res.supplies.map((s) => s.name)).toEqual(['Bags', 'Treats', 'Wipes']);
    expect(res.lowCount).toBe(2);
    expect(res.supplies[0]).toHaveProperty('_id');
  });
});

describe('adjustSupplyHandler', () => {
  it('adds delta and returns new onHand', async () => {
    const ctx = buildDbMock({ docs: { 'supplies/s1': { name: 'Bags', onHand: 4, par: 5, unit: 'rolls' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await adjustSupplyHandler(req({ supplyId: 's1', delta: 3 }));
    expect(res.onHand).toBe(7);
    expect(ctx.writes.find((w) => w.path === 'supplies/s1')?.data.onHand).toBe(7);
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ event: 'SUPPLY_ADJUSTED' }));
  });

  it('clamps onHand at 0, never negative', async () => {
    const ctx = buildDbMock({ docs: { 'supplies/s1': { name: 'Bags', onHand: 2, par: 5, unit: 'rolls' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await adjustSupplyHandler(req({ supplyId: 's1', delta: -10 }));
    expect(res.onHand).toBe(0);
  });

  it('fails loud (not-found) for a missing supply', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(adjustSupplyHandler(req({ supplyId: 'ghost', delta: 1 }))).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('upsertSupplyHandler', () => {
  it('creates a new supply when no supplyId given', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await upsertSupplyHandler(req({ name: 'Leashes', onHand: 8, par: 3, unit: 'ea' }));
    expect(res.id).toBeTruthy();
    const w = ctx.writes.find((x) => x.path.startsWith('supplies/'));
    expect(w?.data.name).toBe('Leashes');
    expect(w?.data.createdAt).toBe('__TS__');
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ event: 'SUPPLY_UPSERTED' }));
  });

  it('updates an existing supply in place when supplyId given', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await upsertSupplyHandler(req({ supplyId: 's9', name: 'Bags', onHand: 12, par: 5, unit: 'rolls' }));
    expect(res.id).toBe('s9');
    const w = ctx.writes.find((x) => x.path === 'supplies/s9');
    expect(w?.data.onHand).toBe(12);
    expect(w?.data.createdAt).toBeUndefined(); // update path does not stamp createdAt
  });

  it('rejects invalid args', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(upsertSupplyHandler(req({ name: '', onHand: 1, par: 1, unit: 'x' }))).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});
