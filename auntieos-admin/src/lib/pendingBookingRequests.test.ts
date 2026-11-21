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
const scope = vi.hoisted(() => ({ current: null as string | null }));
vi.mock('./testScope', () => ({ getTestScope: () => scope.current }));

import {
  NO_ANSWERED_REQUESTS,
  pendingLessAnswered,
  usePendingBookingRequests,
  withAnsweredRequest,
} from './pendingBookingRequests';

const request = (kinfolkId: string, batchId: string) => ({ kinfolkId, batchId, kinfolkName: 'The Wrens' });

beforeEach(() => {
  mocks.list.mockReset();
  mocks.signal.value = 0;
  scope.current = null;
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

  it('reads as an empty queue for a sandbox test admin, whose read is refused', async () => {
    scope.current = 'tribe-test';
    mocks.list.mockRejectedValue(new Error('permission-denied'));
    const { result } = renderHook(() => usePendingBookingRequests());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.status === 'ready' && result.current.data.size).toBe(0);
  });
});

describe('answered requests leave the queue at once (#1877)', () => {
  const req = (kinfolkId: string, batchId: string) => ({ kinfolkId, batchId }) as never;
  const queue = new Map([
    ['kf1/b1', req('kf1', 'b1')],
    ['kf2/b2', req('kf2', 'b2')],
  ]);
  it('drops a request answered against the queue in hand', () => {
    const answered = withAnsweredRequest(NO_ANSWERED_REQUESTS, queue, 'kf1/b1');
    expect([...(pendingLessAnswered(queue, answered)?.keys() ?? [])]).toEqual(['kf2/b2']);
  });

  it('lets the next read of the queue speak, so a request still waiting comes back', () => {
    const answered = withAnsweredRequest(NO_ANSWERED_REQUESTS, queue, 'kf1/b1');
    const reread = new Map(queue);
    expect(pendingLessAnswered(reread, answered)).toBe(reread);
  });

  it('keeps every answer made against the same read, and starts over on a new one', () => {
    const one = withAnsweredRequest(NO_ANSWERED_REQUESTS, queue, 'kf1/b1');
    const two = withAnsweredRequest(one, queue, 'kf2/b2');
    expect(pendingLessAnswered(queue, two)?.size).toBe(0);
    const reread = new Map(queue);
    expect([...withAnsweredRequest(two, reread, 'kf2/b2').keys]).toEqual(['kf2/b2']);
  });

  it('answers null while the queue is unknown', () => {
    expect(pendingLessAnswered(null, withAnsweredRequest(NO_ANSWERED_REQUESTS, null, 'kf1/b1'))).toBeNull();
  });
});
