// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import type { Async } from '../lib/async';
import type { BookingEntry } from '../api/bookings';

const useCollection = vi.hoisted(() => vi.fn());
vi.mock('../lib/firestore', () => ({ useCollection }));

import { BookingBatchFocus } from './BookingBatchFocus';

/**
 * #2397: what the lookup hands the list, read by read. The list draws these
 * visits, so what is handed up is what is on the screen.
 */
describe('BookingBatchFocus hands the list the visits of the booking it was opened for (#2397)', () => {
  const visit = (id: string, kinfolkId: string, batchId: string): BookingEntry =>
    ({ _id: id, kinfolkId, kinCareBatchId: batchId }) as BookingEntry;
  const riveras = [visit('vis_v1', 'kf1', 'b1'), visit('vis_v2', 'kf1', 'b1')];
  /** Each household's read, by the household the query names. */
  let reads: Record<string, Async<BookingEntry[]>>;
  beforeEach(() => {
    reads = {};
    useCollection.mockImplementation((spec: { filters: [string, string, string][] }) => {
      const kinfolkId = spec.filters[0]?.[2] ?? '';
      return reads[kinfolkId] ?? { status: 'loading' };
    });
  });
  function mount(focus: { kinfolkId: string; batchId: string }) {
    const onHighlight = vi.fn<(sessions: BookingEntry[]) => void>();
    const draw = (f: { kinfolkId: string; batchId: string }) => (
      <BookingBatchFocus focus={f} listStatus="ready" onHighlight={onHighlight} onDismiss={() => {}} />
    );
    const view = render(draw(focus));
    return { onHighlight, show: (f: { kinfolkId: string; batchId: string }) => view.rerender(draw(f)) };
  }

  it('keeps what it last found while the lookup has failed, and while it is read again', () => {
    reads['kf1'] = { status: 'ready', data: riveras };
    const { onHighlight, show } = mount({ kinfolkId: 'kf1', batchId: 'b1' });
    expect(onHighlight).toHaveBeenLastCalledWith(riveras);
    const calls = onHighlight.mock.calls.length;
    reads['kf1'] = { status: 'error', message: 'You appear to be offline.' };
    show({ kinfolkId: 'kf1', batchId: 'b1' });
    reads['kf1'] = { status: 'loading' };
    show({ kinfolkId: 'kf1', batchId: 'b1' });
    // Nothing was handed up since: the list still holds the two visits.
    expect(onHighlight.mock.calls.length).toBe(calls);
  });

  it('hands up nothing once a finished read no longer holds the booking', () => {
    reads['kf1'] = { status: 'ready', data: riveras };
    const { onHighlight, show } = mount({ kinfolkId: 'kf1', batchId: 'b1' });
    reads['kf1'] = { status: 'ready', data: [] };
    show({ kinfolkId: 'kf1', batchId: 'b1' });
    expect(onHighlight).toHaveBeenLastCalledWith([]);
  });

  it('clears the last booking’s visits when another booking is opened, before the new one is read', () => {
    reads['kf1'] = { status: 'ready', data: riveras };
    const { onHighlight, show } = mount({ kinfolkId: 'kf1', batchId: 'b1' });
    expect(onHighlight).toHaveBeenLastCalledWith(riveras);
    // Another household's booking, still being read.
    show({ kinfolkId: 'kf2', batchId: 'b7' });
    expect(onHighlight).toHaveBeenLastCalledWith([]);
    // Read: its own visits go up, and none of the first booking's.
    const wrens = [visit('vis_w1', 'kf2', 'b7')];
    reads['kf2'] = { status: 'ready', data: wrens };
    show({ kinfolkId: 'kf2', batchId: 'b7' });
    expect(onHighlight).toHaveBeenLastCalledWith(wrens);
  });
});
