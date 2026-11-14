import { describe, expect, it } from 'vitest';
import {
  bookingChip,
  bookingStatusChip,
  bookingStatusIcon,
  bookingTimelineIndex,
  isFinished,
  visitStageOf,
} from './portalFormat';

/**
 * #2029: a declined request and a cancelled visit are both stored
 * `cancelled`. The server's `requestDeclinedAtMs` tells them apart, and every
 * chip the household reads (Schedule's list chip, the booking page's badge and
 * Status tile) goes through `visitStageOf`.
 */
describe('a declined request reads Declined (#2029)', () => {
  const declined = { status: 'cancelled' as const, visitProgress: null, requestDeclinedAtMs: 1_763_000_000_000 };
  const cancelled = { status: 'cancelled' as const, visitProgress: null, requestDeclinedAtMs: null };

  it('is its own stage, apart from a cancellation', () => {
    expect(visitStageOf(declined)).toBe('declined');
    expect(visitStageOf(cancelled)).toBe('cancelled');
  });

  it('labels the Schedule list chip and the page badge DECLINED', () => {
    expect(bookingChip(visitStageOf(declined))).toEqual({ label: 'DECLINED', tone: 'done' });
    expect(bookingStatusChip(visitStageOf(declined))).toEqual({ label: 'DECLINED', tone: 'cancelled' });
    expect(bookingChip(visitStageOf(cancelled)).label).toBe('CANCELLED');
  });

  it('is finished, has no timeline position and no green check', () => {
    expect(isFinished(declined)).toBe(true);
    expect(bookingTimelineIndex('declined')).toBeNull();
    expect(bookingStatusIcon('declined')).toBe('✕');
  });

  it('reads an answer cached before the field existed as Cancelled, as it did', () => {
    expect(visitStageOf({ status: 'cancelled', visitProgress: null })).toBe('cancelled');
  });

  it('never reads a stamp on a visit that is not cancelled (a declined request approved later)', () => {
    expect(visitStageOf({ status: 'confirmed', visitProgress: null, requestDeclinedAtMs: 1 })).toBe('confirmed');
  });
});
