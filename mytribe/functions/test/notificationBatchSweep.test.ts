import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FieldPath } from 'firebase-admin/firestore';

/**
 * ── WHAT THESE TESTS CAN AND CANNOT PROVE ──────────────────────────────────
 *
 * CANNOT. No mock can prove a Firestore query is servable. The shared helper
 * `test/_helpers/mockDb.ts` implements `.where()`, `.orderBy()`, `.limit()` and
 * `.startAfter()` as no-ops returning the chainable, and `.get()` returns the
 * entire fixture regardless, so it cannot fail on a missing index, a wrong
 * collection-group id, or a wrong path depth. It also cannot represent a
 * collection ref's `id`, which the parent walk reads. That is exactly how the
 * shipped bug (`collectionGroup(batchKey).orderBy('createdAt')`, which needs a
 * COLLECTION_GROUP index that does not exist and threw FAILED_PRECONDITION
 * every 5 minutes) passed review. So this file does not use that helper for the
 * sweep; it builds refs with a real parent chain and a paged query that honours
 * limit/startAfter.
 *
 * Still not provable here: that `collectionGroup(k).orderBy(documentId())` is
 * index-free, that no COLLECTION_GROUP index is required, and that the promote
 * transaction stays under the write limit. THOSE NEED AN EMULATOR TEST against
 * `firestore.indexes.json` with seeded rows at
 * `notificationBatch/{uid}/{batchKey}/{itemId}`, asserting the sweep completes
 * without FAILED_PRECONDITION. Nothing below is a substitute.
 *
 * CAN. Everything the mock genuinely determines:
 *  - the exact collection-group ids scanned, cross-checked against the path the
 *    REAL dispatcher writes (both sides are production code, no literals);
 *  - the exact path-segment count and layout, so a regression to a 5- or
 *    6-segment `items` layout fails here;
 *  - that the sort key is `documentId()` and never a data field, which is the
 *    direct regression guard for the deployed crash;
 *  - that the age field read matches the field the dispatcher stamps;
 *  - the parent walk's uid/batchKey mapping and its sentinel rejection;
 *  - window expiry, chronological ordering, chunking, and that pagination is
 *    not silently capped.
 */

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), logEvent: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));

import { buildDbMock } from './_helpers/mockDb';
import { enqueueNotification } from '../src/notifications/dispatcher';
import {
  NOTIFICATION_BATCH_ROOT,
  batchedCollectionGroupIds,
  resolveBatchBucket,
  resolveItemCreatedAtMs,
  runNotificationBatchSweep,
} from '../src/scheduled/notificationBatchSweep';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.logEvent.mockReset();
});

const MIN = 60 * 1000;
const NOW = 1_800_000_000_000;

// ── Ref shims with a REAL parent chain ────────────────────────────────────────
// The parent walk is the whole point of these tests, so `.parent` resolves the
// actual path segments instead of the shared helper's stub (which exposes no
// collection `id` at all). Getters keep the chain lazy so it terminates at the
// root collection.

function makeColRef(path: string, sink?: Sink): any {
  const segs = path.split('/');
  return {
    id: segs[segs.length - 1],
    path,
    get parent() {
      return segs.length >= 2 ? makeDocRef(segs.slice(0, -1).join('/'), sink) : null;
    },
  };
}

function makeDocRef(path: string, sink?: Sink): any {
  const segs = path.split('/');
  return {
    id: segs[segs.length - 1],
    path,
    get parent() {
      return makeColRef(segs.slice(0, -1).join('/'), sink);
    },
    set: vi.fn(async (data: Record<string, unknown>) => {
      sink?.writes.push({ path, data });
    }),
    delete: vi.fn(async () => {
      sink?.deletes.push(path);
    }),
  };
}

interface Row {
  id: string;
  path: string;
  data: Record<string, unknown>;
  createTimeMs?: number;
}

interface Sink {
  writes: Array<{ path: string; data: Record<string, unknown> }>;
  deletes: string[];
}

/**
 * Firestore stand-in for the sweep. Unlike the shared helper this one actually
 * paginates: `.limit(n)` slices and `.startAfter(doc)` resumes after that id, so
 * a runner that silently caps at one page fails. It records every
 * `collectionGroup()` id, every `orderBy()` argument and every `where()` call,
 * which is what lets the index-shape assertions below mean something.
 */
function buildBatchDb(rowsByGroup: Record<string, Row[]>) {
  const groupsQueried: string[] = [];
  const orderByArgs: unknown[] = [];
  const whereCalls: unknown[] = [];
  const sink: Sink = { writes: [], deletes: [] };
  let autoId = 0;

  const makeDocSnap = (row: Row) => ({
    id: row.id,
    data: () => row.data,
    ref: makeDocRef(row.path, sink),
    createTime: row.createTimeMs == null ? undefined : { toMillis: () => row.createTimeMs as number },
  });

  function makeQuery(group: string, startId: string | null, lim: number | null): any {
    const rows = rowsByGroup[group] ?? [];
    let start = 0;
    if (startId) {
      const i = rows.findIndex((r) => r.id === startId);
      start = i < 0 ? rows.length : i + 1;
    }
    const slice = lim == null ? rows.slice(start) : rows.slice(start, start + lim);
    return {
      orderBy: vi.fn((field: unknown) => {
        orderByArgs.push(field);
        return makeQuery(group, startId, lim);
      }),
      where: vi.fn((...args: unknown[]) => {
        whereCalls.push(args);
        return makeQuery(group, startId, lim);
      }),
      limit: vi.fn((n: number) => makeQuery(group, startId, n)),
      startAfter: vi.fn((cursor: { id: string }) => makeQuery(group, cursor.id, lim)),
      get: vi.fn(async () => ({ docs: slice.map(makeDocSnap) })),
    };
  }

  const db: any = {
    collectionGroup: (name: string) => {
      groupsQueried.push(name);
      return makeQuery(name, null, null);
    },
    collection: (name: string) => ({
      doc: (id?: string) => {
        autoId += 1;
        return makeDocRef(`${name}/${id ?? `auto-${autoId}`}`, sink);
      },
    }),
    runTransaction: vi.fn(async <T>(fn: (tx: any) => Promise<T>): Promise<T> =>
      fn({
        set: (ref: any, data: any) => ref.set(data),
        delete: (ref: any) => ref.delete(),
      })),
  };

  return { db, groupsQueried, orderByArgs, whereCalls, sink };
}

/** One pending batch item at the canonical 4-segment path. */
function item(uid: string, batchKey: string, id: string, createdAtMs: number, extra = {}): Row {
  return {
    id,
    path: `${NOTIFICATION_BATCH_ROOT}/${uid}/${batchKey}/${id}`,
    data: {
      key: 'kintale.comment.added',
      category: 'kintale',
      channels: ['push'],
      data: { taleId: 't1', commentId: id, ...extra },
      createdAt: { toMillis: () => createdAtMs },
    },
  };
}

// ── The writer/reader contract ────────────────────────────────────────────────

describe('notificationBatchSweep: writer/reader path contract', () => {
  /**
   * The load-bearing test. It drives the REAL dispatcher, reads the path it
   * actually writes, and asserts the sweep scans that exact collection group.
   * Neither side is a literal here, so a change to either that breaks the pair
   * fails this test. This is the check whose absence let the writer and the
   * sweep disagree for two months.
   */
  it('scans exactly the collection group the dispatcher writes into', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await enqueueNotification({
      key: 'kintale.comment.added',
      recipientUid: 'kinUid',
      data: { kinfolkId: 'f1', taleId: 't1', commentId: 'c1', preview: 'hi' },
    });

    const written = ctx.writes.find((w) => w.path.startsWith(`${NOTIFICATION_BATCH_ROOT}/`));
    expect(written, 'dispatcher wrote no batch item').toBeDefined();
    const segs = (written as { path: string }).path.split('/');

    // A Firestore document path has an EVEN segment count. The old docstring's
    // `notificationBatch/{uid}/{batchKey}/items/{auto}` is 5 and cannot exist;
    // a 6-segment `items` layout would also fail here.
    expect(segs.length).toBe(4);
    expect(segs.length % 2).toBe(0);
    expect(segs[0]).toBe(NOTIFICATION_BATCH_ROOT);
    expect(segs[1]).toBe('kinUid');
    expect(segs).not.toContain('items');

    // Segment 3 is the collection group the sweep must scan.
    expect(batchedCollectionGroupIds()).toContain(segs[2]);
  });

  it('derives scan targets from the catalog and queries each one', async () => {
    const keys = batchedCollectionGroupIds();
    expect(keys).toEqual(['kintale-comments']); // sole batched def today
    const ctx = buildBatchDb({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await runNotificationBatchSweep(NOW);
    expect(ctx.groupsQueried).toEqual(keys);
  });

  /**
   * The direct regression guard for the deployed crash. `orderBy('createdAt')`
   * on a collection group needs a COLLECTION_GROUP single-field index, which
   * Firestore never auto-creates; `orderBy(documentId())` uses only the
   * automatic index. This asserts the sort key is documentId() and that no
   * string field name is ever passed. It does NOT prove servability; only an
   * emulator run can.
   */
  it('sorts by documentId(), never by a data field, and never filters', async () => {
    const ctx = buildBatchDb({
      'kintale-comments': [item('u1', 'kintale-comments', 'a', NOW - 30 * MIN)],
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await runNotificationBatchSweep(NOW);

    expect(ctx.orderByArgs.length).toBeGreaterThan(0);
    for (const arg of ctx.orderByArgs) {
      expect(typeof arg).not.toBe('string');
      expect(arg).toBeInstanceOf(FieldPath);
      expect((arg as FieldPath).isEqual(FieldPath.documentId())).toBe(true);
    }
    // A .where() on a collection group would reintroduce a composite-index
    // requirement (field + __name__). Filtering happens in memory instead.
    expect(ctx.whereCalls).toEqual([]);
  });

  /** The sweep's age field must be the field the dispatcher actually stamps. */
  it('reads the age from the same field the dispatcher stamps', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await enqueueNotification({
      key: 'kintale.comment.added',
      recipientUid: 'kinUid',
      data: { kinfolkId: 'f1', taleId: 't1', commentId: 'c1', preview: 'hi' },
    });
    const written = ctx.writes.find((w) => w.path.startsWith(`${NOTIFICATION_BATCH_ROOT}/`));
    const stamped = (written as { data: Record<string, unknown> }).data;

    expect(Object.keys(stamped)).toContain('createdAt');
    // Feed the sweep a doc carrying only the dispatcher's own age key and check
    // it resolves to that value rather than falling through to createTime.
    const at = NOW - 7 * MIN;
    const resolved = resolveItemCreatedAtMs(
      { createdAt: { toMillis: () => at } } as never,
      { createTime: { toMillis: () => NOW } as never },
      NOW,
    );
    expect(resolved).toBe(at);
  });

  it('falls back to createTime so a malformed item still ages out', () => {
    expect(resolveItemCreatedAtMs({}, { createTime: { toMillis: () => 42 } as never }, NOW)).toBe(42);
    expect(resolveItemCreatedAtMs({}, {}, NOW)).toBe(NOW);
    // A doc that already carries createdAtMs is still honoured.
    expect(resolveItemCreatedAtMs({ createdAtMs: 7 }, {}, NOW)).toBe(7);
  });
});

// ── Parent walk ───────────────────────────────────────────────────────────────

describe('notificationBatchSweep: parent walk', () => {
  it('maps a realistic 4-segment item path to its uid and batchKey', () => {
    const ref = makeDocRef(`${NOTIFICATION_BATCH_ROOT}/uid-42/kintale-comments/item-1`);
    expect(resolveBatchBucket(ref)).toEqual({ uid: 'uid-42', batchKey: 'kintale-comments' });
  });

  it('rejects a same-named collection group outside notificationBatch', () => {
    // Without the sentinel this would be swept as if it were a batch item.
    const ref = makeDocRef('someOther/uid-42/kintale-comments/item-1');
    expect(resolveBatchBucket(ref)).toBeNull();
  });

  /**
   * Encodes the design decision. The 2026-05-10 walk (ref.parent.parent, then
   * .parent.parent) expected a 6-segment `items` layout that was never
   * writable and never written. A doc at that depth must NOT resolve, or the
   * sweep would silently read uid and batchKey off the wrong segments.
   */
  it('rejects the 6-segment items layout the old walk expected', () => {
    const ref = makeDocRef(`${NOTIFICATION_BATCH_ROOT}/uid-42/batches/kintale-comments/items/i1`);
    expect(resolveBatchBucket(ref)).toBeNull();
  });

  it('rejects a top-level doc with no uid above it', () => {
    expect(resolveBatchBucket(makeDocRef(`${NOTIFICATION_BATCH_ROOT}/uid-42`))).toBeNull();
  });
});

// ── Promotion behaviour ───────────────────────────────────────────────────────

describe('notificationBatchSweep: promotion', () => {
  it('promotes a bucket past its window and deletes exactly its items', async () => {
    const ctx = buildBatchDb({
      'kintale-comments': [
        item('u1', 'kintale-comments', 'c-b', NOW - 30 * MIN),
        item('u1', 'kintale-comments', 'c-a', NOW - 20 * MIN),
      ],
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await runNotificationBatchSweep(NOW);

    expect(res).toMatchObject({ scanned: 2, emitted: 1 });
    expect(ctx.sink.deletes.sort()).toEqual([
      `${NOTIFICATION_BATCH_ROOT}/u1/kintale-comments/c-a`,
      `${NOTIFICATION_BATCH_ROOT}/u1/kintale-comments/c-b`,
    ]);

    const digest = ctx.sink.writes.find((w) => w.path.startsWith('notifications/'));
    expect(digest).toBeDefined();
    expect(digest!.data).toMatchObject({
      key: 'kintale.comment.added',
      recipientUid: 'u1',
      mode: 'batched-promoted',
      originBatchKey: 'kintale-comments',
    });
    expect((digest!.data.data as { itemCount: number }).itemCount).toBe(2);
  });

  it('holds a bucket whose oldest item is still inside the window', async () => {
    // kintale.comment.added uses a 5-minute window.
    const ctx = buildBatchDb({
      'kintale-comments': [item('u1', 'kintale-comments', 'c1', NOW - 1 * MIN)],
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await runNotificationBatchSweep(NOW);

    expect(res.emitted).toBe(0);
    expect(ctx.sink.deletes).toEqual([]);
    expect(ctx.sink.writes).toEqual([]);
  });

  it('keeps buckets separate per uid', async () => {
    const ctx = buildBatchDb({
      'kintale-comments': [
        item('u1', 'kintale-comments', 'a', NOW - 30 * MIN),
        item('u2', 'kintale-comments', 'b', NOW - 30 * MIN),
      ],
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await runNotificationBatchSweep(NOW);

    expect(res.emitted).toBe(2);
    const recipients = ctx.sink.writes
      .filter((w) => w.path.startsWith('notifications/'))
      .map((w) => w.data.recipientUid)
      .sort();
    expect(recipients).toEqual(['u1', 'u2']);
  });

  /**
   * Document-id order is not time order. The fixture is deliberately in id
   * order that reverses time order, so a digest built in scan order fails.
   */
  it('restores chronological order in the digest despite documentId() scan order', async () => {
    const ctx = buildBatchDb({
      'kintale-comments': [
        item('u1', 'kintale-comments', 'aaa', NOW - 10 * MIN), // first by id, newest
        item('u1', 'kintale-comments', 'bbb', NOW - 40 * MIN),
        item('u1', 'kintale-comments', 'ccc', NOW - 90 * MIN), // last by id, oldest
      ],
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await runNotificationBatchSweep(NOW);

    const digest = ctx.sink.writes.find((w) => w.path.startsWith('notifications/'));
    const items = (digest!.data.data as { items: Array<{ itemId: string }> }).items;
    expect(items.map((i) => i.itemId)).toEqual(['ccc', 'bbb', 'aaa']);
  });

  it('skips an item with no catalog key instead of promoting a keyless digest', async () => {
    const keyless = item('u1', 'kintale-comments', 'x', NOW - 30 * MIN);
    delete (keyless.data as Record<string, unknown>).key;
    const ctx = buildBatchDb({ 'kintale-comments': [keyless] });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await runNotificationBatchSweep(NOW);
    expect(res).toMatchObject({ scanned: 1, emitted: 0 });
    expect(ctx.sink.writes).toEqual([]);
  });

  it('logs a warning and leaves the rows for a key no longer in the catalog', async () => {
    const stale = item('u1', 'kintale-comments', 'x', NOW - 30 * MIN);
    (stale.data as Record<string, unknown>).key = 'kintale.comment.retired';
    const ctx = buildBatchDb({ 'kintale-comments': [stale] });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await runNotificationBatchSweep(NOW);
    expect(res.emitted).toBe(0);
    expect(ctx.sink.deletes).toEqual([]);
    expect(mocks.logEvent.mock.calls.some((c) => c[0]?.event === 'batch.unknown.key')).toBe(true);
  });
});

// ── Backlog drain ─────────────────────────────────────────────────────────────

describe('notificationBatchSweep: backlog drain', () => {
  /**
   * Rows written since 2026-05-10 sit at the 4-segment path and have never been
   * read. They must drain without a migration. The fixture is 1,200 rows, above
   * the 500-row page size, so a runner capped at one page fails: `scanned` would
   * come back 500.
   */
  it('drains a multi-page backlog rather than capping at one page', async () => {
    const rows = Array.from({ length: 1200 }, (_, i) =>
      item('u1', 'kintale-comments', `c-${String(i).padStart(5, '0')}`, NOW - 90 * MIN),
    );
    const ctx = buildBatchDb({ 'kintale-comments': rows });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await runNotificationBatchSweep(NOW);
    expect(res.scanned).toBe(1200);
  });

  /**
   * A backlog bucket can exceed the per-transaction write limit. It must be
   * promoted in chunks, oldest first, and the deferral must be logged. A
   * throwing transaction would be caught and the bucket would stall forever.
   */
  it('chunks an oversized bucket oldest-first and logs the deferral', async () => {
    const rows = Array.from({ length: 1200 }, (_, i) =>
      item('u1', 'kintale-comments', `c-${String(i).padStart(5, '0')}`, NOW - 90 * MIN + i),
    );
    const ctx = buildBatchDb({ 'kintale-comments': rows });
    mocks.dbFn.mockReturnValue(ctx.db);
    await runNotificationBatchSweep(NOW);

    // MAX_ITEMS_PER_DIGEST = 400, +1 digest write, under the 500 limit.
    expect(ctx.sink.deletes.length).toBe(400);
    const digest = ctx.sink.writes.find((w) => w.path.startsWith('notifications/'));
    const payload = digest!.data.data as { itemCount: number; items: Array<{ itemId: string }> };
    expect(payload.itemCount).toBe(400);
    expect(payload.items[0].itemId).toBe('c-00000'); // oldest, not scan-order-first

    const chunked = mocks.logEvent.mock.calls.find((c) => c[0]?.event === 'batch.promote.chunked');
    expect(chunked?.[0].extra).toMatchObject({ promoted: 400, deferred: 800 });
  });

  it('reports scan and flush counts on every run', async () => {
    const ctx = buildBatchDb({
      'kintale-comments': [item('u1', 'kintale-comments', 'a', NOW - 30 * MIN)],
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await runNotificationBatchSweep(NOW);

    const done = mocks.logEvent.mock.calls.find((c) => c[0]?.event === 'batch.sweep.complete');
    expect(done?.[0].extra).toMatchObject({
      scannedItems: 1,
      bucketsFlushed: 1,
      batchKeys: ['kintale-comments'],
    });
  });
});
