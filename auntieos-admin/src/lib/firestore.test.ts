// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { limit, orderBy, where } from 'firebase/firestore';

const { onSnapshot } = vi.hoisted(() => ({ onSnapshot: vi.fn() }));
vi.mock('./firebase', () => ({ db: {} }));
vi.mock('firebase/firestore', () => ({
  collection: vi.fn(() => 'coll'),
  doc: vi.fn((_db: unknown, path: string, id: string) => ({ path, id })),
  documentId: vi.fn(() => '__name__'),
  query: vi.fn((...a: unknown[]) => a),
  orderBy: vi.fn(() => 'orderBy'),
  limit: vi.fn(() => 'limit'),
  where: vi.fn(() => 'where'),
  onSnapshot,
}));

import { useCollection, useDocById, type CollectionSpec } from './firestore';
import { setTestScope } from './testScope';

type NextFn = (snap: { docs: { id: string; data: () => unknown }[] }) => void;
type ErrFn = (e: Error) => void;

function captureCallbacks() {
  const cb: { next?: NextFn; err?: ErrFn; unsub: () => void } = { unsub: vi.fn() };
  onSnapshot.mockImplementation((_q: unknown, next: NextFn, err: ErrFn) => {
    cb.next = next;
    cb.err = err;
    return cb.unsub;
  });
  return cb;
}

beforeEach(() => {
  onSnapshot.mockReset().mockReturnValue(() => {});
  vi.mocked(limit).mockClear();
  vi.mocked(orderBy).mockClear();
  vi.mocked(where).mockClear();
  // Module-level state on testScope.ts: clear it so one test's sandbox claim
  // cannot scope or suppress another test's query.
  setTestScope(null);
});

const SPEC: CollectionSpec = { path: 'c', order: ['seq', 'desc'], max: 10 };

describe('useCollection', () => {
  it('starts in loading, then maps a snapshot to ready with _id + data', () => {
    const cb = captureCallbacks();
    const { result } = renderHook(() => useCollection<{ _id: string; x: number }>(SPEC));
    expect(result.current.status).toBe('loading');
    act(() => cb.next!({ docs: [{ id: 'a', data: () => ({ x: 1 }) }] }));
    expect(result.current).toEqual({ status: 'ready', data: [{ _id: 'a', x: 1 }] });
  });

  it('AO-29: applies the spec bound server-side (orderBy + limit + filter)', () => {
    captureCallbacks();
    renderHook(() =>
      useCollection({ path: 'notifications', order: ['createdAt', 'desc'], max: 50, filters: [['recipientUid', '==', 'u1']] }),
    );
    expect(orderBy).toHaveBeenCalledWith('createdAt', 'desc');
    expect(limit).toHaveBeenCalledWith(50);
    expect(where).toHaveBeenCalledWith('recipientUid', '==', 'u1');
  });

  it('the doc id wins over a same-named data field', () => {
    const cb = captureCallbacks();
    const { result } = renderHook(() => useCollection<{ _id: string }>(SPEC));
    act(() => cb.next!({ docs: [{ id: 'real', data: () => ({ _id: 'IMPOSTER' }) }] }));
    expect(result.current).toEqual({ status: 'ready', data: [{ _id: 'real' }] });
  });

  it('surfaces a listener error as Async error with a retry (never a silent empty)', () => {
    const cb = captureCallbacks();
    const { result } = renderHook(() => useCollection(SPEC));
    act(() => cb.err!(new Error('permission-denied')));
    expect(result.current.status).toBe('error');
    if (result.current.status === 'error') {
      expect(result.current.message).toBe('permission-denied');
      expect(typeof result.current.retry).toBe('function');
    }
  });

  it('resubscribes when the spec changes, not on a same-valued rerender', () => {
    const cb = captureCallbacks();
    const { rerender } = renderHook((s: CollectionSpec) => useCollection(s), { initialProps: SPEC });
    // Same values, new object reference → no resubscribe (JSON key unchanged).
    rerender({ path: 'c', order: ['seq', 'desc'], max: 10 });
    expect(cb.unsub).not.toHaveBeenCalled();
    // Changed value → unsubscribe the old, subscribe the new.
    rerender({ path: 'c', order: ['seq', 'desc'], max: 25 });
    expect(cb.unsub).toHaveBeenCalledOnce();
  });

  it('unsubscribes on unmount', () => {
    const cb = captureCallbacks();
    const { unmount } = renderHook(() => useCollection(SPEC));
    unmount();
    expect(cb.unsub).toHaveBeenCalledOnce();
  });

  /**
   * The suppression half of the sandbox contract, end to end through the hook.
   * A test admin is denied outright on these collections by rules, so querying
   * them can only ever produce a red "Missing or insufficient permissions".
   * Resolving to a real empty is the honest answer for data that does not apply
   * to a sandbox account; the error path above stays reserved for failures the
   * operator can actually act on.
   */
  describe('sandbox suppression', () => {
    const TRIBAL_INTEL: CollectionSpec = {
      path: 'training_documents',
      order: ['uploadedAt', 'desc'],
      max: 200,
    };

    it('resolves a suppressed collection to an honest empty, never an error', () => {
      captureCallbacks();
      setTestScope('test-kinfolk-001');
      const { result } = renderHook(() => useCollection(TRIBAL_INTEL));
      expect(result.current).toEqual({ status: 'ready', data: [] });
    });

    it('never opens a listener it knows rules will deny', () => {
      captureCallbacks();
      setTestScope('test-kinfolk-001');
      renderHook(() => useCollection(TRIBAL_INTEL));
      expect(onSnapshot).not.toHaveBeenCalled();
    });

    it('still queries the same collection normally for the operator', () => {
      captureCallbacks();
      const { result } = renderHook(() => useCollection(TRIBAL_INTEL));
      expect(result.current.status).toBe('loading');
      expect(onSnapshot).toHaveBeenCalledOnce();
      expect(orderBy).toHaveBeenCalledWith('uploadedAt', 'desc');
    });
  });
});

/**
 * The by-id read behind every notification deep link (issue #389). A list query
 * answers "what is in the window"; a link names a record, and those are
 * different questions. Resolving the second with the first is what put the
 * operator on the Invoices LIST for a 46-day-old invoice.
 */
describe('useDocById', () => {
  type DocSnap = { exists: () => boolean; id: string; data: () => Record<string, unknown> };

  function captureDocCallbacks() {
    const cb: { next?: (s: DocSnap) => void; err?: (e: { code?: string; message: string }) => void; unsub: () => void } =
      { unsub: vi.fn() };
    onSnapshot.mockImplementation(
      (_ref: unknown, next: (s: DocSnap) => void, err: (e: { code?: string; message: string }) => void) => {
        cb.next = next;
        cb.err = err;
        return cb.unsub;
      },
    );
    return cb;
  }

  const found = (id: string, data: Record<string, unknown>): DocSnap => ({
    exists: () => true,
    id,
    data: () => data,
  });
  const absent: DocSnap = { exists: () => false, id: 'x', data: () => ({}) };

  it('starts loading, then resolves the document with its id merged in as _id', () => {
    const cb = captureDocCallbacks();
    const { result } = renderHook(() => useDocById<{ _id: string; total: number }>('invoices', 'inv9'));
    expect(result.current.status).toBe('loading');
    act(() => cb.next!(found('inv9', { total: 40 })));
    expect(result.current).toEqual({ status: 'ready', data: { _id: 'inv9', total: 40 } });
  });

  it('resolves a document that is not there to ready + null, never an error', () => {
    const cb = captureDocCallbacks();
    const { result } = renderHook(() => useDocById('invoices', 'gone'));
    act(() => cb.next!(absent));
    expect(result.current).toEqual({ status: 'ready', data: null });
  });

  it('treats permission-denied as "not available", not as a fault to report', () => {
    // A link into a record this account may not read is answered the same way a
    // deleted one is: saying which of the two it was would make the screen an
    // existence oracle for documents the operator cannot see.
    const cb = captureDocCallbacks();
    const { result } = renderHook(() => useDocById('invoices', 'someone-elses'));
    act(() => cb.err!({ code: 'permission-denied', message: 'Missing or insufficient permissions.' }));
    expect(result.current).toEqual({ status: 'ready', data: null });
  });

  it('surfaces any other read failure as an error WITH a retry', () => {
    const cb = captureDocCallbacks();
    const { result } = renderHook(() => useDocById('invoices', 'inv9'));
    act(() => cb.err!({ code: 'unavailable', message: 'backend unreachable' }));
    expect(result.current.status).toBe('error');
    if (result.current.status === 'error') {
      expect(result.current.message).toBe('backend unreachable');
      expect(typeof result.current.retry).toBe('function');
    }
  });

  it('settles immediately on a blank id instead of waiting on a read it will never issue', () => {
    captureDocCallbacks();
    const { result } = renderHook(() => useDocById('invoices', null));
    expect(result.current).toEqual({ status: 'ready', data: null });
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it('resubscribes when the id changes, and unsubscribes on unmount', () => {
    const cb = captureDocCallbacks();
    const { rerender, unmount } = renderHook((id: string) => useDocById('invoices', id), {
      initialProps: 'inv1',
    });
    rerender('inv1');
    expect(cb.unsub).not.toHaveBeenCalled();
    rerender('inv2');
    expect(cb.unsub).toHaveBeenCalledOnce();
    unmount();
    expect(cb.unsub).toHaveBeenCalledTimes(2);
  });

  describe('the sandbox scope, asked of one document', () => {
    it('hides a document belonging to another tribe', () => {
      const cb = captureDocCallbacks();
      setTestScope('test-kinfolk-001');
      const { result } = renderHook(() => useDocById('invoices', 'inv9'));
      act(() => cb.next!(found('inv9', { kinfolkId: 'some-other-tribe', total: 40 })));
      expect(result.current).toEqual({ status: 'ready', data: null });
    });

    it('hands back a document inside the sandbox', () => {
      const cb = captureDocCallbacks();
      setTestScope('test-kinfolk-001');
      const { result } = renderHook(() => useDocById<{ _id: string }>('invoices', 'inv9'));
      act(() => cb.next!(found('inv9', { kinfolkId: 'test-kinfolk-001' })));
      expect(result.current).toEqual({
        status: 'ready',
        data: { _id: 'inv9', kinfolkId: 'test-kinfolk-001' },
      });
    });

    it('never opens a read on a collection rules deny a sandbox account outright', () => {
      captureDocCallbacks();
      setTestScope('test-kinfolk-001');
      const { result } = renderHook(() => useDocById('training_documents', 't1'));
      expect(result.current).toEqual({ status: 'ready', data: null });
      expect(onSnapshot).not.toHaveBeenCalled();
    });
  });
});
