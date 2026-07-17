// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

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

import { useCollection } from './firestore';

type NextFn = (snap: { docs: { id: string; data: () => unknown }[] }) => void;
type ErrFn = (e: Error) => void;

/** Capture the onSnapshot success/error callbacks so a test can drive them under act(). */
function captureCallbacks() {
  const cb: { next?: NextFn; err?: ErrFn; unsub: () => void } = { unsub: vi.fn() };
  onSnapshot.mockImplementation((_q: unknown, next: NextFn, err: ErrFn) => {
    cb.next = next;
    cb.err = err;
    return cb.unsub;
  });
  return cb;
}

beforeEach(() => onSnapshot.mockReset().mockReturnValue(() => {}));

describe('useCollection', () => {
  it('maps a snapshot to ready with _id + data', () => {
    const cb = captureCallbacks();
    const { result } = renderHook(() =>
      useCollection<{ _id: string; x: number }>({ path: 'c', order: ['seq', 'desc'], max: 10 }),
    );
    act(() => cb.next!({ docs: [{ id: 'a', data: () => ({ x: 1 }) }] }));
    expect(result.current).toEqual({ status: 'ready', data: [{ _id: 'a', x: 1 }] });
  });

  it('surfaces a listener error as Async error (never a silent empty)', () => {
    const cb = captureCallbacks();
    const { result } = renderHook(() => useCollection({ path: 'c', order: ['seq', 'desc'], max: 10 }));
    act(() => cb.err!(new Error('permission-denied')));
    expect(result.current).toMatchObject({ status: 'error', message: 'permission-denied' });
  });

  it('unsubscribes on unmount', () => {
    const cb = captureCallbacks();
    const { unmount } = renderHook(() => useCollection({ path: 'c', order: ['seq', 'desc'], max: 10 }));
    unmount();
    expect(cb.unsub).toHaveBeenCalledOnce();
  });
});
