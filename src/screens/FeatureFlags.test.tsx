// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const getFeatureFlags = vi.fn();
const setFeatureFlags = vi.fn();
vi.mock('../api/featureFlags', () => ({
  getFeatureFlags: () => getFeatureFlags(),
  setFeatureFlags: (f: unknown) => setFeatureFlags(f),
}));

import { FeatureFlags } from './FeatureFlags';

beforeEach(() => {
  getFeatureFlags.mockReset();
  setFeatureFlags.mockReset();
});

describe('FeatureFlags screen', () => {
  it('loads flags and reflects current state on the toggles', async () => {
    getFeatureFlags.mockResolvedValue({ 'auntieos.settings.integrationManage': true });
    render(<FeatureFlags />);
    const t = await screen.findByRole('switch', { name: /integration manage/i });
    expect(t).toHaveAttribute('aria-checked', 'true');
  });

  it('optimistically flips a toggle and persists via setFeatureFlags', async () => {
    getFeatureFlags.mockResolvedValue({});
    setFeatureFlags.mockResolvedValue({});
    render(<FeatureFlags />);
    const t = await screen.findByRole('switch', { name: /comms recap/i });
    expect(t).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(t);
    expect(t).toHaveAttribute('aria-checked', 'true');
    expect(setFeatureFlags).toHaveBeenCalledWith({ 'auntieos.communicate.commsRecap': true });
  });

  it('reverts and fails loud when the write is rejected', async () => {
    getFeatureFlags.mockResolvedValue({});
    setFeatureFlags.mockRejectedValue(new Error('permission-denied'));
    render(<FeatureFlags />);
    const t = await screen.findByRole('switch', { name: /comms recap/i });
    await userEvent.click(t);
    await waitFor(() => expect(t).toHaveAttribute('aria-checked', 'false')); // reverted
    expect(screen.getByText(/permission-denied/i)).toBeInTheDocument();
  });

  it('surfaces a load failure instead of rendering a false empty state', async () => {
    getFeatureFlags.mockRejectedValue(new Error('offline'));
    render(<FeatureFlags />);
    expect(await screen.findByText(/offline/i)).toBeInTheDocument();
  });
});
