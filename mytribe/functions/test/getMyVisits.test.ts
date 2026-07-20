import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());

/**
 * Minimal Firestore mock whose `.limit(n)` reproduces the real SDK's
 * `validateInteger('limit', n)` check — the exact source of MYTRIBE-FUNCTIONS-4
 * (`Value for argument "limit" is not a valid integer.`). A non-integer limit
 * therefore throws here exactly as it does in production.
 */
function buildVisitsDb(
  kinfolkIds: string[],
  sessions: Array<{ id: string; data: Record<string, unknown> }>,
) {
  const limitCalls: unknown[] = [];
  const query: any = {
    where: () => query,
    orderBy: () => query,
    limit: (n: unknown) => {
      limitCalls.push(n);
      if (typeof n !== 'number' || !Number.isInteger(n)) {
        throw new Error('Value for argument "limit" is not a valid integer.');
      }
      return query;
    },
    get: async () => ({ docs: sessions.map((s) => ({ id: s.id, data: () => s.data })) }),
  };
  const db: any = {
    collection: (path: string) => {
      if (path === 'clients') {
        return { doc: () => ({ get: async () => ({ data: () => ({ kinfolkIds }) }) }) };
      }
      if (path === 'kin_care_sessions') return query;
      throw new Error(`unexpected collection: ${path}`);
    },
  };
  return { db, limitCalls };
}

describe('getMyVisitsHandler', () => {
  it('rejects unauthenticated request', async () => {
    const { getMyVisitsHandler } = await import('../src/portal/getMyVisits');
    await expect(
      getMyVisitsHandler({ data: {}, auth: undefined } as any),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('coerces a fractional limit to an integer before querying (MYTRIBE-FUNCTIONS-4)', async () => {
    // Wasm/JS callers can serialize the limit as a non-integer double; the raw
    // value must never reach Firestore's `.limit()`.
    const { db, limitCalls } = buildVisitsDb(['fam3'], []);
    mocks.dbFn.mockReturnValue(db);
    const { getMyVisitsHandler } = await import('../src/portal/getMyVisits');

    const res = await getMyVisitsHandler({
      data: { kinfolkId: 'fam3', limit: 20.5 },
      auth: { uid: 'u1' },
    } as any);

    expect(res.visits).toEqual([]);
    expect(limitCalls).toHaveLength(1);
    expect(Number.isInteger(limitCalls[0])).toBe(true);
    expect(limitCalls[0]).toBe(20);
  });

  it('defaults limit to 10 when omitted', async () => {
    const { db, limitCalls } = buildVisitsDb(['fam3'], []);
    mocks.dbFn.mockReturnValue(db);
    const { getMyVisitsHandler } = await import('../src/portal/getMyVisits');

    await getMyVisitsHandler({ data: { kinfolkId: 'fam3' }, auth: { uid: 'u1' } } as any);
    expect(limitCalls[0]).toBe(10);
  });
});
