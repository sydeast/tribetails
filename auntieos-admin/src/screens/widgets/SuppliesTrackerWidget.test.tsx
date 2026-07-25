// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { SupplyList } from '../../api/supplies';

const { listSupplies, adjustSupply } = vi.hoisted(() => ({
  listSupplies: vi.fn(),
  adjustSupply: vi.fn(),
}));
vi.mock('../../api/supplies', async (orig) => ({
  ...(await orig<typeof import('../../api/supplies')>()),
  listSupplies,
  adjustSupply,
}));

import { SuppliesTrackerWidget } from './SuppliesTrackerWidget';

function list(over: Partial<SupplyList> = {}): SupplyList {
  return {
    lowCount: 1,
    supplies: [
      { _id: 's1', name: 'Poop bags', onHand: 2, par: 10, unit: 'rolls' },
      { _id: 's2', name: 'Treats', onHand: 40, par: 10, unit: 'bags' },
    ],
    ...over,
  };
}

beforeEach(() => {
  listSupplies.mockReset();
  adjustSupply.mockReset();
});

describe('SuppliesTrackerWidget', () => {
  it('headlines the low count and lists only the low supplies', async () => {
    listSupplies.mockResolvedValue(list());
    render(<SuppliesTrackerWidget />);

    expect(await screen.findByText('Poop bags')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument(); // lowCount headline
    expect(screen.getByText('2 / 10 rolls')).toBeInTheDocument();
    expect(screen.queryByText('Treats')).not.toBeInTheDocument(); // above par
  });

  it('restocks (+1) then reloads', async () => {
    listSupplies.mockResolvedValue(list());
    adjustSupply.mockResolvedValue({ onHand: 3 });
    render(<SuppliesTrackerWidget />);
    await screen.findByText('Poop bags');

    fireEvent.click(screen.getByRole('button', { name: '+1' }));

    await waitFor(() => expect(adjustSupply).toHaveBeenCalledWith('s1', 1));
    await waitFor(() => expect(listSupplies).toHaveBeenCalledTimes(2));
  });

  it('fails loud when the adjust rejects', async () => {
    listSupplies.mockResolvedValue(list());
    adjustSupply.mockRejectedValue(new Error('missing-supply'));
    render(<SuppliesTrackerWidget />);
    await screen.findByText('Poop bags');

    fireEvent.click(screen.getByRole('button', { name: '+1' }));
    expect(await screen.findByText(/adjustSupply failed:.*missing-supply/i)).toBeInTheDocument();
  });

  it('shows the stocked empty state when nothing is low', async () => {
    listSupplies.mockResolvedValue(list({ lowCount: 0 }));
    render(<SuppliesTrackerWidget />);
    expect(await screen.findByText(/stocked above par/i)).toBeInTheDocument();
  });

  // 17.3 Home board alignment. A supply name is the one elastic thing in the
  // row, so it is the one thing that may be cut, and a cut name has to stay
  // readable some other way. Before this the name and the count shared a
  // stacked cell and neither truncated, so a long name widened the row, the
  // card, and the whole Home grid column it sat in.
  it('truncates a long supply name in its own cell and keeps it reachable', async () => {
    const longName = 'Extra absorbent lavender scented compostable waste bags, jumbo case';
    listSupplies.mockResolvedValue(
      list({ supplies: [{ _id: 's1', name: longName, onHand: 2, par: 10, unit: 'rolls' }] }),
    );
    render(<SuppliesTrackerWidget />);

    const name = await screen.findByTitle(longName);
    expect(name).toHaveClass('supply-row__name');
    expect(name.textContent).toBe(longName);
    // The count is a sibling cell, not nested inside the name, so the grid can
    // align it independently of however long the name is.
    expect(name.querySelector('.supply-row__count')).toBeNull();
    const row = name.closest('li');
    expect(row?.querySelector('.supply-row__count')?.textContent).toBe('2 / 10 rolls');
  });

  it('gives the failed-restock message the whole row rather than a grid cell', async () => {
    listSupplies.mockResolvedValue(list());
    adjustSupply.mockRejectedValue(new Error('missing-supply'));
    render(<SuppliesTrackerWidget />);
    await screen.findByText('Poop bags');

    fireEvent.click(screen.getByRole('button', { name: '+1' }));
    const message = await screen.findByRole('alert');
    expect(message.parentElement).toHaveClass('supply-row__error');
  });
});
