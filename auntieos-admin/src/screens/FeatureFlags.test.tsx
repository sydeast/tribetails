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
    getFeatureFlags.mockResolvedValue({ 'auntieos.communicate.commsRecap': true });
    render(<FeatureFlags />);
    const t = await screen.findByRole('switch', { name: /comms recap/i });
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

  it('disables the toggle while a save is in flight (single-flight)', async () => {
    getFeatureFlags.mockResolvedValue({});
    let release!: () => void;
    setFeatureFlags.mockReturnValue(
      new Promise<void>((r) => {
        release = () => r();
      }),
    );
    render(<FeatureFlags />);
    const recap = await screen.findByRole('switch', { name: /comms recap/i });
    await userEvent.click(recap);
    expect(recap).toBeDisabled();
    release();
    await waitFor(() => expect(recap).not.toBeDisabled());
  });

  it('shows a per-row saving indicator during the write and clears it on success', async () => {
    getFeatureFlags.mockResolvedValue({});
    let release!: () => void;
    setFeatureFlags.mockReturnValue(
      new Promise<void>((r) => {
        release = () => r();
      }),
    );
    render(<FeatureFlags />);
    const recap = await screen.findByRole('switch', { name: /comms recap/i });
    // Indicator absent before any write.
    expect(screen.queryByText(/saving/i)).toBeNull();
    await userEvent.click(recap);
    // Present on the committing row while the write is in flight.
    const saving = screen.getByRole('status');
    expect(saving).toHaveTextContent(/saving/i);
    expect(saving.closest('.flags__row')).toContainElement(recap);
    release();
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it('clears the per-row saving indicator when the write fails', async () => {
    getFeatureFlags.mockResolvedValue({});
    let reject!: (e: Error) => void;
    setFeatureFlags.mockReturnValue(
      new Promise<void>((_r, rej) => {
        reject = rej;
      }),
    );
    render(<FeatureFlags />);
    const recap = await screen.findByRole('switch', { name: /comms recap/i });
    await userEvent.click(recap);
    expect(screen.getByRole('status')).toHaveTextContent(/saving/i);
    reject(new Error('permission-denied'));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    // And the failure is surfaced fail-loud.
    expect(screen.getByText(/permission-denied/i)).toBeInTheDocument();
  });

  it('clears the write-error banner on the next toggle attempt', async () => {
    getFeatureFlags.mockResolvedValue({});
    setFeatureFlags.mockRejectedValueOnce(new Error('boom')).mockResolvedValue({});
    render(<FeatureFlags />);
    const recap = await screen.findByRole('switch', { name: /comms recap/i });
    await userEvent.click(recap);
    expect(await screen.findByText(/boom/i)).toBeInTheDocument();
    await userEvent.click(recap);
    await waitFor(() => expect(screen.queryByText(/boom/i)).toBeNull());
  });
});
