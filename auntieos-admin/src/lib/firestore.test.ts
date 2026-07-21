// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { limit, orderBy, where } from 'firebase/firestore';

const { onSnapshot } = vi.hoisted(() => ({ onSnapshot: vi.fn() }));
vi.mock('./firebase', () => ({ db: {} }));
vi.mock('firebase/firestore', () => ({
  collection: vi.fn(() => 'coll'),
  query: vi.fn((...a: unknown[]) => a),
  orderBy: vi.fn(() => 'orderBy'),
  limit: vi.fn(() => 'limit'),
  where: vi.fn(() => 'where'),
  onSnapshot,
}));

import { useCollection, type CollectionSpec } from './firestore';
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
