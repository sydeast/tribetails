import { describe, it, expect, vi, beforeEach } from 'vitest';

// WARNING-25 (fcm_tokens leg): the weekly token prune must NOT silently cap at
// one `.limit(500)` page, and must not drop the tail of the last page on the
// floor when batching the deletes.
//
// Context: the collection name bug (`fcmTokens` camel vs the canonical
// `fcm_tokens`) was already fixed in 84c6607. What remained is that this
// collection has NEVER been pruned in production, so the standing backlog is
// plausibly larger than one page, and a single-page sweep would not drain it.
//
// House idiom: vi.mock of firestoreAdmin with a hand-built paged db mock (see
// cronPagination.test.ts / pushChannel.test.ts). The emulator is used only
// under test/rules/.

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  logEvent: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));

import { runFcmTokenPruneScan } from '../src/scheduled/rotateOldFcmTokens';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_000_000_000_000;
const STALE_MS = NOW - 61 * DAY_MS; // past the 60-day cutoff
const FRESH_MS = NOW - 5 * DAY_MS; // comfortably inside it

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.logEvent.mockReset();
});

type Row = { id: string; updatedAt?: number | null };

/**
 * A paged `collection('fcm_tokens')` mock that honours `.orderBy()` +
 * `.limit(pageSize)` + `.startAfter(cursor)`, plus a `batch()` whose commits
 * are recorded so batch boundaries are assertable.
 *
 * `commitShouldFail` makes every commit reject, to prove a delete failure
 * propagates instead of being swallowed.
 */
function pagedFcmDbMock(rows: Row[], opts: { commitShouldFail?: boolean } = {}) {
  // One entry per committed batch, so we can assert the 500/500/200 shape.
  const commits: string[][] = [];
  const batchesCreated: number[] = [];

  function makeDocSnap(row: Row) {
    const ref: any = { id: row.id, path: `fcm_tokens/${row.id}` };
    return {
      id: row.id,
      ref,
      data: () =>
        row.updatedAt == null ? {} : { uid: `u-${row.id}`, updatedAt: { toMillis: () => row.updatedAt } },
    };
  }

  function makeQuery(startId: string | null, limit: number | null): any {
    let startIndex = 0;
    if (startId) {
      const i = rows.findIndex((r) => r.id === startId);
      startIndex = i < 0 ? rows.length : i + 1;
    }
    const slice = limit == null ? rows.slice(startIndex) : rows.slice(startIndex, startIndex + limit);
    return {
      where: vi.fn(() => makeQuery(startId, limit)),
      orderBy: vi.fn(() => makeQuery(startId, limit)),
      limit: vi.fn((n: number) => makeQuery(startId, n)),
      startAfter: vi.fn((cursor: any) => makeQuery(cursor.id, limit)),
      get: vi.fn(async () => ({ docs: slice.map(makeDocSnap) })),
    };
  }

  const db = {
    collection: vi.fn(() => makeQuery(null, null)),
    batch: vi.fn(() => {
      const staged: string[] = [];
      batchesCreated.push(1);
      return {
        delete: vi.fn((ref: any) => {
          staged.push(ref.id);
        }),
        commit: vi.fn(async () => {
          if (opts.commitShouldFail) throw new Error('commit blew up');
          commits.push(staged);
        }),
      };
    }),
  };
  return { db, commits, batchesCreated };
}

const staleRows = (n: number, prefix = 't') =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${String(i).padStart(4, '0')}`, updatedAt: STALE_MS }));

describe('rotateOldFcmTokens: drains past the first page (WARNING-25)', () => {
  it('deletes EVERY stale token across multiple pages, not just the first 500', async () => {
    const rows = staleRows(1200);
    const ctx = pagedFcmDbMock(rows);
    mocks.dbFn.mockReturnValue(ctx.db);

    const deleted = await runFcmTokenPruneScan(NOW);

    expect(deleted).toBe(1200);
    // Every id actually reached a committed batch. Nothing past the cap dropped.
    const committedIds = ctx.commits.flat();
    expect(committedIds).toHaveLength(1200);
    expect(new Set(committedIds).size).toBe(1200);
    expect(committedIds).toContain('t0000');
    expect(committedIds).toContain('t1199');
    // Drained cleanly below the safety ceiling, so no cap log.
    expect(mocks.logEvent.mock.calls.some((c) => c[0]?.event === 'cron.pagination.cap-hit')).toBe(false);
  });

  it('leaves fresh tokens alone and only prunes what is past the 60-day cutoff', async () => {
    const rows: Row[] = [
      { id: 'stale-a', updatedAt: STALE_MS },
      { id: 'fresh-a', updatedAt: FRESH_MS },
      { id: 'stale-b', updatedAt: STALE_MS },
      // Never-stamped doc: the old `.where('updatedAt','<',cutoff)` query
      // excluded missing fields, so the paginated version must too.
      { id: 'no-stamp', updatedAt: null },
    ];
    const ctx = pagedFcmDbMock(rows);
    mocks.dbFn.mockReturnValue(ctx.db);

    const deleted = await runFcmTokenPruneScan(NOW);

    expect(deleted).toBe(2);
    expect(ctx.commits.flat().sort()).toEqual(['stale-a', 'stale-b']);
  });
});

describe('rotateOldFcmTokens: batch boundaries commit exactly once each', () => {
  it('commits 500/500/200 for 1200 stale docs (no dropped tail, no double-commit)', async () => {
    const ctx = pagedFcmDbMock(staleRows(1200));
    mocks.dbFn.mockReturnValue(ctx.db);

    const deleted = await runFcmTokenPruneScan(NOW);

    expect(deleted).toBe(1200);
    expect(ctx.commits.map((c) => c.length)).toEqual([500, 500, 200]);
    // No id appears in two different batches.
    expect(new Set(ctx.commits.flat()).size).toBe(1200);
  });

  it('exactly 500 stale docs commits ONE full batch and no trailing empty commit', async () => {
    const ctx = pagedFcmDbMock(staleRows(500));
    mocks.dbFn.mockReturnValue(ctx.db);

    const deleted = await runFcmTokenPruneScan(NOW);

    expect(deleted).toBe(500);
    expect(ctx.commits.map((c) => c.length)).toEqual([500]);
  });

  it('501 stale docs commits 500 then the 1-doc remainder (the tail is never left uncommitted)', async () => {
    const ctx = pagedFcmDbMock(staleRows(501));
    mocks.dbFn.mockReturnValue(ctx.db);

    const deleted = await runFcmTokenPruneScan(NOW);

    expect(deleted).toBe(501);
    expect(ctx.commits.map((c) => c.length)).toEqual([500, 1]);
  });

  it('never stages more than the 500-doc Firestore batch limit', async () => {
    const ctx = pagedFcmDbMock(staleRows(1700));
    mocks.dbFn.mockReturnValue(ctx.db);

    await runFcmTokenPruneScan(NOW);

    for (const c of ctx.commits) expect(c.length).toBeLessThanOrEqual(500);
    expect(ctx.commits.flat()).toHaveLength(1700);
  });
});

describe('rotateOldFcmTokens: no-op cases', () => {
  it('empty collection deletes nothing and never opens a batch', async () => {
    const ctx = pagedFcmDbMock([]);
    mocks.dbFn.mockReturnValue(ctx.db);

    const deleted = await runFcmTokenPruneScan(NOW);

    expect(deleted).toBe(0);
    expect(ctx.commits).toHaveLength(0);
    expect(ctx.batchesCreated).toHaveLength(0);
  });

  it('all-fresh collection deletes nothing and never opens a batch', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ id: `f${i}`, updatedAt: FRESH_MS }));
    const ctx = pagedFcmDbMock(rows);
    mocks.dbFn.mockReturnValue(ctx.db);

    const deleted = await runFcmTokenPruneScan(NOW);

    expect(deleted).toBe(0);
    expect(ctx.commits).toHaveLength(0);
    expect(ctx.batchesCreated).toHaveLength(0);
  });
});

describe('rotateOldFcmTokens: safety ceiling fails LOUD', () => {
  // Same shape as the sibling ceiling test in cronPagination.test.ts: the
  // runner does not expose pageSize/safetyMaxPages, so the ceiling is driven
  // through paginateQuery directly under this cron's functionName.
  it('emits a critical cron.pagination.cap-hit log under the rotateOldFcmTokens name', async () => {
    const { paginateQuery } = await import('../src/lib/paginateCollectionGroup');
    const ctx = pagedFcmDbMock(staleRows(30));

    let processed = 0;
    const total = await paginateQuery(
      ctx.db.collection() as any,
      () => {
        processed += 1;
      },
      { pageSize: 2, safetyMaxPages: 3, functionName: 'rotateOldFcmTokens' },
    );

    expect(total).toBe(6); // 3 pages * 2 docs, then stopped
    expect(processed).toBe(6);
    const capLog = mocks.logEvent.mock.calls.find((c) => c[0]?.event === 'cron.pagination.cap-hit');
    expect(capLog).toBeDefined();
    expect(capLog?.[0]?.severity).toBe('critical');
    expect(capLog?.[0]?.function).toBe('rotateOldFcmTokens');
  });
});

describe('rotateOldFcmTokens: failures surface', () => {
  it('a failing batch commit rejects out of the scan instead of being swallowed', async () => {
    const ctx = pagedFcmDbMock(staleRows(600), { commitShouldFail: true });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(runFcmTokenPruneScan(NOW)).rejects.toThrow('commit blew up');
    // Nothing was recorded as committed, so the count can never over-report.
    expect(ctx.commits).toHaveLength(0);
  });
});
