import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { GetMyBookingsResult, GetMyBookingsResultLiveVisit } from '../contracts/bookingContracts.generated';

const mocks = vi.hoisted(() => ({ getMyBookings: vi.fn<() => Promise<GetMyBookingsResult>>() }));
vi.mock('../api/portal', () => ({ getMyBookings: () => mocks.getMyBookings() }));

import { bookingsQueryKey, visitAfterNoAnswer } from './bookingsCache';

/**
 * #1919: after a booking write got no answer, the visit is read fresh and the
 * ask counts as sent only when the visit shows THAT ask.
 */
function visit(overrides: Partial<GetMyBookingsResultLiveVisit> = {}): GetMyBookingsResultLiveVisit {
  return { id: 'v1', status: 'confirmed', rescheduleRequestStatus: null, rescheduleRequestedStartTimeMs: null, ...overrides } as GetMyBookingsResultLiveVisit;
}
function list(v: GetMyBookingsResultLiveVisit, where: 'upcoming' | 'envelope' = 'upcoming'): GetMyBookingsResult {
  return where === 'upcoming'
    ? { liveVisit: null, upcoming: [v], recent: [], envelopes: [] }
    : ({ liveVisit: null, upcoming: [], recent: [], envelopes: [{ batchId: 'b1', kinCares: [v] }] } as unknown as GetMyBookingsResult);
}
const asked = (ms: number) => (v: GetMyBookingsResultLiveVisit) =>
  v.rescheduleRequestStatus === 'pending' && v.rescheduleRequestedStartTimeMs === ms;

describe('visitAfterNoAnswer (#1919)', () => {
  beforeEach(() => {
    mocks.getMyBookings.mockReset();
  });

  it('hands back the visit when the ask is on file, and leaves the fresh list in the cache', async () => {
    const qc = new QueryClient();
    const fresh = list(visit({ rescheduleRequestStatus: 'pending', rescheduleRequestedStartTimeMs: 42 }));
    mocks.getMyBookings.mockResolvedValue(fresh);
    const v = await visitAfterNoAnswer(qc, 'fam1', 'v1', asked(42));
    expect(v?.id).toBe('v1');
    expect(qc.getQueryData(bookingsQueryKey('fam1'))).toEqual(fresh);
  });

  it('finds a visit that is only on its envelope', async () => {
    mocks.getMyBookings.mockResolvedValue(list(visit({ rescheduleRequestStatus: 'pending', rescheduleRequestedStartTimeMs: 42 }), 'envelope'));
    expect((await visitAfterNoAnswer(new QueryClient(), 'fam1', 'v1', asked(42)))?.id).toBe('v1');
  });

  it('is null when a different time is waiting: that is not this send', async () => {
    mocks.getMyBookings.mockResolvedValue(list(visit({ rescheduleRequestStatus: 'pending', rescheduleRequestedStartTimeMs: 7 })));
    expect(await visitAfterNoAnswer(new QueryClient(), 'fam1', 'v1', asked(42))).toBeNull();
  });

  it('is null when nothing is on file', async () => {
    mocks.getMyBookings.mockResolvedValue(list(visit()));
    expect(await visitAfterNoAnswer(new QueryClient(), 'fam1', 'v1', asked(42))).toBeNull();
  });

  it('is null, never a throw, when the check itself cannot be read', async () => {
    mocks.getMyBookings.mockImplementation(async () => {
      throw new Error('offline');
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    expect(await visitAfterNoAnswer(qc, 'fam1', 'v1', asked(42))).toBeNull();
  });
});
