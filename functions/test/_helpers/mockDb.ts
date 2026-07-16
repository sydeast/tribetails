import { vi } from 'vitest';

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
} = {}) {
  const docs = opts.docs ?? {};
  const queryDocs = opts.queryDocs ?? {};
  const collectionGroupDocs = opts.collectionGroupDocs ?? {};
  const writes: Array<{ path: string; data: Record<string, unknown>; merge: boolean }> = [];
  const adds: Array<{ collection: string; data: Record<string, unknown>; id: string }> = [];
  const deletes: string[] = [];
  let autoCounter = 0;

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
      get: vi.fn(async () => {
        const data = docs[path];
        return {
          exists: data != null,
          data: () => data ?? undefined,
          id: path.split('/').pop(),
          ref,
        };
      }),
      set: vi.fn(async (data: Record<string, unknown>, options?: { merge?: boolean }) => {
        writes.push({ path, data, merge: !!options?.merge });
      }),
      update: vi.fn(async (data: Record<string, unknown>) => {
        writes.push({ path, data, merge: true });
      }),
      delete: vi.fn(async () => {
        deletes.push(path);
      }),
      collection: (sub: string) => makeCollection(`${path}/${sub}`),
    };
    return ref;
  }

  function makeCollection(path: string): any {
    function buildQueryResult() {
      return {
        docs: (queryDocs[path] ?? []).map((d) => ({
          id: d.id,
          data: () => d.data,
          // Real Firestore QueryDocumentSnapshots always carry `.ref` — needed
          // by any caller that does `.where(...).get()` then batch-updates the
          // matched docs (e.g. markMessagesRead).
          ref: makeDocRef(`${path}/${d.id}`),
        })),
      };
    }
    const chainable: any = {
      get: vi.fn(async () => buildQueryResult()),
    };
    chainable.where = vi.fn(() => chainable);
    chainable.orderBy = vi.fn(() => chainable);
    chainable.limit = vi.fn(() => chainable);
    chainable.startAfter = vi.fn(() => chainable);
    // `.select()` (ids-only or field-projected query) is a no-op passthrough
    // here — the mock's queryDocs fixture already controls exactly what
    // `.data()` returns, same as a real projected query would.
    chainable.select = vi.fn(() => chainable);

    return {
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
      where: chainable.where,
      orderBy: chainable.orderBy,
      limit: chainable.limit,
      select: chainable.select,
      get: chainable.get,
      // Aggregation query shim — like the rest of this mock, driven off the
      // static `queryDocs` fixture, not a live count of `.add()`/`.delete()`
      // calls made during the test. Tests must pre-configure `queryDocs` to
      // already reflect the state a real Firestore count would see.
      count: () => ({
        get: vi.fn(async () => ({ data: () => ({ count: (queryDocs[path] ?? []).length }) })),
      }),
    };
  }

  // Minimal transaction shim — serializes the inner callback so the read/write
  // sequence inside the txn observes the same in-memory `docs`/`writes` state
  // the rest of the mock uses. Concurrency is simulated by serializing pending
  // transactions in arrival order; for true contention testing the seam below
  // exposes a runTransactionImpl override (used by saveFormSchema dual-write
  // concurrency test).
  function makeCollectionGroup(name: string): any {
    function buildResult() {
      return {
        docs: (collectionGroupDocs[name] ?? []).map((d) => {
          const ref = makeDocRef(d.path);
          return {
            id: d.id,
            data: () => d.data,
            ref,
          };
        }),
      };
    }
    const chainable: any = { get: vi.fn(async () => buildResult()) };
    chainable.where = vi.fn(() => chainable);
    chainable.orderBy = vi.fn(() => chainable);
    chainable.limit = vi.fn(() => chainable);
    chainable.startAfter = vi.fn(() => chainable);
    return chainable;
  }

  // WriteBatch shim — records set/update/delete against the same in-memory
  // `writes`/`deletes` arrays so batch effects are assertable like direct writes.
  function makeBatch(): any {
    return {
      set: (ref: any, data: any, options?: { merge?: boolean }) => {
        writes.push({ path: ref.path, data, merge: !!options?.merge });
      },
      update: (ref: any, data: any) => {
        writes.push({ path: ref.path, data, merge: true });
      },
      delete: (ref: any) => {
        deletes.push(ref.path);
      },
      commit: vi.fn(async () => {}),
    };
  }

  const fakeDb: any = {
    collection: (path: string) => makeCollection(path),
    collectionGroup: (name: string) => makeCollectionGroup(name),
    doc: (path: string) => makeDocRef(path),
    // Firestore#getAll(...refs) — resolves each ref against the same `docs` map.
    getAll: vi.fn(async (...refs: any[]) => Promise.all(refs.map((r) => r.get()))),
    batch: () => makeBatch(),
    runTransaction: vi.fn(async <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
      const tx = {
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, options?: { merge?: boolean }) =>
          ref.set(data, options),
        update: (ref: any, data: any) => ref.update(data),
        delete: (ref: any) => ref.delete(),
        create: (ref: any, data: any) => ref.set(data),
      };
      return fn(tx);
    }),
  };

  return { db: fakeDb, writes, adds, deletes };
}
