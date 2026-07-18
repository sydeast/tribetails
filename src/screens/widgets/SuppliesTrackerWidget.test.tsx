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
});
