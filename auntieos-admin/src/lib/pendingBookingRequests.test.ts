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
  markQueueReadSent,
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
  const readSentAt = (sentAtMs: number) => markQueueReadSent(new Map(queue), sentAtMs);

  it('drops a request answered after the queue in hand was read', () => {
    const inHand = readSentAt(100);
    const answered = withAnsweredRequest(NO_ANSWERED_REQUESTS, 'kf1/b1', 200);
    expect([...(pendingLessAnswered(inHand, answered)?.keys() ?? [])]).toEqual(['kf2/b2']);
  });

  it('lets a read sent after the answer speak, so a request still waiting comes back', () => {
    const answered = withAnsweredRequest(NO_ANSWERED_REQUESTS, 'kf1/b1', 200);
    const reread = readSentAt(300);
    expect(pendingLessAnswered(reread, answered)).toBe(reread);
  });

  it('does not let a read sent before the answer, landing after it, bring the request back', () => {
    const answered = withAnsweredRequest(NO_ANSWERED_REQUESTS, 'kf1/b1', 200);
    const lateOldRead = readSentAt(150);
    expect([...(pendingLessAnswered(lateOldRead, answered)?.keys() ?? [])]).toEqual(['kf2/b2']);
  });

  it('keeps every answer, across reads older than each of them', () => {
    const one = withAnsweredRequest(NO_ANSWERED_REQUESTS, 'kf1/b1', 200);
    const two = withAnsweredRequest(one, 'kf2/b2', 250);
    expect(pendingLessAnswered(readSentAt(100), two)?.size).toBe(0);
    // Sent between the two answers: it speaks for the first and not the second.
    expect([...(pendingLessAnswered(readSentAt(225), two)?.keys() ?? [])]).toEqual(['kf1/b1']);
  });

  it('answers null while the queue is unknown', () => {
    expect(pendingLessAnswered(null, withAnsweredRequest(NO_ANSWERED_REQUESTS, 'kf1/b1'))).toBeNull();
  });
});
