// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type Async } from './async';

const { bulkMarkNotificationsRead } = vi.hoisted(() => ({ bulkMarkNotificationsRead: vi.fn() }));
vi.mock('../api/notifications', async (orig) => ({
  ...(await orig<typeof import('../api/notifications')>()),
  bulkMarkNotificationsRead,
}));

import { useBulkMarkRead } from './useBulkMarkRead';

/**
 * The selection + bulk mark-read behaviour shared by the Notifications screen
 * and the Inbox's notifications digest. It had no tests of its own, and it grew
 * two members that are easy to get subtly wrong:
 *
 *   `selectAll(ids)`         takes the ids EXPLICITLY, so a caller can never
 *                            select rows that are off screen;
 *   `markSelectedRead(only)` sends a SUBSET while clearing the whole selection,
 *                            which is what stops a mixed selection reporting a
 *                            partial failure for a batch in which nothing failed.
 */
type Row = { _id: string };
function ready(ids: string[]): Async<readonly Row[]> {
  return { status: 'ready', data: ids.map((_id) => ({ _id })) };
}

beforeEach(() => {
  bulkMarkNotificationsRead.mockReset().mockResolvedValue(0);
});

describe('useBulkMarkRead selection', () => {
  it('starts with nothing selected', () => {
    const { result } = renderHook(() => useBulkMarkRead(ready(['a', 'b'])));
    expect(result.current.selectedIds.size).toBe(0);
  });

  it('toggles one id on and off', () => {
    const { result } = renderHook(() => useBulkMarkRead(ready(['a', 'b'])));
    act(() => result.current.toggle('a', true));
    expect([...result.current.selectedIds]).toEqual(['a']);
    act(() => result.current.toggle('a', false));
    expect(result.current.selectedIds.size).toBe(0);
  });

  it('selectAll REPLACES the selection with exactly the ids it was handed', () => {
    const { result } = renderHook(() => useBulkMarkRead(ready(['a', 'b', 'c'])));
    act(() => result.current.toggle('c', true));
    act(() => result.current.selectAll(['a', 'b']));
    expect([...result.current.selectedIds]).toEqual(['a', 'b']);
  });

  it('selectAll with an empty list clears the selection', () => {
    const { result } = renderHook(() => useBulkMarkRead(ready(['a'])));
    act(() => result.current.toggle('a', true));
    act(() => result.current.selectAll([]));
    expect(result.current.selectedIds.size).toBe(0);
  });

  it('prunes ids that have left the live stream, so the count never lies', () => {
    const { result, rerender } = renderHook(({ rows }) => useBulkMarkRead(rows), {
      initialProps: { rows: ready(['a', 'b']) },
    });
    act(() => result.current.selectAll(['a', 'b']));
    rerender({ rows: ready(['a']) });
    expect([...result.current.selectedIds]).toEqual(['a']);
  });

  it('does NOT prune on a failed read: an error is not evidence a row is gone', () => {
    const { result, rerender } = renderHook(({ rows }) => useBulkMarkRead(rows), {
      initialProps: { rows: ready(['a', 'b']) as Async<readonly Row[]> },
    });
    act(() => result.current.selectAll(['a', 'b']));
    rerender({ rows: { status: 'error', message: 'deadline-exceeded' } });
    expect(result.current.selectedIds.size).toBe(2);
  });
});

describe('useBulkMarkRead markSelectedRead', () => {
  it('sends the whole selection when no subset is given', async () => {
    bulkMarkNotificationsRead.mockResolvedValue(2);
    const { result } = renderHook(() => useBulkMarkRead(ready(['a', 'b'])));
    act(() => result.current.selectAll(['a', 'b']));
    await act(async () => {
      await result.current.markSelectedRead();
    });
    expect(bulkMarkNotificationsRead).toHaveBeenCalledWith(['a', 'b']);
  });

  it('sends only the subset when one is given, and still clears the whole selection', async () => {
    bulkMarkNotificationsRead.mockResolvedValue(1);
    const { result } = renderHook(() => useBulkMarkRead(ready(['a', 'b'])));
    act(() => result.current.selectAll(['a', 'b']));
    await act(async () => {
      await result.current.markSelectedRead(['a']);
    });
    expect(bulkMarkNotificationsRead).toHaveBeenCalledWith(['a']);
    // The operator's intent was the whole selection either way; the subset is
    // only about what the SERVER needed to be told.
    expect(result.current.selectedIds.size).toBe(0);
  });

  it('reports nothing when the subset is fully marked: no partial-failure sentence', async () => {
    bulkMarkNotificationsRead.mockResolvedValue(1);
    const { result } = renderHook(() => useBulkMarkRead(ready(['a', 'b'])));
    act(() => result.current.selectAll(['a', 'b']));
    await act(async () => {
      await result.current.markSelectedRead(['a']);
    });
    expect(result.current.error).toBeNull();
  });

  it('reports a genuine partial batch against what was SENT', async () => {
    bulkMarkNotificationsRead.mockResolvedValue(1);
    const { result } = renderHook(() => useBulkMarkRead(ready(['a', 'b'])));
    act(() => result.current.selectAll(['a', 'b']));
    await act(async () => {
      await result.current.markSelectedRead();
    });
    expect(result.current.error).toMatch(/Marked 1 of 2/);
  });

  it('keeps the selection on a rejection so the batch stays retryable', async () => {
    bulkMarkNotificationsRead.mockRejectedValue(new Error('permission-denied'));
    const { result } = renderHook(() => useBulkMarkRead(ready(['a'])));
    act(() => result.current.selectAll(['a']));
    await act(async () => {
      await result.current.markSelectedRead();
    });
    expect(result.current.error).toBe('permission-denied');
    expect([...result.current.selectedIds]).toEqual(['a']);
  });

  it('calls nothing at all for an empty selection', async () => {
    const { result } = renderHook(() => useBulkMarkRead(ready(['a'])));
    await act(async () => {
      await result.current.markSelectedRead();
    });
    expect(bulkMarkNotificationsRead).not.toHaveBeenCalled();
  });

  it('calls nothing for an empty explicit subset, even with rows selected', async () => {
    const { result } = renderHook(() => useBulkMarkRead(ready(['a'])));
    act(() => result.current.selectAll(['a']));
    await act(async () => {
      await result.current.markSelectedRead([]);
    });
    expect(bulkMarkNotificationsRead).not.toHaveBeenCalled();
  });

  it('refuses a second batch while one is in flight', async () => {
    let release!: (n: number) => void;
    bulkMarkNotificationsRead.mockReturnValue(
      new Promise<number>((r) => {
        release = r;
      }),
    );
    const { result } = renderHook(() => useBulkMarkRead(ready(['a'])));
    act(() => result.current.selectAll(['a']));
    act(() => void result.current.markSelectedRead());
    await waitFor(() => expect(result.current.busy).toBe(true));
    await act(async () => {
      await result.current.markSelectedRead();
    });
    expect(bulkMarkNotificationsRead).toHaveBeenCalledTimes(1);
    await act(async () => {
      release(1);
    });
  });
});
