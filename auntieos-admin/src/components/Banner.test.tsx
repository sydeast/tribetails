// @vitest-environment jsdom
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Banner, type BannerTone } from './Banner';
import { Dialog } from './Dialog';

/**
 * The a11y half of this file is the point of the port, not decoration.
 *
 * The wasm admin this replaces renders to a canvas and exposes no accessibility
 * tree: verified 2026-07-15, zero navigation elements, zero buttons, zero labels.
 * Its TEST MODE notice and its "Couldn't load X" failures were, to a screen
 * reader, silence. React gets that back for free and these tests are what stops
 * us handing it away again in a refactor.
 */

const NON_ALERT_TONES: BannerTone[] = ['info', 'success', 'suggestion'];
const ALERT_TONES: BannerTone[] = ['warning', 'error'];
const ALL_TONES: BannerTone[] = [...NON_ALERT_TONES, ...ALERT_TONES];

describe('Banner tones', () => {
  it.each(ALL_TONES)('renders body and tone marker for %s', (tone) => {
    render(<Banner tone={tone}>Kennel is at capacity.</Banner>);

    expect(screen.getByText('Kennel is at capacity.')).toBeInTheDocument();
    // data-tone is what the stylesheet-independent assertion hangs off: jsdom
    // does not resolve var()/color-mix, so asserting on computed color here
    // would pass against an empty stylesheet and prove nothing.
    expect(document.querySelector(`[data-tone="${tone}"]`)).not.toBeNull();
  });

  it('defaults to the info tone', () => {
    render(<Banner>Nothing urgent.</Banner>);

    expect(document.querySelector('[data-tone="info"]')).not.toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Banner role=alert', () => {
  it.each(ALERT_TONES)('%s carries role=alert', (tone) => {
    render(<Banner tone={tone}>Couldn&rsquo;t load bookings.</Banner>);

    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t load bookings.');
  });

  it.each(NON_ALERT_TONES)('%s does NOT carry role=alert', (tone) => {
    render(<Banner tone={tone}>Saved.</Banner>);

    // Not an oversight: role=alert interrupts a screen reader mid-sentence. Spend
    // it on "Saved" and operators learn to ignore the interruption that matters.
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Banner dismiss', () => {
  it('renders no dismiss control without onDismiss', () => {
    render(<Banner tone="info">Static notice.</Banner>);

    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('calls onDismiss on click', async () => {
    const onDismiss = vi.fn();
    render(
      <Banner tone="warning" onDismiss={onDismiss}>
        TEST MODE is on.
      </Banner>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('gives the dismiss control a name, not a bare glyph', () => {
    render(
      <Banner tone="error" onDismiss={vi.fn()}>
        Failed.
      </Banner>,
    );

    // An unlabelled X button is exactly the wasm failure mode in DOM clothing.
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });
});

/**
 * #406: a banner with nothing external to notify (no local state to clear)
 * used to have no way to offer a close button at all. `dismissible` is the
 * component-level fix — one prop, no screen-side plumbing — and it carries
 * the same Escape/focus-restore contract `onDismiss` banners get for free.
 */
describe('Banner dismissible (#406)', () => {
  it('renders a close button with dismissible and no onDismiss', () => {
    render(
      <Banner tone="info" title="Archived" dismissible>
        Out of the working list.
      </Banner>,
    );

    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  it('removes itself from the DOM on click', async () => {
    render(
      <Banner tone="info" title="Archived" dismissible>
        Out of the working list.
      </Banner>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    // Folded/hidden-but-present would still pass toBeVisible()-style checks
    // in jsdom; assert it is actually gone.
    expect(screen.queryByText('Out of the working list.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('removes itself on Escape while focus is inside it', async () => {
    const user = userEvent.setup();
    render(
      <Banner tone="info" title="Archived" dismissible>
        Out of the working list.
      </Banner>,
    );

    screen.getByRole('button', { name: 'Dismiss' }).focus();
    await user.keyboard('{Escape}');

    expect(screen.queryByText('Out of the working list.')).toBeNull();
  });

  it('does not dismiss on Escape when focus is elsewhere on the page', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <button type="button">Somewhere else</button>
        <Banner tone="info" title="Archived" dismissible>
          Out of the working list.
        </Banner>
      </div>,
    );

    screen.getByRole('button', { name: 'Somewhere else' }).focus();
    await user.keyboard('{Escape}');

    expect(screen.getByText('Out of the working list.')).toBeInTheDocument();
  });

  it('returns focus to whatever opened it', async () => {
    const user = userEvent.setup();

    function Harness() {
      const [archived, setArchived] = useState(false);
      return (
        <div>
          <button type="button" onClick={() => setArchived(true)}>
            Archive
          </button>
          {archived && (
            <Banner tone="info" title="Archived" dismissible>
              Out of the working list.
            </Banner>
          )}
        </div>
      );
    }

    render(<Harness />);
    // Clicking Archive both triggers the mount AND leaves focus on the
    // button that caused it — the same sequence a real "Archive" action
    // would produce, and what the banner's mount-time snapshot should catch.
    await user.click(screen.getByRole('button', { name: 'Archive' }));

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.getByRole('button', { name: 'Archive' })).toHaveFocus();
  });

  it('stays inside an open Dialog: Escape on the banner does not close the dialog', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(
      <Dialog title="Invoice #123" onClose={onClose}>
        <Banner tone="info" title="Archived" dismissible>
          Out of the working list.
        </Banner>
      </Dialog>,
    );

    screen.getByRole('button', { name: 'Dismiss' }).focus();
    await user.keyboard('{Escape}');

    expect(screen.queryByText('Out of the working list.')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Invoice #123' })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('Banner slots', () => {
  it('renders title, pill, icon, and trailing together', () => {
    render(
      <Banner
        tone="warning"
        title="Calendar sync is stubbed"
        pillLabel="stubbed"
        icon={<span data-testid="glyph">!</span>}
        trailing={<button type="button">Retry</button>}
      >
        Bookings will not reach Google until the key is set.
      </Banner>,
    );

    expect(screen.getByRole('heading', { name: 'Calendar sync is stubbed' })).toBeInTheDocument();
    expect(screen.getByText('STUBBED')).toBeInTheDocument(); // uppercased by the component
    expect(screen.getByTestId('glyph')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('omits the head row when neither title nor pill is given', () => {
    const { container } = render(<Banner tone="info">Body only.</Banner>);

    expect(container.querySelector('.banner-head')).toBeNull();
  });

  it('marks the accent rail and glyph decorative', () => {
    const { container } = render(
      <Banner tone="error" icon={<span>x</span>}>
        Failed.
      </Banner>,
    );

    // The rail and glyph repeat what the tone and copy already say. Announced,
    // they are just noise ahead of the message.
    expect(container.querySelector('.banner-rail')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('.banner-glyph')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('Banner border treatment', () => {
  it('is solid by default and dashed on request', () => {
    const { container: solid } = render(<Banner tone="info">Live state.</Banner>);
    expect(solid.querySelector('.banner')?.classList.contains('banner-dashed')).toBe(false);

    const { container: dashed } = render(
      <Banner tone="warning" dashed>
        Advisory state.
      </Banner>,
    );
    expect(dashed.querySelector('.banner')?.classList.contains('banner-dashed')).toBe(true);
  });

  it('keeps a caller className alongside its own', () => {
    const { container } = render(
      <Banner tone="info" className="dashboard-notice">
        Notice.
      </Banner>,
    );

    const el = container.querySelector('.banner');
    expect(el?.classList.contains('dashboard-notice')).toBe(true);
  });
});
