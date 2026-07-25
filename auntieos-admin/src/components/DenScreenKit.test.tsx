// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DenPanel,
  DenScreenHeading,
  EmptyHint,
  ErrorHint,
  ServicePill,
  StatCard,
  serviceTone,
} from './DenScreenKit';
import { asyncScalar, type Async, type ResolvedScalar } from '../lib/async';

/**
 * The StatCard block is the reason this file exists. The rest of the kit is
 * layout and can be re-checked by eye; the stat card is where the app makes a
 * numeric claim, and on 2026-07-15 it made one it could not support.
 */

function renderStat(value: ResolvedScalar<number>, feature = false) {
  return render(
    <StatCard label="Open bookings" value={value} trend="needs a reply" tone="orange" feature={feature} />,
  );
}

describe('StatCard', () => {
  it('renders a real value', () => {
    renderStat({ kind: 'value', value: 7 });
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('needs a reply')).toBeInTheDocument();
  });

  it('renders a genuine zero as 0', () => {
    // The counterpart to the bug: a proven zero is real news and must still show.
    // Fixing "0 on a failed read" by suppressing zeros would just break this.
    renderStat({ kind: 'value', value: 0 });
    expect(screen.getByText('0')).toBeInTheDocument();
    expect(screen.getByText('needs a reply')).toBeInTheDocument();
  });

  it('renders loading as neither a zero nor any number', () => {
    renderStat({ kind: 'loading' });

    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(screen.getByText('…')).toBeInTheDocument();
    // Nothing is known yet, so the trend must not assert anything either.
    expect(screen.queryByText('needs a reply')).not.toBeInTheDocument();
  });

  it('THE BUG: renders an error as a dash and never as 0', () => {
    // Production, 2026-07-15: "Open bookings: 0 / needs a reply" while the read
    // was permission-denied, and Home has no bookings panel, so this card was the
    // only surface that could have said so. It said zero.
    renderStat({ kind: 'error', message: 'Missing or insufficient permissions.' });

    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(screen.getByText('-')).toBeInTheDocument();
    expect(screen.getByText(/Missing or insufficient permissions\./)).toBeInTheDocument();
  });

  it('names what failed instead of only greying out', () => {
    renderStat({ kind: 'error', message: 'listBookings failed.' });
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t load open bookings: listBookings failed.');
  });

  it('drops the trend claim on an error, rather than pairing it with a dash', () => {
    // The second half of the live bug. "needs a reply" beside an unreadable count
    // is a claim about data nobody has.
    renderStat({ kind: 'error', message: 'boom' });
    expect(screen.queryByText('needs a reply')).not.toBeInTheDocument();
  });

  it('never fabricates a zero from a failed read, whatever the caller passes', () => {
    // The type-level point, executed: a caller holding a failed Async cannot get a
    // number out of it. `project` does not run, so there is no `?: 0` to write.
    const failed: Async<string[]> = { status: 'error', message: 'Missing or insufficient permissions.' };
    const project = vi.fn((rows: string[]) => rows.length);

    render(
      <StatCard label="Open bookings" value={asyncScalar(failed, project)} trend="needs a reply" tone="orange" />,
    );

    expect(project).not.toHaveBeenCalled();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(screen.getByText('-')).toBeInTheDocument();
  });

  it('formats a proven number when asked', () => {
    render(
      <StatCard
        label="Outstanding"
        value={{ kind: 'value', value: 1250 }}
        trend="across 3 invoices"
        tone="teal"
        formatValue={(v) => `$${v.toLocaleString('en-US')}`}
      />,
    );
    expect(screen.getByText('$1,250')).toBeInTheDocument();
  });

  it('never runs formatValue on a state that has no number', () => {
    const formatValue = vi.fn((v: number) => `$${v}`);
    render(
      <StatCard label="Outstanding" value={{ kind: 'error', message: 'boom' }} trend="x" tone="teal" formatValue={formatValue} />,
    );
    expect(formatValue).not.toHaveBeenCalled();
  });

  it('announces the in-flight state rather than only dimming it', () => {
    renderStat({ kind: 'loading' });
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('is a real button when it is clickable', async () => {
    const onClick = vi.fn();
    render(<StatCard label="Open bookings" value={{ kind: 'value', value: 2 }} trend="t" tone="orange" onClick={onClick} />);

    await userEvent.click(screen.getByRole('button', { name: /Open bookings/ }));

    expect(onClick).toHaveBeenCalledOnce();
  });

  it('is not a button when there is nothing to click', () => {
    renderStat({ kind: 'value', value: 2 });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('wears the shared lift when it is clickable', () => {
    render(<StatCard label="Open bookings" value={{ kind: 'value', value: 2 }} trend="t" tone="orange" onClick={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Open bookings/ })).toHaveClass('lift');
  });

  it('does NOT lift when there is nothing to click', () => {
    // The lift is a promise that clicking does something. A display-only stat
    // that rises under the pointer makes that promise and then breaks it, which
    // is the dead-control anti-pattern the Buttons.tsx convention exists for.
    const { container } = renderStat({ kind: 'value', value: 2 });
    expect(container.querySelector('.den-stat')).not.toHaveClass('lift');
  });

  it('marks the hero variant with the class that carries the brand gradient', () => {
    // `.den-stat--feature` is the hook the Tribe Gradient hangs on (see
    // DenScreenKit.css). The gradient is a mark, reserved for a hero moment, so
    // which cards claim to be one is a component decision and belongs pinned
    // here rather than only in a stylesheet nothing asserts against.
    const { container } = renderStat({ kind: 'value', value: 3 }, true);
    expect(container.querySelector('.den-stat--feature')).toBeInTheDocument();
  });

  it('does not mark an ordinary stat as the hero', () => {
    const { container } = renderStat({ kind: 'value', value: 3 });
    expect(container.querySelector('.den-stat--feature')).not.toBeInTheDocument();
    expect(container.querySelector('.den-stat')).toBeInTheDocument();
  });

  it('keeps the same honesty in the feature variant', () => {
    // The hero stat is the biggest number on the page, so a fabricated one there
    // is the most convincing. Same branch, same dash.
    renderStat({ kind: 'error', message: 'boom' }, true);
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(screen.getByText('-')).toBeInTheDocument();
  });
});

describe('DenScreenHeading', () => {
  it('renders the kicker and title', () => {
    render(<DenScreenHeading kicker="the den . home" title="Good morning" />);
    expect(screen.getByText('the den . home')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Good morning' })).toBeInTheDocument();
  });

  it('joins the accent tail into one heading', () => {
    render(<DenScreenHeading kicker="k" title="Good morning," accentTail="Auntie" />);
    expect(screen.getByRole('heading', { name: 'Good morning, Auntie' })).toBeInTheDocument();
  });

  it('renders the subtitle and trailing slot when given', () => {
    render(
      <DenScreenHeading kicker="k" title="t" subtitle="Three visits today." trailing={<button type="button">New</button>} />,
    );
    expect(screen.getByText('Three visits today.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New' })).toBeInTheDocument();
  });

  it('omits the optional parts when not given', () => {
    render(<DenScreenHeading kicker="k" title="t" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('DenPanel', () => {
  it('renders title, subtitle, and content', () => {
    render(
      <DenPanel title="Today's Pack" subtitle="3 visits">
        <p>Ranger, 9:00a</p>
      </DenPanel>,
    );
    expect(screen.getByText("Today's Pack")).toBeInTheDocument();
    expect(screen.getByText('3 visits')).toBeInTheDocument();
    expect(screen.getByText('Ranger, 9:00a')).toBeInTheDocument();
  });

  it('is not a disclosure unless asked to be', () => {
    render(
      <DenPanel title="Today's Pack">
        <p>content</p>
      </DenPanel>,
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('collapses and expands, and says which it is', async () => {
    render(
      <DenPanel title="Today's Pack" collapsible>
        <p>content</p>
      </DenPanel>,
    );
    const toggle = screen.getByRole('button', { name: /Today's Pack/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await userEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('content')).not.toBeInTheDocument();
  });

  it('honours initiallyExpanded={false}', () => {
    render(
      <DenPanel title="Business Settings" collapsible initiallyExpanded={false}>
        <p>content</p>
      </DenPanel>,
    );
    expect(screen.queryByText('content')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Business Settings/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('takes the shared lift class only when hoverLift is asked for', () => {
    // `den-panel--lift` is gone: the panel wears the same `lift` utility as
    // every other card that rises, so there is one definition and one
    // reduced-motion guard rather than a private copy per component.
    const { container: plain } = render(
      <DenPanel title="Today's Pack">
        <p>c</p>
      </DenPanel>,
    );
    expect(plain.querySelector('.den-panel')).not.toHaveClass('lift');

    const { container: lifted } = render(
      <DenPanel title="Today's Pack" hoverLift>
        <p>c</p>
      </DenPanel>,
    );
    expect(lifted.querySelector('.den-panel')).toHaveClass('lift');
    expect(lifted.querySelector('.den-panel--lift')).toBeNull();
  });

  it('keeps the trailing slot out of the toggle, so its buttons stay clickable', async () => {
    // A trailing action nested inside the disclosure button would be unreachable:
    // nested buttons are invalid, and the outer one eats the click.
    const onClick = vi.fn();
    render(
      <DenPanel title="Today's Pack" collapsible trailing={<button type="button" onClick={onClick}>View all</button>}>
        <p>content</p>
      </DenPanel>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'View all' }));

    expect(onClick).toHaveBeenCalledOnce();
    expect(screen.getByText('content')).toBeInTheDocument();
  });
});

describe('ServicePill', () => {
  it('renders the service type', () => {
    render(<ServicePill serviceType="walk" />);
    expect(screen.getByText('walk')).toBeInTheDocument();
  });

  it('falls back to "visit" for a blank service type', () => {
    render(<ServicePill serviceType="   " />);
    expect(screen.getByText('visit')).toBeInTheDocument();
  });

  it('tones itself from the service type', () => {
    render(<ServicePill serviceType="Dog Walk" />);
    expect(screen.getByText('Dog Walk')).toHaveAttribute('data-tone', 'teal');
  });

  it('takes an explicit tone override', () => {
    render(<ServicePill serviceType="Dog Walk" tone="error" />);
    expect(screen.getByText('Dog Walk')).toHaveAttribute('data-tone', 'error');
  });
});

describe('serviceTone', () => {
  it.each([
    ['Dog Walk', 'teal'],
    ['Drop-in', 'orange'],
    ['House Sitting', 'purple'],
    ['Overnight', 'purple'],
    ['Meet and Greet', 'success'],
    ['something else', 'orange'],
  ])('maps %s to %s', (service, tone) => {
    expect(serviceTone(service)).toBe(tone);
  });
});

describe('hints', () => {
  it('EmptyHint states the quiet fact, unannounced', () => {
    render(<EmptyHint>No visits today. Enjoy the quiet.</EmptyHint>);
    expect(screen.getByText('No visits today. Enjoy the quiet.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('ErrorHint announces the failure', () => {
    render(<ErrorHint>Couldn&rsquo;t load visits.</ErrorHint>);
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t load visits.');
  });
});
