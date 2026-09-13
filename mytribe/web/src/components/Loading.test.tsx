// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SLOW_WAIT_MS } from '../lib/slowWait';
import { LoadingLine } from './Loading';

/**
 * The 2026-09-12 ruling at the portal's loading seam.
 *
 * Asserted on the STATE CARRIER (`data-phase`, roles, accessible names) rather
 * than on `toBeVisible()`. jsdom computes no layout and reports a closed
 * `<details>` as visible, so "it is on screen" is not something a jsdom spec
 * can actually check; what it can check is that the right node with the right
 * role and name is in the tree, which is also the assertion that survives a
 * restyle.
 */
function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { value, configurable: true });
}

describe('LoadingLine', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setOnline(true);
  });
  afterEach(() => {
    vi.useRealTimers();
    setOnline(true);
  });

  it('renders the cue beside the words, not instead of them', () => {
    const { container } = render(
      <LoadingLine what="your schedule" retry={() => {}}>
        Loading your schedule…
      </LoadingLine>,
    );
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('data-phase', 'waiting');
    // The words survive: they say WHICH region is waiting, where a bare ring
    // would only say that something is.
    expect(region).toHaveTextContent('Loading your schedule…');
    expect(container.querySelector('.loading-spinner')).not.toBeNull();
  });

  it('does not offer a sync before the threshold', () => {
    render(
      <LoadingLine what="your schedule" retry={() => {}}>
        Loading your schedule…
      </LoadingLine>,
    );
    act(() => void vi.advanceTimersByTime(SLOW_WAIT_MS - 1));
    expect(screen.getByRole('status')).toHaveAttribute('data-phase', 'waiting');
    expect(screen.queryByRole('button', { name: 'Tap to sync' })).toBeNull();
  });

  it('offers tap-to-sync past the threshold, with the cue still running', () => {
    const { container } = render(
      <LoadingLine what="your schedule" retry={() => {}}>
        Loading your schedule…
      </LoadingLine>,
    );
    act(() => void vi.advanceTimersByTime(SLOW_WAIT_MS));
    expect(screen.getByRole('status')).toHaveAttribute('data-phase', 'slow');
    expect(screen.getByRole('group', { name: 'your schedule is taking a while' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tap to sync' })).toBeTruthy();
    // Still pessimistic. The read has not ended, so neither has the indicator,
    // and nothing on screen has been painted as though it had.
    expect(container.querySelector('.loading-spinner')).not.toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Loading your schedule…');
  });

  it('tapping sync retries and says what it is doing', async () => {
    const retry = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <LoadingLine what="your schedule" retry={retry}>
        Loading your schedule…
      </LoadingLine>,
    );
    act(() => void vi.advanceTimersByTime(SLOW_WAIT_MS));

    await user.click(screen.getByRole('button', { name: 'Tap to sync' }));

    expect(retry).toHaveBeenCalledTimes(1);
    // The clock restarted, so the wait is a plain wait again.
    expect(screen.getByRole('status')).toHaveAttribute('data-phase', 'waiting');
    act(() => void vi.advanceTimersByTime(SLOW_WAIT_MS));
    expect(screen.getByRole('group', { name: 'your schedule is taking a while' })).toHaveTextContent(
      'Asked again. Still waiting on Tribe Tails.',
    );
    expect(screen.getByRole('button', { name: 'Ask again' })).toBeTruthy();
  });

  it('never leaves a wait with no way forward when there is no retry', () => {
    render(<LoadingLine what="the composer">Loading composer…</LoadingLine>);
    act(() => void vi.advanceTimersByTime(SLOW_WAIT_MS));
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  });

  /**
   * An offline pause must keep the #805 treatment and must NOT become the
   * slow-server one. Two guards make that true and this exercises the inner
   * one: even if a caller wired a paused query straight into here, the phase
   * machine refuses to escalate while the device has no signal.
   */
  it('does not escalate while the device is offline', () => {
    setOnline(false);
    render(
      <LoadingLine what="your schedule" retry={() => {}}>
        Loading your schedule…
      </LoadingLine>,
    );
    act(() => void vi.advanceTimersByTime(SLOW_WAIT_MS * 6));
    expect(screen.getByRole('status')).toHaveAttribute('data-phase', 'waiting');
    expect(screen.queryByRole('button', { name: 'Tap to sync' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'your schedule is taking a while' })).toBeNull();
  });
});
