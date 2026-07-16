// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AsyncRegion } from './AsyncRegion';
import type { Async } from '../lib/async';

/**
 * The DOM half of the load-state contract. async.test.ts proves the branching;
 * this proves the branch reaches the screen, which is the half that actually
 * bit the wasm admin (its `Today's Pack` panel HAS a correct Error branch, and
 * the stat card two inches above it still printed a zero).
 *
 * Target behaviour is Form Schemas, the one wasm screen that gets this right:
 *   "Couldn't load schemas / listFormSchemas failed: Admin claim required."
 *   [Retry]
 *   "Schemas unavailable while the load is failing."
 * It names the failing thing, offers recovery, and refuses to claim zero.
 */

const EMPTY_NODE = <p>No bookings yet. Enjoy the quiet.</p>;

function renderState(state: Async<string[]>) {
  return render(
    <AsyncRegion
      state={state}
      what="bookings"
      isEmpty={(d) => d.length === 0}
      empty={EMPTY_NODE}
    >
      {(data) => (
        <ul>
          {data.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
    </AsyncRegion>,
  );
}

describe('AsyncRegion', () => {
  it('renders the data when it is really there', () => {
    renderState({ status: 'ready', data: ['visit-1'] });
    expect(screen.getByText('visit-1')).toBeInTheDocument();
  });

  it('renders the empty state for a genuine zero', () => {
    renderState({ status: 'ready', data: [] });
    expect(screen.getByText('No bookings yet. Enjoy the quiet.')).toBeInTheDocument();
  });

  it('names what failed, rather than a generic apology', () => {
    renderState({ status: 'error', message: 'Missing or insufficient permissions.' });
    // U+2019, matching the &rsquo; the component renders. A straight quote here
    // passes review and fails at runtime.
    expect(screen.getByText('Couldn’t load bookings')).toBeInTheDocument();
    expect(screen.getByText('Missing or insufficient permissions.')).toBeInTheDocument();
  });

  it('THE BUG: never shows the empty state during an error', () => {
    // Tribal Intel, live: "Couldn't load training documents" stacked directly on
    // "No Tribal Intel yet ... will appear here once uploaded". Two answers.
    renderState({ status: 'error', message: 'Missing or insufficient permissions.' });

    expect(screen.queryByText('No bookings yet. Enjoy the quiet.')).not.toBeInTheDocument();
  });

  it('THE BUG: never leaves a spinner running after a failure', () => {
    // Templates, live: error banner AND "Loading templates..." that never ends.
    renderState({ status: 'error', message: 'boom' });
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
  });

  it('says it is unavailable while failing, instead of claiming nothing exists', () => {
    // The Form Schemas line. "No bookings yet" during an outage is a lie;
    // "unavailable while the load is failing" is the truth.
    renderState({ status: 'error', message: 'boom' });
    expect(screen.getByText(/unavailable while the load is failing/i)).toBeInTheDocument();
  });

  it('offers Retry when recovery is possible, and calls it', async () => {
    const retry = vi.fn();
    renderState({ status: 'error', message: 'boom', retry });

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(retry).toHaveBeenCalledOnce();
  });

  it('offers no Retry when there is nothing to retry with', () => {
    // A dead button is worse than no button (see the wasm chips that take a
    // required onClick and get passed {}).
    renderState({ status: 'error', message: 'boom' });
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('shows loading, and not the empty state, while in flight', () => {
    renderState({ status: 'loading' });
    expect(screen.getByText(/loading bookings/i)).toBeInTheDocument();
    expect(screen.queryByText('No bookings yet. Enjoy the quiet.')).not.toBeInTheDocument();
  });

  it('marks the error region as an alert so it is announced, not just coloured', () => {
    // The wasm canvas exposes NO accessibility tree at all (AO-15). Red text is
    // not an error message if nothing can read it.
    renderState({ status: 'error', message: 'boom' });
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t load bookings');
  });

  it('marks the in-flight region busy for the same reason', () => {
    renderState({ status: 'loading' });
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
