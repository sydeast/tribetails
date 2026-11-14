// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

/**
 * #1864: the live nudge behind the household request queues. Firestore is
 * faked: each `onSnapshot` call is recorded with the query it was handed, so a
 * test can deliver snapshots and errors to it by hand.
 */
const fs = vi.hoisted(() => {
  type Listener = { query: unknown; next: () => void; error: (e: Error) => void; stopped: boolean };
  const listeners: Listener[] = [];
  return {
    listeners,
    collectionGroup: vi.fn((_db: unknown, id: string) => ({ group: id })),
    where: vi.fn((field: string, op: string, value: unknown) => ({ where: [field, op, value] })),
    orderBy: vi.fn((field: string, dir: string) => ({ orderBy: [field, dir] })),
    limit: vi.fn((n: number) => ({ limit: n })),
    query: vi.fn((base: unknown, ...constraints: unknown[]) => ({ base, constraints })),
    onSnapshot: vi.fn((query: unknown, next: () => void, error: (e: Error) => void) => {
      const l: Listener = { query, next, error, stopped: false };
      listeners.push(l);
      return () => {
        l.stopped = true;
      };
    }),
  };
});
vi.mock('firebase/firestore', () => fs);
vi.mock('./firebase', () => ({ db: { fake: true } }));
const scope = vi.hoisted(() => ({ current: null as string | null }));
vi.mock('./testScope', () => ({ getTestScope: () => scope.current }));

import { useVisitRequestSignal, type RequestQueueKind } from './visitRequestSignal';

const ALL: readonly RequestQueueKind[] = ['newBooking', 'reschedule', 'cancel'];

beforeEach(() => {
  fs.listeners.length = 0;
  scope.current = null;
});

describe('useVisitRequestSignal (#1864)', () => {
  it('listens with the query shapes the existing indexes serve', () => {
    renderHook(() => useVisitRequestSignal(ALL));
    expect(fs.listeners).toHaveLength(3);
    const shapes = fs.listeners.map((l) => JSON.stringify(l.query));
    expect(shapes).toContainEqual(expect.stringContaining('"where":["status","==","requested"]'));
    expect(shapes).toContainEqual(
      expect.stringMatching(/"where":\["rescheduleRequestStatus","==","pending"\].*"orderBy":\["rescheduleRequestedAt","asc"\]/),
    );
    expect(shapes).toContainEqual(expect.stringContaining('"orderBy":["cancelRequestedAt","asc"]'));
    for (const l of fs.listeners) expect(JSON.stringify(l.query)).toContain('"group":"kinCares"');
  });

  it('does not move on the first snapshot, which the first read already has', () => {
    const { result } = renderHook(() => useVisitRequestSignal(['newBooking']));
    act(() => fs.listeners[0]!.next());
    expect(result.current).toBe(0);
  });

  it('moves on every change after that', () => {
    const { result } = renderHook(() => useVisitRequestSignal(['newBooking']));
    act(() => fs.listeners[0]!.next());
    act(() => fs.listeners[0]!.next());
    expect(result.current).toBe(1);
    act(() => fs.listeners[0]!.next());
    expect(result.current).toBe(2);
  });

  it('stays quiet on a listener error, leaving the poll to cover it', () => {
    const { result } = renderHook(() => useVisitRequestSignal(['newBooking']));
    act(() => fs.listeners[0]!.error(new Error('permission-denied')));
    expect(result.current).toBe(0);
  });

  it('listens to nothing for a sandbox test admin, who may not read across households', () => {
    scope.current = 'tribe-test';
    renderHook(() => useVisitRequestSignal(ALL));
    expect(fs.listeners).toHaveLength(0);
  });

  it('stops every listener when the screen closes', () => {
    const { unmount } = renderHook(() => useVisitRequestSignal(ALL));
    unmount();
    expect(fs.listeners.every((l) => l.stopped)).toBe(true);
  });

  it('does not resubscribe on a re-render with an equal list', () => {
    const { rerender } = renderHook(({ kinds }) => useVisitRequestSignal(kinds), {
      initialProps: { kinds: ['cancel', 'newBooking'] as RequestQueueKind[] },
    });
    rerender({ kinds: ['newBooking', 'cancel'] });
    expect(fs.listeners).toHaveLength(2);
  });
});
