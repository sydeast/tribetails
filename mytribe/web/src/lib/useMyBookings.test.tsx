// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMyBookings } from './useMyBookings';
import { BOOKINGS_POLL_MS, visitStageOf } from './portalFormat';

/**
 * #1823 / #1832: an open screen follows the Auntie's taps without a reload.
 * The clock is faked, so the 30-second re-read is driven, not waited for.
 */

const mocks = vi.hoisted(() => ({ getMyBookings: vi.fn() }));
vi.mock('../api/portal', () => ({ getMyBookings: (...args: unknown[]) => mocks.getMyBookings(...args) }));

function answer(status: string, visitProgress: string | null) {
  const visit = { id: 'v1', status, visitProgress, startTimeMs: Date.now() - 5 * 60_000, kinNames: ['Biscuit'] };
  const finished = status === 'completed';
  return { liveVisit: null, upcoming: finished ? [] : [visit], recent: finished ? [visit] : [], envelopes: [] };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.getMyBookings.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
/**
 * One re-read: the interval fires, then the answer it fetched is delivered.
 * React Query hands a result to its observers a tick after the cache takes it,
 * so the clock moves one more millisecond before anything is read back.
 */
async function turn() {
  await tick(BOOKINGS_POLL_MS);
  await tick(1);
}

describe('useMyBookings', () => {
  it('follows a visit from confirmed through to completed, then stops reading', async () => {
    mocks.getMyBookings
      .mockResolvedValueOnce(answer('confirmed', null))
      .mockResolvedValueOnce(answer('enRoute', 'enRoute'))
      .mockResolvedValueOnce(answer('active', 'active'))
      .mockResolvedValueOnce(answer('active', 'ended'))
      .mockResolvedValueOnce(answer('completed', 'ended'));

    const { result } = renderHook(() => useMyBookings('fam1'), { wrapper });
    await tick(0);
    expect(mocks.getMyBookings).toHaveBeenCalledWith('fam1');
    expect(visitStageOf(result.current.data!.upcoming[0]!)).toBe('confirmed');

    const seen: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      await turn();
      seen.push(visitStageOf(result.current.data!.upcoming[0]!));
    }
    expect(seen).toEqual(['enRoute', 'active', 'departed']);

    await turn();
    expect(result.current.data!.upcoming).toEqual([]);
    expect(result.current.data!.recent[0]!.status).toBe('completed');
    expect(mocks.getMyBookings).toHaveBeenCalledTimes(5);

    // Nothing is due any more, so the reading stops.
    await tick(BOOKINGS_POLL_MS * 4);
    expect(mocks.getMyBookings).toHaveBeenCalledTimes(5);
  });

  it('keeps the last answer on screen while the next one is fetched', async () => {
    let release: (v: unknown) => void = () => {};
    mocks.getMyBookings
      .mockResolvedValueOnce(answer('enRoute', 'enRoute'))
      .mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));

    const { result } = renderHook(() => useMyBookings('fam1'), { wrapper });
    await tick(0);
    await turn();
    expect(mocks.getMyBookings).toHaveBeenCalledTimes(2);
    expect(result.current.isFetching).toBe(true);
    expect(result.current.isPending).toBe(false);
    expect(result.current.data!.upcoming[0]!.status).toBe('enRoute');

    release(answer('active', 'active'));
    await tick(0);
    expect(result.current.data!.upcoming[0]!.status).toBe('active');
  });

  it('reads once when nothing is due', async () => {
    mocks.getMyBookings.mockResolvedValue({ liveVisit: null, upcoming: [], recent: [], envelopes: [] });
    renderHook(() => useMyBookings('fam1'), { wrapper });
    await tick(0);
    await tick(BOOKINGS_POLL_MS * 4);
    expect(mocks.getMyBookings).toHaveBeenCalledTimes(1);
  });

  it('a failed re-read keeps the last answer, raises no error, and tries again on the next turn', async () => {
    mocks.getMyBookings
      .mockResolvedValueOnce(answer('enRoute', 'enRoute'))
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValueOnce(answer('active', 'active'));

    const { result } = renderHook(() => useMyBookings('fam1'), { wrapper });
    await tick(0);
    await turn();
    expect(mocks.getMyBookings).toHaveBeenCalledTimes(2);
    // The screens answer `isError` with the full-page error. Not for this.
    expect(result.current.isError).toBe(false);
    expect(result.current.data!.upcoming[0]!.status).toBe('enRoute');
    await turn();
    expect(result.current.data!.upcoming[0]!.status).toBe('active');
  });

  it('a first read that fails is still an error', async () => {
    mocks.getMyBookings.mockRejectedValue(new Error('unavailable'));
    const { result } = renderHook(() => useMyBookings('fam1'), { wrapper });
    await tick(0);
    expect(result.current.isError).toBe(true);
    expect(result.current.data).toBeUndefined();
  });
});
