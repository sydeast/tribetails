import { describe, it, expect, vi } from 'vitest';
import { batchFocusOf, batchSessionsOf, bookedLine } from './BookingBatchFocus';
import type { SessionEntry } from '../api/sessions';

/**
 * #2367: what became of a booking a notice opened, once its request is no
 * longer waiting: its visits, or gone, or a read that has not answered.
 */
describe('batchFocusOf', () => {
  const focus = { kinfolkId: 'kf1', batchId: 'b1' };
  const s = (over: Partial<SessionEntry>): SessionEntry => ({ _id: 'x', ...over });

  it('finds the visits approval made from the request', () => {
    const data = [
      s({ _id: 'vis_v1', kinfolkId: 'kf1', kinCareBatchId: 'b1' }),
      s({ _id: 'vis_v2', kinfolkId: 'kf1', kinCareBatchId: ' b1 ' }),
      s({ _id: 'vis_v3', kinfolkId: 'kf1', kinCareBatchId: 'b2' }),
      s({ _id: 'manual', kinfolkId: 'kf1' }),
    ];
    expect(batchFocusOf({ status: 'ready', data }, focus)).toEqual({ kind: 'booked', sessionIds: ['vis_v1', 'vis_v2'] });
  });

  it('hands back the records themselves, so the list can draw one its page lacks (#2397)', () => {
    const mine = s({ _id: 'vis_v1', kinfolkId: 'kf1', kinCareBatchId: 'b1', startTime: '2026-03-02T09:00:00' });
    const data = [
      mine,
      s({ _id: 'vis_v3', kinfolkId: 'kf1', kinCareBatchId: 'b2' }),
      s({ _id: 'vis_o1', kinfolkId: 'kf2', kinCareBatchId: 'b1' }),
    ];
    const found = batchSessionsOf(data, focus);
    expect(found).toHaveLength(1);
    expect(found[0]).toBe(mine);
    expect(batchSessionsOf([], focus)).toEqual([]);
  });
  it('never takes another household’s visit with the same request id', () => {
    const data = [s({ _id: 'vis_o1', kinfolkId: 'kf2', kinCareBatchId: 'b1' })];
    expect(batchFocusOf({ status: 'ready', data }, focus)).toEqual({ kind: 'gone' });
  });

  it('says gone when no visit carries the request', () => {
    expect(batchFocusOf({ status: 'ready', data: [] }, focus)).toEqual({ kind: 'gone' });
  });

  it('waits while the read runs, and passes a failure on with its retry', () => {
    expect(batchFocusOf({ status: 'loading' }, focus)).toEqual({ kind: 'looking' });
    const retry = vi.fn();
    expect(batchFocusOf({ status: 'error', message: 'offline', retry }, focus)).toEqual({
      kind: 'failed',
      message: 'offline',
      retry,
    });
    expect(batchFocusOf({ status: 'error', message: 'offline' }, focus)).toEqual({ kind: 'failed', message: 'offline' });
  });

  it('counts the visits in plain words', () => {
    expect(bookedLine(1)).toBe('Its visit is highlighted below.');
    expect(bookedLine(3)).toBe('Its 3 visits are highlighted below.');
  });
});
