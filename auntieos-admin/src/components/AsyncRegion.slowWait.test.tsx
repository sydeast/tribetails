// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SLOW_WAIT_MS } from '../lib/slowWait';
import { AsyncRegion } from './AsyncRegion';

/**
 * The 2026-09-12 ruling, at the seam every admin region goes through.
 *
 * Asserted on the STATE CARRIER, not on `toBeVisible()`. jsdom reports a closed
 * `<details>` as visible and computes no layout at all, so "it is on screen" is
 * not a thing a jsdom spec can actually check; what it can check is that the
 * right node with the right role and name is in the tree. That is also the
 * assertion that survives a restyle.
 */
function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { value, configurable: true });
}

function Region({ retry }: { retry?: () => void }) {
  return (
    <AsyncRegion
      state={retry ? { status: 'loading', retry } : { status: 'loading' }}
      what="bookings"
      isEmpty={(d: string[]) => d.length === 0}
      empty={<p>No bookings.</p>}
    >
      {(d) => <p>{d.join(',')}</p>}
    </AsyncRegion>
  );
}

describe('AsyncRegion: loading indicator and slow-wait escalation', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setOnline(true);
  });
  afterEach(() => {
    vi.useRealTimers();
    setOnline(true);
  });

  it('renders a moving indicator for a pending read, beside the words', () => {
    render(<Region />);
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    // The spinner is the state carrier: role=img + an accessible name saying
    // what is loading, plus aria-busy. It is NOT a replacement for the
    // sentence, so both must be present.
    const spinner = screen.getByRole('img', { name: 'Loading bookings' });
    expect(spinner).toHaveAttribute('aria-busy', 'true');
    expect(spinner).toHaveClass('spinner');
    expect(region).toHaveTextContent('Loading bookings…');
  });

  it('does not offer a sync before the threshold', () => {
    render(<Region retry={() => {}} />);
    act(() => void vi.advanceTimersByTime(SLOW_WAIT_MS - 1));
    expect(screen.queryByRole('group', { name: 'bookings is taking a while' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
  });

  it('offers a sync once the wait passes the threshold, with the spinner still running', () => {
    render(<Region retry={() => {}} />);
    act(() => void vi.advanceTimersByTime(SLOW_WAIT_MS));
    expect(screen.getByRole('group', { name: 'bookings is taking a while' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeTruthy();
    // Still pessimistic: the read has not ended, so the indicator has not
    // either. A screen that swapped the spinner for the button would be
    // claiming the attempt was abandoned.
    expect(screen.getByRole('img', { name: 'Loading bookings' })).toBeTruthy();
  });

  it('tapping sync re-attempts and says what it is doing', async () => {
    const retry = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Region retry={retry} />);
    act(() => void vi.advanceTimersByTime(SLOW_WAIT_MS));

    await user.click(screen.getByRole('button', { name: 'Sync now' }));

    expect(retry).toHaveBeenCalledTimes(1);
    // The clock restarted, so the notice is gone again -- and when it comes
    // back it says the second attempt is the one in flight.
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
    act(() => void vi.advanceTimersByTime(SLOW_WAIT_MS));
    expect(screen.getByRole('group', { name: 'bookings is taking a while' })).toHaveTextContent(
      'Asked again. Still waiting on the server for bookings.',
    );
    expect(screen.getByRole('button', { name: 'Ask again' })).toBeTruthy();
  });

  it('never leaves a wait with no way forward when the producer has no retry', () => {
    render(<Region />);
    act(() => void vi.advanceTimersByTime(SLOW_WAIT_MS));
    expect(screen.getByRole('button', { name: 'Reload the page' })).toBeTruthy();
  });

  /**
   * THE HOLE THIS CAUGHT. `AsyncLoading` only draws the Spinner in its DEFAULT
   * branch, so the ~46 regions that passed their own bare sentence through
   * `loading=` kept a motionless line while every region that did not gained
   * one. The sweep's answer is that a `loading=` override must itself carry a
   * cue: `LoadingRow` is the idiom, and this is the test that says so.
   *
   * The escalation is unaffected either way, because the notice is a SIBLING of
   * the override rather than a replacement for it -- which is what lets a
   * screen keep a real skeleton and still gain a way forward at 10s.
   */
  it('a caller override still escalates, and is responsible for its own cue', () => {
    render(
      <AsyncRegion
        state={{ status: 'loading', retry: () => {} }}
        what="bookings"
        isEmpty={(d: string[]) => d.length === 0}
        empty={<p>No bookings.</p>}
        loading={<p className="bare">Loading bookings…</p>}
      >
        {(d) => <p>{d.join(',')}</p>}
      </AsyncRegion>,
    );
    // The override replaced the default, so the default's spinner is gone: a
    // bare-text override is exactly the motionless wait the ruling is about.
    expect(screen.queryByRole('img', { name: 'Loading bookings' })).toBeNull();
    // But the escalation still arrives, because it is a sibling.
    act(() => void vi.advanceTimersByTime(SLOW_WAIT_MS));
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeTruthy();
  });

  /**
   * An offline pause is not a slow server. The admin's offline treatment is
   * its own (RouteError), and a Sync button on a device with no signal fails
   * the moment it is pressed.
   */
  it('does not escalate while the device is offline', () => {
    setOnline(false);
    render(<Region retry={() => {}} />);
    act(() => void vi.advanceTimersByTime(SLOW_WAIT_MS * 6));
    expect(screen.queryByRole('group', { name: 'bookings is taking a while' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
    // The indicator is still there. Offline is a wait, just not a slow-server one.
    expect(screen.getByRole('img', { name: 'Loading bookings' })).toBeTruthy();
  });
});
