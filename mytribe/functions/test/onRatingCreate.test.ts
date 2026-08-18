import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ enqueue: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/wrapTrigger', () => ({
  wrapTrigger: (_name: string, fn: (...args: unknown[]) => unknown) => fn,
}));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: mocks.enqueue }));

beforeEach(() => {
  mocks.enqueue.mockReset().mockResolvedValue(undefined);
});

import { onRatingCreateHandler } from '../src/triggers/onRatingCreate';

function event(ratingId: string, rating: Record<string, unknown>) {
  return {
    params: { kinfolkId: 'fam3', ratingId },
    data: { data: () => rating },
  } as any;
}

/**
 * ISSUE #389's emitter half. `submitRating` writes the rating at
 * `families/{kinfolkId}/ratings/{visitId}` and, until now, wrote no `bookingId`
 * field, so this trigger's `rating.bookingId ?? null` was ALWAYS null. The
 * dispatcher's `resolveTargetRef` then fell through to the household reference,
 * and a rating notification's "Open" landed on the household profile rather
 * than the visit that was rated.
 */
describe('onRatingCreate: the visit a rating is about', () => {
  it('carries the rating doc id as bookingId when the document has no field of its own', async () => {
    // Every rating already in the collection looks like this. The doc id IS the
    // visit id, so the deep link is recoverable without a backfill.
    await onRatingCreateHandler(event('v1', { score: 5 }));
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'rating.submitted.good',
        data: expect.objectContaining({ kinfolkId: 'fam3', ratingId: 'v1', bookingId: 'v1' }),
      }),
    );
  });

  it('prefers the stored bookingId when the document carries one', async () => {
    await onRatingCreateHandler(event('v1', { score: 2, bookingId: 'v1' }));
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'rating.submitted.bad',
        data: expect.objectContaining({ bookingId: 'v1' }),
      }),
    );
  });

  it('never dispatches a null bookingId, which is what sent Open to the household', async () => {
    await onRatingCreateHandler(event('v9', { score: 1, comment: 'not good' }));
    const dispatched = mocks.enqueue.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(dispatched.data.bookingId).not.toBeNull();
    expect(dispatched.data.bookingId).toBe('v9');
  });

  it('still ignores a document with no numeric score', async () => {
    await onRatingCreateHandler(event('v1', { comment: 'no score' }));
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
