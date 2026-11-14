// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

/**
 * #2069: the waiting booking requests a notification row checks against,
 * read from the same callable Bookings > Review lists and kept live (#1864).
 */
const mocks = vi.hoisted(() => ({ list: vi.fn(), signal: { value: 0 } }));
vi.mock('../api/bookingRequests', () => ({ listPendingBookingRequests: () => mocks.list() }));
vi.mock('./visitRequestSignal', () => ({ useVisitRequestSignal: () => mocks.signal.value }));

import { usePendingBookingRequests } from './pendingBookingRequests';

const request = (kinfolkId: string, batchId: string) => ({ kinfolkId, batchId, kinfolkName: 'The Wrens' });

beforeEach(() => {
  mocks.list.mockReset();
  mocks.signal.value = 0;
});

describe('usePendingBookingRequests (#2069)', () => {
  it('is loading until the queue reads, then keyed by household and request', async () => {
    mocks.list.mockResolvedValue({ requests: [request('kf1', 'b1'), request('kf2', 'b1')] });
    const { result } = renderHook(() => usePendingBookingRequests());
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const data = result.current.status === 'ready' ? result.current.data : new Map();
    expect([...data.keys()]).toEqual(['kf1/b1', 'kf2/b1']);
  });

  it('fails loud, with a retry, rather than reading as an empty queue', async () => {
    mocks.list.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => usePendingBookingRequests());
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.status === 'error' && result.current.retry).toBeTruthy();
  });

  it('reads again when the live signal moves', async () => {
    mocks.list.mockResolvedValue({ requests: [request('kf1', 'b1')] });
    const { result, rerender } = renderHook(() => usePendingBookingRequests());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    mocks.list.mockResolvedValue({ requests: [] });
    mocks.signal.value = 1;
    rerender();
    await waitFor(() => expect(result.current.status === 'ready' && result.current.data.size).toBe(0));
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });
});
