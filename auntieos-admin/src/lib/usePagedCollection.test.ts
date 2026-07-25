// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { limit, orderBy, startAfter, where } from 'firebase/firestore';

/**
 * Mirrors `firestore.test.ts`'s mocking exactly: the SDK is stubbed so the
 * constraints are assertable by call, and `getDocs` is a hand-resolved promise
 * so a page can be held in flight while the spec changes underneath it. That
 * hold is the point of the stale-page test below, which is the one failure this
 * hook exists to make impossible.
 */
const { getDocs } = vi.hoisted(() => ({ getDocs: vi.fn() }));
vi.mock('./firebase', () => ({ db: {} }));
vi.mock('firebase/firestore', () => ({
  collection: vi.fn(() => 'coll'),
  query: vi.fn((...a: unknown[]) => a),
  orderBy: vi.fn(() => 'orderBy'),
  limit: vi.fn(() => 'limit'),
  where: vi.fn(() => 'where'),
  startAfter: vi.fn(() => 'startAfter'),
  documentId: vi.fn(() => '__name__'),
  getDocs,
}));

import { usePagedCollection, type PagedCollectionSpec } from './usePagedCollection';
import { setTestScope } from './testScope';

interface Row {
  _id: string;
  n: number;
}

interface FakeDoc {
  id: string;
  data: () => unknown;
}

/** A snapshot of `count` docs, ids `${prefix}1..n`, each carrying `{ n }`. */
function snap(prefix: string, count: number): { docs: FakeDoc[] } {
  return {
    docs: Array.from({ length: count }, (_, i) => ({
      id: `${prefix}${String(i + 1)}`,
      data: () => ({ n: i + 1 }),
    })),
  };
}

/** A promise this test resolves or rejects by hand, so a page can be held open. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Resolve every already-queued microtask inside act, so state settles. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

const SPEC: PagedCollectionSpec = { path: 'invoices', order: ['createdAt', 'desc'], pageSize: 2 };

beforeEach(() => {
  getDocs.mockReset();
  vi.mocked(limit).mockClear();
  vi.mocked(orderBy).mockClear();
  vi.mocked(where).mockClear();
  vi.mocked(startAfter).mockClear();
  setTestScope(null);
});

describe('usePagedCollection: the first page', () => {
  it('starts loading, then reports ready with _id + data', async () => {
    getDocs.mockResolvedValue(snap('a', 2));
    const { result } = renderHook(() => usePagedCollection<Row>(SPEC));

    expect(result.current.state.status).toBe('loading');
    await settle();

    expect(result.current.state).toEqual({
      status: 'ready',
      data: [
        { _id: 'a1', n: 1 },
        { _id: 'a2', n: 2 },
      ],
    });
  });

  it('bounds the read server-side: orderBy + limit(pageSize) + every filter', async () => {
    getDocs.mockResolvedValue(snap('a', 2));
    renderHook(() =>
      usePagedCollection<Row>({ ...SPEC, filters: [['status', '==', 'OPEN']] }),
    );
    await settle();

    expect(orderBy).toHaveBeenCalledWith('createdAt', 'desc');
    expect(limit).toHaveBeenCalledWith(2);
    expect(where).toHaveBeenCalledWith('status', '==', 'OPEN');
    // The first page has nothing to page after.
    expect(startAfter).not.toHaveBeenCalled();
  });

  it('reports hasMore when the page came back full', async () => {
    getDocs.mockResolvedValue(snap('a', 2));
    const { result } = renderHook(() => usePagedCollection<Row>(SPEC));
    await settle();

    expect(result.current.hasMore).toBe(true);
  });

  it('reports hasMore false when the FIRST page is already short', async () => {
    getDocs.mockResolvedValue(snap('a', 1));
    const { result } = renderHook(() => usePagedCollection<Row>(SPEC));
    await settle();

    expect(result.current.hasMore).toBe(false);
  });
});

describe('usePagedCollection: the empty case', () => {
  it('is a real ready-with-nothing, not an error and not a pending load', async () => {
    getDocs.mockResolvedValue(snap('a', 0));
    const { result } = renderHook(() => usePagedCollection<Row>(SPEC));
    await settle();

    expect(result.current.state).toEqual({ status: 'ready', data: [] });
    expect(result.current.hasMore).toBe(false);
  });

  it('makes loadMore a no-op with nothing to page after', async () => {
    getDocs.mockResolvedValue(snap('a', 0));
    const { result } = renderHook(() => usePagedCollection<Row>(SPEC));
    await settle();
    getDocs.mockClear();

    act(() => result.current.loadMore());
    expect(getDocs).not.toHaveBeenCalled();
  });
});

describe('usePagedCollection: the cursor advances', () => {
  it('pages after the LAST doc of the page before, and appends rather than replaces', async () => {
    const page1 = snap('a', 2);
    getDocs.mockResolvedValueOnce(page1).mockResolvedValueOnce(snap('b', 2));
    const { result } = renderHook(() => usePagedCollection<Row>(SPEC));
    await settle();

    act(() => result.current.loadMore());
    await settle();

    expect(startAfter).toHaveBeenCalledWith(page1.docs[1]);
    expect(result.current.state).toEqual({
      status: 'ready',
      data: [
        { _id: 'a1', n: 1 },
        { _id: 'a2', n: 2 },
        { _id: 'b1', n: 1 },
        { _id: 'b2', n: 2 },
      ],
    });
    expect(result.current.hasMore).toBe(true);
  });

  it('drops hasMore on a SHORT final page, keeping the rows it did return', async () => {
    getDocs.mockResolvedValueOnce(snap('a', 2)).mockResolvedValueOnce(snap('b', 1));
    const { result } = renderHook(() => usePagedCollection<Row>(SPEC));
    await settle();

    act(() => result.current.loadMore());
    await settle();

    expect(result.current.hasMore).toBe(false);
    if (result.current.state.status !== 'ready') throw new Error('expected ready');
    expect(result.current.state.data.map((r) => r._id)).toEqual(['a1', 'a2', 'b1']);
  });

  it('refuses a second loadMore while one is already in flight', async () => {
    const held = deferred<{ docs: FakeDoc[] }>();
    getDocs.mockResolvedValueOnce(snap('a', 2)).mockReturnValueOnce(held.promise);
    const { result } = renderHook(() => usePagedCollection<Row>(SPEC));
    await settle();

    act(() => result.current.loadMore());
    expect(result.current.more.status).toBe('loading');
    act(() => result.current.loadMore());

    // Two clicks, one read: a double-click cannot double-append the same page.
    expect(getDocs).toHaveBeenCalledTimes(2);
    await act(async () => {
      held.resolve(snap('b', 2));
      await held.promise;
    });
  });
});

describe('usePagedCollection: a changed filter resets everything', () => {
  it('drops the loaded rows and re-reads from the top, with no cursor', async () => {
    getDocs.mockResolvedValueOnce(snap('a', 2)).mockResolvedValueOnce(snap('b', 2));
    const { result, rerender } = renderHook(
      (spec: PagedCollectionSpec) => usePagedCollection<Row>(spec),
      { initialProps: SPEC },
    );
    await settle();

    act(() => result.current.loadMore());
    await settle();
    vi.mocked(startAfter).mockClear();
    getDocs.mockResolvedValueOnce(snap('c', 1));

    rerender({ ...SPEC, filters: [['status', '==', 'PAID']] });
    await settle();

    if (result.current.state.status !== 'ready') throw new Error('expected ready');
    expect(result.current.state.data.map((r) => r._id)).toEqual(['c1']);
    expect(startAfter).not.toHaveBeenCalled();
    expect(result.current.hasMore).toBe(false);
  });

  it('does NOT re-read when the spec is re-created with identical values', async () => {
    getDocs.mockResolvedValue(snap('a', 2));
    const { rerender } = renderHook((spec: PagedCollectionSpec) => usePagedCollection<Row>(spec), {
      initialProps: SPEC,
    });
    await settle();
    expect(getDocs).toHaveBeenCalledTimes(1);

    rerender({ path: 'invoices', order: ['createdAt', 'desc'], pageSize: 2 });
    await settle();
    expect(getDocs).toHaveBeenCalledTimes(1);
  });

  it('a page still IN FLIGHT when the filter changes can never land on the new list', async () => {
    // The corruption this guards: operator clicks Load more on "Open", switches
    // to "Paid" before the read returns, and page 2 of OPEN appends itself under
    // the PAID rows. The list would then be a silent mixture of two filters,
    // which is exactly the kind of confident-but-wrong screen this app forbids.
    const stale = deferred<{ docs: FakeDoc[] }>();
    getDocs.mockResolvedValueOnce(snap('open', 2)).mockReturnValueOnce(stale.promise);

    const { result, rerender } = renderHook(
      (spec: PagedCollectionSpec) => usePagedCollection<Row>(spec),
      { initialProps: SPEC },
    );
    await settle();

    act(() => result.current.loadMore());
    expect(result.current.more.status).toBe('loading');

    // Filter changes while page 2 of the OLD filter is still open.
    getDocs.mockResolvedValueOnce(snap('paid', 1));
    rerender({ ...SPEC, filters: [['status', '==', 'PAID']] });
    await settle();

    // Now the stale page finally answers.
    await act(async () => {
      stale.resolve(snap('open-page2', 2));
      await stale.promise;
    });

    if (result.current.state.status !== 'ready') throw new Error('expected ready');
    expect(result.current.state.data.map((r) => r._id)).toEqual(['paid1']);
    // And the reset cleared the in-flight marker rather than leaving the button
    // spinning forever on a page that will never be allowed to land.
    expect(result.current.more.status).toBe('ready');
    expect(result.current.hasMore).toBe(false);
  });

  it('a stale page that FAILS after a reset cannot post its error either', async () => {
    const stale = deferred<{ docs: FakeDoc[] }>();
    getDocs.mockResolvedValueOnce(snap('open', 2)).mockReturnValueOnce(stale.promise);

    const { result, rerender } = renderHook(
      (spec: PagedCollectionSpec) => usePagedCollection<Row>(spec),
      { initialProps: SPEC },
    );
    await settle();
    act(() => result.current.loadMore());

    getDocs.mockResolvedValueOnce(snap('paid', 1));
    rerender({ ...SPEC, filters: [['status', '==', 'PAID']] });
    await settle();

    await act(async () => {
      stale.reject(new Error('permission-denied'));
      await stale.promise.catch(() => undefined);
    });

    expect(result.current.more.status).toBe('ready');
    expect(result.current.state.status).toBe('ready');
  });
});

describe('usePagedCollection: errors are visible and retryable', () => {
  it('surfaces a failed FIRST page as Async error with a retry, never an empty list', async () => {
    getDocs.mockRejectedValueOnce(new Error('Missing or insufficient permissions'));
    const { result } = renderHook(() => usePagedCollection<Row>(SPEC));
    await settle();

    expect(result.current.state.status).toBe('error');
    if (result.current.state.status !== 'error') throw new Error('expected error');
    expect(result.current.state.message).toBe('Missing or insufficient permissions');
    expect(typeof result.current.state.retry).toBe('function');
  });

  it('recovers on retry', async () => {
    getDocs.mockRejectedValueOnce(new Error('nope')).mockResolvedValueOnce(snap('a', 1));
    const { result } = renderHook(() => usePagedCollection<Row>(SPEC));
    await settle();

    if (result.current.state.status !== 'error') throw new Error('expected error');
    act(() => result.current.state.status === 'error' && result.current.state.retry?.());
    await settle();

    expect(result.current.state).toEqual({ status: 'ready', data: [{ _id: 'a1', n: 1 }] });
  });

  it('surfaces a failed LOAD MORE without blanking the rows already on screen', async () => {
    getDocs.mockResolvedValueOnce(snap('a', 2)).mockRejectedValueOnce(new Error('page 2 failed'));
    const { result } = renderHook(() => usePagedCollection<Row>(SPEC));
    await settle();

    act(() => result.current.loadMore());
    await settle();

    expect(result.current.more.status).toBe('error');
    if (result.current.more.status !== 'error') throw new Error('expected error');
    expect(result.current.more.message).toBe('page 2 failed');
    expect(typeof result.current.more.retry).toBe('function');
    // The rows that DID load are still there. A failed page is an incomplete
    // list, not an unknown one.
    if (result.current.state.status !== 'ready') throw new Error('expected ready');
    expect(result.current.state.data.map((r) => r._id)).toEqual(['a1', 'a2']);
    // Still pageable: the cursor did not advance past a page that never arrived.
    expect(result.current.hasMore).toBe(true);
  });

  it('retries the same page from the same cursor after a load-more failure', async () => {
    const page1 = snap('a', 2);
    getDocs
      .mockResolvedValueOnce(page1)
      .mockRejectedValueOnce(new Error('page 2 failed'))
      .mockResolvedValueOnce(snap('b', 1));
    const { result } = renderHook(() => usePagedCollection<Row>(SPEC));
    await settle();

    act(() => result.current.loadMore());
    await settle();
    if (result.current.more.status !== 'error') throw new Error('expected error');
    act(() => result.current.more.status === 'error' && result.current.more.retry?.());
    await settle();

    expect(vi.mocked(startAfter).mock.calls).toEqual([[page1.docs[1]], [page1.docs[1]]]);
    if (result.current.state.status !== 'ready') throw new Error('expected ready');
    expect(result.current.state.data.map((r) => r._id)).toEqual(['a1', 'a2', 'b1']);
    expect(result.current.more.status).toBe('ready');
  });

  it('surfaces a query that will not even build, rather than blanking the screen', async () => {
    vi.mocked(orderBy).mockImplementationOnce(() => {
      throw new Error('invalid order field');
    });
    const { result } = renderHook(() => usePagedCollection<Row>(SPEC));
    await settle();

    expect(result.current.state.status).toBe('error');
    if (result.current.state.status !== 'error') throw new Error('expected error');
    expect(result.current.state.message).toBe('invalid order field');
    expect(getDocs).not.toHaveBeenCalled();
  });
});

describe('usePagedCollection: the sandbox scope', () => {
  it('pins a scopeable collection to the test tribe, exactly as useCollection does', async () => {
    setTestScope('test-kinfolk-001');
    getDocs.mockResolvedValue(snap('a', 1));
    renderHook(() => usePagedCollection<Row>(SPEC));
    await settle();

    expect(where).toHaveBeenCalledWith('kinfolkId', '==', 'test-kinfolk-001');
  });

  it('resolves a suppressed collection to a real empty instead of querying it', async () => {
    setTestScope('test-kinfolk-001');
    const { result } = renderHook(() =>
      usePagedCollection<Row>({ path: 'activity_log', order: ['createdAt', 'desc'], pageSize: 2 }),
    );
    await settle();

    expect(getDocs).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ status: 'ready', data: [] });
    expect(result.current.hasMore).toBe(false);
  });
});
