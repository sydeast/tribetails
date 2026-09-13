import { vi } from 'vitest';

/** The subset of Firestore's SetOptions this mock records verbatim. */
export interface SetOptionsLike {
  merge?: boolean;
  mergeFields?: ReadonlyArray<string>;
}

/**
 * In-memory Firestore query semantics.
 *
 * `where`, `orderBy`, `limit`, and `startAfter` used to be `vi.fn(() => chainable)`
 * no-ops, so `.get()` returned the whole fixture regardless of the query. Every
 * predicate in every consumer was unverifiable. They now actually filter, sort,
 * cursor, and truncate, matching the traps real Firestore sets:
 *
 * - `==`, `in`, `array-contains`, and every range operator SKIP documents that
 *   are missing the field entirely. `!=` and `not-in` skip missing docs too
 *   (a missing field is not "not equal", it is invisible to the index).
 * - `orderBy(f)` DROPS documents missing `f`, for the same index reason.
 * - Cross-type comparison follows Firestore's type ordering
 *   (null < boolean < number < timestamp < string < array < map), so a string
 *   `sentAt` and a `Date` filter compare by type rank, not by coercion.
 * - `limit(n)` rejects a non-integer `n` exactly as the real SDK's
 *   `validateInteger` does.
 *
 * Deliberately NOT modelled (documented so nobody reads green as proof):
 * - Ties are broken by fixture order, not by an implicit `__name__` tiebreak,
 *   and a query with no `orderBy` keeps fixture order rather than sorting by
 *   document id. Fixture ids here are arbitrary; enforcing id order would only
 *   assert something about the fixture, not about the consumer.
 * - Missing-composite-index errors, `.select()` projection (still a passthrough,
 *   since the `queryDocs` fixture already dictates what `.data()` returns), and
 *   Firestore's "inequality field must be the first orderBy" validation.
 */

type Data = Record<string, unknown>;

/** A fixture row lifted into a uniform shape the query engine can work on. */
interface Row {
  id: string;
  data: Data;
  docPath: string;
}

/** Either the document id (`__name__` / `FieldPath.documentId()`) or a field path. */
type FieldSel = { id: true } | { id: false; path: string[] };

type Constraint =
  | { kind: 'where'; field: FieldSel; op: string; value: unknown }
  | { kind: 'orderBy'; field: FieldSel; dir: 'asc' | 'desc' }
  | { kind: 'limit'; n: number }
  | { kind: 'startAfter'; args: unknown[] };

/**
 * `'a.b'`, `FieldPath('a','b')`, `'__name__'`, and `FieldPath.documentId()` all
 * arrive here. FieldPath stringifies to its dotted path, and documentId()'s
 * single segment is `__name__`.
 */
function selField(arg: unknown): FieldSel {
  const key = typeof arg === 'string' ? arg : String(arg);
  if (key === '__name__') return { id: true };
  return { id: false, path: key.split('.') };
}

/** Reads a (possibly nested) field. `present:false` means "no such field". */
function readPath(data: unknown, path: string[]): { present: boolean; value: unknown } {
  let cur: unknown = data;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) {
      return { present: false, value: undefined };
    }
    if (!(seg in (cur as Data))) return { present: false, value: undefined };
    cur = (cur as Data)[seg];
  }
  if (cur === undefined) return { present: false, value: undefined };
  return { present: true, value: cur };
}

function fieldOf(row: Row, sel: FieldSel): { present: boolean; value: unknown } {
  if (sel.id) return { present: true, value: row.id };
  return readPath(row.data, sel.path);
}

/** Timestamp-ish -> epoch millis, or null when the value is not a time. */
function asMillis(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  if (v === null || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o['toMillis'] === 'function') {
    const ms = (o['toMillis'] as () => unknown)();
    return typeof ms === 'number' ? ms : null;
  }
  if (typeof o['toDate'] === 'function') {
    const d = (o['toDate'] as () => unknown)();
    return d instanceof Date ? d.getTime() : null;
  }
  if (typeof o['_seconds'] === 'number') {
    return o['_seconds'] * 1000 + Number(o['_nanoseconds'] ?? 0) / 1e6;
  }
  if (typeof o['seconds'] === 'number' && typeof o['nanoseconds'] === 'number') {
    return o['seconds'] * 1000 + o['nanoseconds'] / 1e6;
  }
  return null;
}

/** Firestore's cross-type sort order. */
function typeRank(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'boolean') return 1;
  if (typeof v === 'number') return 2;
  if (asMillis(v) !== null) return 3;
  if (typeof v === 'string') return 4;
  if (Array.isArray(v)) return 5;
  return 6;
}

function compareValues(a: unknown, b: unknown): number {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  switch (ra) {
    case 0:
      return 0;
    case 1:
      return (a ? 1 : 0) - (b ? 1 : 0);
    case 2: {
      const na = a as number;
      const nb = b as number;
      // NaN sorts before every other number, as in Firestore.
      if (Number.isNaN(na) && Number.isNaN(nb)) return 0;
      if (Number.isNaN(na)) return -1;
      if (Number.isNaN(nb)) return 1;
      return na < nb ? -1 : na > nb ? 1 : 0;
    }
    case 3: {
      const ma = asMillis(a) as number;
      const mb = asMillis(b) as number;
      return ma < mb ? -1 : ma > mb ? 1 : 0;
    }
    case 4: {
      const sa = a as string;
      const sb = b as string;
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    }
    case 5: {
      const aa = a as unknown[];
      const ab = b as unknown[];
      for (let i = 0; i < Math.min(aa.length, ab.length); i += 1) {
        const c = compareValues(aa[i], ab[i]);
        if (c !== 0) return c;
      }
      return aa.length - ab.length;
    }
    default: {
      const ka = Object.keys(a as Data).sort();
      const kb = Object.keys(b as Data).sort();
      for (let i = 0; i < Math.min(ka.length, kb.length); i += 1) {
        if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
        const c = compareValues((a as Data)[ka[i]], (b as Data)[kb[i]]);
        if (c !== 0) return c;
      }
      return ka.length - kb.length;
    }
  }
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return compareValues(a, b) === 0;
}

function matchesWhere(
  row: Row,
  c: Extract<Constraint, { kind: 'where' }>,
): boolean {
  const { present, value } = fieldOf(row, c.field);
  // Every operator is index-backed, and a document missing the field is simply
  // not in that index. This is the trap the old double hid.
  if (!present) return false;
  const arg = c.value;
  switch (c.op) {
    case '==':
      return valuesEqual(value, arg);
    case '!=':
      // Firestore's != matches neither missing fields nor null values.
      return value !== null && !valuesEqual(value, arg);
    case 'in':
      return Array.isArray(arg) && arg.some((v) => valuesEqual(value, v));
    case 'not-in':
      return (
        value !== null && Array.isArray(arg) && !arg.some((v) => valuesEqual(value, v))
      );
    case 'array-contains':
      return Array.isArray(value) && value.some((v) => valuesEqual(v, arg));
    case 'array-contains-any':
      return (
        Array.isArray(value) &&
        Array.isArray(arg) &&
        value.some((v) => arg.some((w) => valuesEqual(v, w)))
      );
    case '<':
    case '<=':
    case '>':
    case '>=': {
      // Range filters skip null (and NaN), same as the real index.
      if (value === null) return false;
      if (typeof value === 'number' && Number.isNaN(value)) return false;
      const r = compareValues(value, arg);
      if (c.op === '<') return r < 0;
      if (c.op === '<=') return r <= 0;
      if (c.op === '>') return r > 0;
      return r >= 0;
    }
    default:
      throw new Error(`mockDb: unsupported where operator '${c.op}'`);
  }
}

type Order = Extract<Constraint, { kind: 'orderBy' }>;

function compareByOrders(a: unknown[], b: unknown[], orders: Order[]): number {
  for (let i = 0; i < orders.length; i += 1) {
    const c = compareValues(a[i], b[i]) * (orders[i].dir === 'desc' ? -1 : 1);
    if (c !== 0) return c;
  }
  return 0;
}

function orderKey(row: Row, orders: Order[]): unknown[] {
  return orders.map((o) => fieldOf(row, o.field).value);
}

/**
 * `startAfter` accepts either a DocumentSnapshot or one raw value per orderBy
 * clause. Both forms are reduced to a positional value list here.
 */
function cursorKey(args: unknown[], orders: Order[]): unknown[] {
  const first = args[0] as { id?: unknown; data?: unknown } | undefined;
  const isSnapshot =
    args.length === 1 &&
    first !== null &&
    typeof first === 'object' &&
    typeof (first as { data?: unknown }).data === 'function';
  if (isSnapshot) {
    const snapData = ((first as { data: () => Data }).data() ?? {}) as Data;
    return orders.map((o) =>
      o.field.id ? (first as { id: unknown }).id : readPath(snapData, o.field.path).value,
    );
  }
  return orders.map((_, i) => args[i]);
}

function applyConstraints(rows: Row[], constraints: Constraint[]): Row[] {
  let out = rows;

  for (const c of constraints) {
    if (c.kind === 'where') out = out.filter((r) => matchesWhere(r, c));
  }

  const orders = constraints.filter((c): c is Order => c.kind === 'orderBy');
  const cursor = constraints.find(
    (c): c is Extract<Constraint, { kind: 'startAfter' }> => c.kind === 'startAfter',
  );
  // A cursor with no explicit sort rides Firestore's implicit __name__ order.
  const effOrders: Order[] =
    orders.length > 0
      ? orders
      : cursor
        ? [{ kind: 'orderBy', field: { id: true }, dir: 'asc' }]
        : [];

  if (effOrders.length > 0) {
    // Ordering by a field excludes documents that do not have it.
    out = out.filter((r) => effOrders.every((o) => fieldOf(r, o.field).present));
    out = out
      .map((r, i) => ({ r, i, k: orderKey(r, effOrders) }))
      .sort((x, y) => compareByOrders(x.k, y.k, effOrders) || x.i - y.i)
      .map((x) => x.r);
  }

  if (cursor) {
    const key = cursorKey(cursor.args, effOrders);
    out = out.filter((r) => compareByOrders(orderKey(r, effOrders), key, effOrders) > 0);
  }

  // Last limit wins, as in the real SDK.
  const limits = constraints.filter(
    (c): c is Extract<Constraint, { kind: 'limit' }> => c.kind === 'limit',
  );
  if (limits.length > 0) out = out.slice(0, limits[limits.length - 1].n);

  return out;
}

/** Builds a mock Firestore that maps doc paths to canned data. */
export function buildDbMock(opts: {
  docs?: Record<string, Record<string, unknown> | null>;
  queryDocs?: Record<string, Array<{ id: string; data: Record<string, unknown> }>>;
  /**
   * Canned results for `collectionGroup(name)` queries, keyed by the bare
   * collection id (e.g. 'kinCares'). Each row carries a `path` so the mock can
   * synthesize `ref.parent.parent` for parent-doc resolution.
   */
  collectionGroupDocs?: Record<
    string,
    Array<{ id: string; path: string; data: Record<string, unknown> }>
  >;
  /**
   * Makes writes VISIBLE to later reads (#814).
   *
   * Off by default, because every existing suite is written against a static
   * fixture and a mock that suddenly remembered its own writes would change
   * what they assert. On, `set` / `update` / `create` / `delete` mutate the same
   * `docs` map that `get()` reads, which is what an idempotency test needs: the
   * whole claim is "the SECOND attempt sees what the first one wrote", and
   * against a static fixture that attempt sees nothing and the test passes for
   * the wrong reason.
   *
   * `set` replaces, `set(..., { merge: true })` and `update` shallow-merge, and
   * `create` still refuses a path that already exists, so two attempts racing
   * one key are really refereed here rather than assumed.
   */
  writeThrough?: boolean;
} = {}) {
  const docs = opts.docs ?? {};
  const writeThrough = opts.writeThrough === true;
  const queryDocs = opts.queryDocs ?? {};
  const collectionGroupDocs = opts.collectionGroupDocs ?? {};
  // `merge` stays a plain boolean for the many suites that assert it. `options`
  // carries the whole SetOptions object, because `{ merge: true }` and
  // `{ mergeFields: [...] }` are different writes on the server (a merge derives
  // its update mask from the payload's LEAF paths, so an absent field is left
  // untouched; a mergeFields parent path replaces its whole subtree) and a
  // boolean cannot tell them apart. NOTE: this mock still does not MODEL either
  // semantics — it records what was asked for, nothing more.
  const writes: Array<{
    path: string;
    data: Record<string, unknown>;
    merge: boolean;
    options?: SetOptionsLike;
  }> = [];
  const adds: Array<{ collection: string; data: Record<string, unknown>; id: string }> = [];
  const deletes: string[] = [];
  let autoCounter = 0;
  const docRefCache = new Map<string, any>();

  /** Synthesizes the `.parent.parent` chain for a nested doc path. */
  function parentChain(path: string): any {
    const segs = path.split('/');
    // Drop the doc id to get the collection path, then drop the collection id
    // to get the parent doc path (if any).
    const collectionSegs = segs.slice(0, -1); // .../bookings/{batchId}/kinCares
    const parentDocSegs = collectionSegs.slice(0, -1); // .../bookings/{batchId}
    const parentDocPath = parentDocSegs.length >= 2 ? parentDocSegs.join('/') : null;
    return {
      // collection ref shim — only `.parent` (the parent doc) is used by callers
      parent: parentDocPath
        ? makeDocRef(parentDocPath)
        : { id: collectionSegs[collectionSegs.length - 1] ?? null, parent: null },
    };
  }

  function makeDocRef(path: string): any {
    const ref: any = {
      id: path.split('/').pop(),
      path,
      parent: parentChain(path),
      // Real DocumentReferences carry `.firestore`, and a caller that only ever
      // holds a ref uses it to reach `batch()`, `getAll()` and `runTransaction()`
      // without being handed the database separately. `lib/fanoutResume.ts` is
      // written that way on purpose, so that the fan-out engine takes an anchor
      // row and nothing else. A getter rather than a field because `fakeDb` is
      // declared below this function.
      get firestore() {
        return fakeDb;
      },
      get: vi.fn(async () => {
        const data = docs[path];
        return {
          exists: data != null,
          data: () => data ?? undefined,
          id: path.split('/').pop(),
          ref,
        };
      }),
      set: vi.fn(async (data: Record<string, unknown>, options?: SetOptionsLike) => {
        writes.push({ path, data, merge: !!options?.merge, options });
        if (writeThrough) {
          docs[path] = options?.merge ? { ...(docs[path] ?? {}), ...data } : { ...data };
        }
      }),
      update: vi.fn(async (data: Record<string, unknown>) => {
        writes.push({ path, data, merge: true });
        if (writeThrough) docs[path] = { ...(docs[path] ?? {}), ...data };
      }),
      // `create()` is the one write whose OUTCOME depends on what is already
      // stored, so unlike set/update it cannot just record the intent: a caller
      // reaching for it is asking Firestore to referee the collision, and a
      // shim that always succeeded would make every such test pass. Rejects
      // with gRPC status 6 (ALREADY_EXISTS), the real code.
      create: vi.fn(async (data: Record<string, unknown>) => {
        if (docs[path] != null) {
          throw Object.assign(new Error(`ALREADY_EXISTS: ${path}`), { code: 6 });
        }
        writes.push({ path, data, merge: false });
        if (writeThrough) docs[path] = { ...data };
      }),
      delete: vi.fn(async () => {
        deletes.push(path);
        if (writeThrough) delete docs[path];
      }),
      collection: (sub: string) => makeCollection(`${path}/${sub}`),
    };
    return ref;
  }

  function buildSnapshot(rows: Row[]): any {
    const snapshotDocs = rows.map((r) => ({
      id: r.id,
      exists: true,
      data: () => r.data,
      // Real Firestore QueryDocumentSnapshots always carry `.ref` — needed
      // by any caller that does `.where(...).get()` then batch-updates the
      // matched docs (e.g. markMessagesRead).
      ref: makeDocRef(r.docPath),
    }));
    return {
      docs: snapshotDocs,
      size: snapshotDocs.length,
      empty: snapshotDocs.length === 0,
      forEach: (fn: (d: unknown) => void) => snapshotDocs.forEach(fn),
    };
  }

  /**
   * A query is an immutable constraint list over a late-bound row source, so
   * `const base = q.orderBy(...)` can be re-derived per page without the
   * previous page's cursor leaking in (see `paginateQuery`).
   */
  function makeQuery(source: () => Row[], constraints: Constraint[]): any {
    const derive = (c: Constraint) => makeQuery(source, [...constraints, c]);
    const run = () => applyConstraints(source(), constraints);
    const q: any = {
      where: vi.fn((field: unknown, op: string, value: unknown) =>
        derive({ kind: 'where', field: selField(field), op, value }),
      ),
      orderBy: vi.fn((field: unknown, dir: 'asc' | 'desc' = 'asc') =>
        derive({ kind: 'orderBy', field: selField(field), dir }),
      ),
      limit: vi.fn((n: unknown) => {
        // Mirrors the real SDK's validateInteger('limit', n) — the source of
        // MYTRIBE-FUNCTIONS-4, where a wasm client sent 20.5.
        if (typeof n !== 'number' || !Number.isInteger(n)) {
          throw new Error('Value for argument "limit" is not a valid integer.');
        }
        return derive({ kind: 'limit', n });
      }),
      startAfter: vi.fn((...args: unknown[]) => derive({ kind: 'startAfter', args })),
      // `.select()` (ids-only or field-projected query) is a no-op passthrough
      // here — the mock's queryDocs fixture already controls exactly what
      // `.data()` returns, same as a real projected query would.
      select: vi.fn(() => q),
      get: vi.fn(async () => buildSnapshot(run())),
      // Aggregation query shim. Counts the rows the same constraints would
      // return, driven off the static fixture rather than a live count of
      // `.add()`/`.delete()` calls made during the test.
      count: () => ({
        get: vi.fn(async () => ({ data: () => ({ count: run().length }) })),
      }),
    };
    return q;
  }

  function makeCollection(path: string): any {
    /**
     * The rows a query over `path` can see.
     *
     * The `queryDocs` fixture is the base. Under `writeThrough` the documents
     * this run has WRITTEN are merged on top, keyed by id, so a document created
     * during a test is findable by a query and not only by its own id.
     *
     * Added for #823, and the gap it closes was not cosmetic: `outboundFanoutSweep`
     * finds its work with `where('fanoutState', '==', 'running')`, and a blast
     * the test had just scheduled was invisible to it. The sweep did nothing,
     * every resume assertion failed, and the failure said "still running" rather
     * than "your mock cannot see this". Gated on `writeThrough` so the suites
     * written against a static fixture are untouched.
     */
    const source = (): Row[] => {
      const byId = new Map<string, Row>();
      for (const d of queryDocs[path] ?? []) {
        byId.set(d.id, { id: d.id, data: d.data, docPath: `${path}/${d.id}` });
      }
      if (writeThrough) {
        const prefix = `${path}/`;
        for (const [docPath, data] of Object.entries(docs)) {
          if (!docPath.startsWith(prefix)) continue;
          const rest = docPath.slice(prefix.length);
          // Direct children only: `a/b/c/d` is a document in a SUBcollection of
          // `a/b`, not a document in `a`.
          if (rest.includes('/') || data == null) continue;
          byId.set(rest, { id: rest, data, docPath });
        }
      }
      return [...byId.values()];
    };

    return Object.assign(makeQuery(source, []), {
      path,
      doc: (id?: string) => {
        if (id === undefined) {
          autoCounter += 1;
          return makeDocRef(`${path}/auto-${autoCounter}`);
        }
        return makeDocRef(`${path}/${id}`);
      },
      add: vi.fn(async (data: Record<string, unknown>) => {
        autoCounter += 1;
        const id = `auto-${autoCounter}`;
        adds.push({ collection: path, data, id });
        return makeDocRef(`${path}/${id}`);
      }),
    });
  }

  function makeCollectionGroup(name: string): any {
    const source = (): Row[] =>
      (collectionGroupDocs[name] ?? []).map((d) => ({
        id: d.id,
        data: d.data,
        docPath: d.path,
      }));
    return makeQuery(source, []);
  }

  // WriteBatch shim — records set/update/delete against the same in-memory
  // `writes`/`deletes` arrays so batch effects are assertable like direct writes.
  //
  // Under `writeThrough` the batch also APPLIES its writes, and only on
  // `commit()`. Before #823 it recorded intent and never applied, so a caller
  // that wrote through a batch and then read the result back saw nothing, which
  // would have made every roster the fan-out engine writes invisible to the run
  // that walks it, and the whole suite green for the wrong reason. Applying on
  // commit rather than on `set` is also the real semantics: an uncommitted batch
  // has changed nothing.
  function makeBatch(): any {
    const pending: Array<() => void> = [];
    return {
      set: (ref: any, data: any, options?: SetOptionsLike) => {
        writes.push({ path: ref.path, data, merge: !!options?.merge, options });
        pending.push(() => {
          if (!writeThrough) return;
          docs[ref.path] = options?.merge ? { ...(docs[ref.path] ?? {}), ...data } : { ...data };
        });
      },
      update: (ref: any, data: any) => {
        writes.push({ path: ref.path, data, merge: true });
        pending.push(() => {
          if (!writeThrough) return;
          docs[ref.path] = { ...(docs[ref.path] ?? {}), ...data };
        });
      },
      delete: (ref: any) => {
        deletes.push(ref.path);
        pending.push(() => {
          if (!writeThrough) return;
          delete docs[ref.path];
        });
      },
      commit: vi.fn(async () => {
        for (const apply of pending) apply();
        pending.length = 0;
      }),
    };
  }

  // Minimal transaction shim — serializes the inner callback so the read/write
  // sequence inside the txn observes the same in-memory `docs`/`writes` state
  // the rest of the mock uses. Concurrency is simulated by serializing pending
  // transactions in arrival order; for true contention testing the seam below
  // exposes a runTransactionImpl override (used by saveFormSchema dual-write
  // concurrency test).
  const fakeDb: any = {
    collection: (path: string) => makeCollection(path),
    collectionGroup: (name: string) => makeCollectionGroup(name),
    // Memoised, because real Firestore hands back an equal ref for an equal
    // path and a test that stubs `ref.create` on one object needs the handler
    // to reach that same object. Before this, every `db().doc(p)` built a
    // fresh shim and a stub could only ever affect the test's own copy.
    doc: (path: string) => docRefCache.get(path) ?? (() => {
      const ref = makeDocRef(path);
      docRefCache.set(path, ref);
      return ref;
    })(),
    // Firestore#getAll(...refs) — resolves each ref against the same `docs` map.
    getAll: vi.fn(async (...refs: any[]) => Promise.all(refs.map((r) => r.get()))),
    batch: () => makeBatch(),
    runTransaction: vi.fn(async <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
      const tx = {
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, options?: SetOptionsLike) =>
          ref.set(data, options),
        update: (ref: any, data: any) => ref.update(data),
        delete: (ref: any) => ref.delete(),
        // `create()` inside a transaction is refereed by the server exactly as it
        // is outside one, so it delegates to the ref's own create rather than to
        // `set`. It used to be `set`, which meant a transactional create could
        // never collide and any guard built on one passed vacuously.
        create: (ref: any, data: any) => ref.create(data),
      };
      return fn(tx);
    }),
  };

  return { db: fakeDb, writes, adds, deletes };
}
