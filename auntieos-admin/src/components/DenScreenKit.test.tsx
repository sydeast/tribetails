// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';

// The AppShell.test.tsx convention: no suite in this tree mounts a
// RouterProvider, so `Link` is stood in for by the anchor it renders. `params`
// is interpolated the way the router would, because a crumb's whole job is to
// name a real destination and the href is the only place that shows.
vi.mock('@tanstack/react-router', () => ({
  linkOptions: (o: unknown) => o,
  Link: ({
    to,
    params,
    children,
    ...rest
  }: {
    to: string;
    params?: Record<string, string>;
    children: ReactNode;
  }) => {
    const href = Object.entries(params ?? {}).reduce(
      (path, [key, value]) => path.replace(`$${key}`, value),
      to,
    );
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
}));

import { linkOptions } from '@tanstack/react-router';
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

  it('puts the subtitle behind the info button instead of on the page', () => {
    render(
      <DenScreenHeading
        kicker="k"
        title="t"
        subtitle="Day-of view. Clock in, clock out."
        trailing={<button type="button">New</button>}
      />,
    );
    expect(screen.getByText('Day-of view. Clock in, clock out.')).not.toBeVisible();
    expect(screen.getByRole('button', { name: 'About this section' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New' })).toBeInTheDocument();
  });

  it('renders a detail value as visible copy, with no info button', () => {
    // The half of the old subtitle that survived: a range is the screen saying
    // what you are looking at, not explaining what a schedule is.
    render(<DenScreenHeading kicker="k" title="Schedule" detail="Sep 1 to Sep 7" />);
    expect(screen.getByText('Sep 1 to Sep 7')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'About this section' })).not.toBeInTheDocument();
  });

  it('reveals the explanation on hover and puts it away again', async () => {
    render(<DenScreenHeading kicker="k" title="t" subtitle="Three visits today." />);
    const info = screen.getByRole('button', { name: 'About this section' });

    await userEvent.hover(info);
    expect(screen.getByText('Three visits today.')).toBeVisible();

    await userEvent.unhover(info);
    expect(screen.getByText('Three visits today.')).not.toBeVisible();
  });

  it('reveals the explanation on keyboard focus, so it is not mouse-only', async () => {
    render(<DenScreenHeading kicker="k" title="t" subtitle="Three visits today." />);

    await userEvent.tab();

    expect(screen.getByRole('button', { name: 'About this section' })).toHaveFocus();
    expect(screen.getByText('Three visits today.')).toBeVisible();
  });

  it('closes on Escape even when the pointer opened it', async () => {
    // Opened by hover, nothing of ours is focused, so the key listener has to be
    // on the document rather than on the trigger.
    render(<DenScreenHeading kicker="k" title="t" subtitle="Three visits today." />);
    await userEvent.hover(screen.getByRole('button', { name: 'About this section' }));
    expect(screen.getByText('Three visits today.')).toBeVisible();

    await userEvent.keyboard('{Escape}');

    expect(screen.getByText('Three visits today.')).not.toBeVisible();
  });

  it('describes the title with the tooltip, so a screen reader still gets the sentence', () => {
    render(<DenScreenHeading kicker="k" title="Schedule" subtitle="Three visits today." />);
    const tip = screen.getByText('Three visits today.');

    expect(tip).toHaveAttribute('role', 'tooltip');
    expect(screen.getByRole('heading', { name: 'Schedule' })).toHaveAttribute(
      'aria-describedby',
      tip.id,
    );
  });

  it('keeps the tooltip mounted while it is closed, or the description points at nothing', () => {
    // `aria-describedby` resolves only against an element that exists, and the
    // description computation deliberately reads a hidden node it references.
    // Unmounting the closed tip would hand the sentence to sighted mouse users
    // and to nobody else.
    render(<DenScreenHeading kicker="k" title="Schedule" subtitle="Three visits today." />);
    expect(screen.getByText('Three visits today.')).toBeInTheDocument();
  });

  it('omits the optional parts when not given', () => {
    render(<DenScreenHeading kicker="k" title="t" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders no breadcrumb trail on a kicker heading', () => {
    render(<DenScreenHeading kicker="The Den · Directory" title="Your" accentTail="kinfolk" />);
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });
});

/**
 * The ten `.crumbs` mocks (`ui-ideas/auntieos-kinfolk-profile-*.html` and its
 * siblings) put a trail where a list screen puts its kicker, and NONE of them
 * shows both. That is the whole point of the primitive: "THE DEN · DIRECTORY"
 * reads identically on the list and three levels down, so on a nested screen
 * the trail replaces it rather than stacking under it.
 */
describe('DenBreadcrumbs', () => {
  const directory = linkOptions({ to: '/directory' });
  const household = linkOptions({ to: '/directory/$kinfolkId', params: { kinfolkId: 'kf-1' } });

  it('renders a named trail whose last crumb is the current page, not a link', () => {
    render(
      <DenScreenHeading
        title="Members and"
        accentTail="invites."
        crumbs={[
          { label: 'Directory', link: directory },
          { label: 'the Wrens', link: household },
          { label: 'Members and invites' },
        ]}
      />,
    );

    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(nav).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Directory' })).toHaveAttribute('href', '/directory');
    expect(within(nav).getByRole('link', { name: 'the Wrens' })).toHaveAttribute(
      'href',
      '/directory/kf-1',
    );
    // The page you are already on is text. A link to here is a lie about where
    // it goes, and a screen reader needs the destination announced instead.
    expect(within(nav).queryByRole('link', { name: 'Members and invites' })).not.toBeInTheDocument();
    expect(screen.getByText('Members and invites')).toHaveAttribute('aria-current', 'page');
  });

  it('replaces the kicker rather than stacking under it', () => {
    render(
      <DenScreenHeading
        title="the Wrens"
        crumbs={[{ label: 'Directory', link: directory }, { label: 'the Wrens' }]}
      />,
    );
    expect(screen.queryByText(/The Den/i)).not.toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument();
  });

  /**
   * Half these destinations are sibling VIEWS of a screen, not routes: opening a
   * household from the Directory list never changes the URL, so a <Link to
   * "/directory"> there resolves to the page you are standing on and clicking it
   * does nothing at all. A crumb that cannot navigate must not pretend to.
   */
  it('renders an in-screen destination as a button that fires', async () => {
    const back = vi.fn();
    render(
      <DenScreenHeading
        title="Biscuit"
        crumbs={[{ label: 'Directory', onSelect: back }, { label: 'Biscuit' }]}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Directory' }));
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('keeps duplicate labels apart', () => {
    render(
      <DenScreenHeading
        title="Kin"
        crumbs={[
          { label: 'Directory', link: directory },
          { label: 'Directory', onSelect: () => {} },
          { label: 'Biscuit' },
        ]}
      />,
    );
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getAllByText('Directory')).toHaveLength(2);
  });

  it('renders a lone crumb with no separator', () => {
    const { container } = render(<DenScreenHeading title="t" crumbs={[{ label: 'Directory' }]} />);
    expect(container.querySelectorAll('.den-crumbs-sep')).toHaveLength(0);
  });
});

describe('DenPanel', () => {
  it('renders title and content, with the subtitle behind the info button', () => {
    render(
      <DenPanel title="Today's Pack" subtitle="Your visit run for the day.">
        <p>Ranger, 9:00a</p>
      </DenPanel>,
    );
    expect(screen.getByText("Today's Pack")).toBeVisible();
    expect(screen.getByText('Ranger, 9:00a')).toBeVisible();
    // The complaint this answers: 153 panels and headings each carried a
    // sentence of explanation. The sentence is still here, just not on screen.
    expect(screen.getByText('Your visit run for the day.')).not.toBeVisible();
    expect(screen.getByRole('button', { name: 'About this section' })).toBeInTheDocument();
  });

  it('renders a detail value as visible copy, with no info button', () => {
    render(
      <DenPanel title="Photos" detail="3 attached.">
        <p>content</p>
      </DenPanel>,
    );
    expect(screen.getByText('3 attached.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'About this section' })).not.toBeInTheDocument();
  });

  it('shows the detail and the explanation at once, each in its own place', () => {
    render(
      <DenPanel title="Vet" detail="3 of 8 on file" subtitle="Admin only. Internal.">
        <p>content</p>
      </DenPanel>,
    );
    expect(screen.getByText('3 of 8 on file')).toBeVisible();
    expect(screen.getByText('Admin only. Internal.')).not.toBeVisible();
  });

  it('reveals the explanation on hover and on focus, and Escape puts it away', async () => {
    render(
      <DenPanel title="Today's Pack" subtitle="Your visit run for the day.">
        <p>content</p>
      </DenPanel>,
    );
    const info = screen.getByRole('button', { name: 'About this section' });

    await userEvent.hover(info);
    expect(screen.getByText('Your visit run for the day.')).toBeVisible();
    await userEvent.unhover(info);
    expect(screen.getByText('Your visit run for the day.')).not.toBeVisible();

    await userEvent.tab();
    expect(info).toHaveFocus();
    expect(screen.getByText('Your visit run for the day.')).toBeVisible();

    await userEvent.keyboard('{Escape}');
    expect(screen.getByText('Your visit run for the day.')).not.toBeVisible();
  });

  it('describes the panel heading with the tooltip', () => {
    render(
      <DenPanel title="Today's Pack" subtitle="Your visit run for the day.">
        <p>content</p>
      </DenPanel>,
    );
    const tip = screen.getByText('Your visit run for the day.');

    expect(tip).toHaveAttribute('role', 'tooltip');
    expect(screen.getByRole('heading', { name: "Today's Pack" })).toHaveAttribute(
      'aria-describedby',
      tip.id,
    );
  });

  it('keeps the tooltip body wearing the class screen stylesheets target', () => {
    // `.den-panel-subtitle` moved from a line on the page to the tip body
    // rather than being deleted, so a screen sheet that styles it still lands.
    const { container } = render(
      <DenPanel title="Today's Pack" subtitle="Your visit run for the day.">
        <p>content</p>
      </DenPanel>,
    );
    expect(container.querySelector('.den-panel-subtitle')).toHaveTextContent(
      'Your visit run for the day.',
    );
  });

  it('keeps the info button OUT of the disclosure toggle on a collapsible panel', async () => {
    // A button inside a button is invalid markup and the outer one eats the
    // click, so the explained collapsible panels (HouseholdData's dossier,
    // Schedule's day list) put the info button beside the toggle instead.
    render(
      <DenPanel title="From the dossier" subtitle="Admin only. Internal." collapsible>
        <p>content</p>
      </DenPanel>,
    );
    const toggle = screen.getByRole('button', { name: /From the dossier/ });
    const info = screen.getByRole('button', { name: 'About this section' });
    expect(toggle).not.toContainElement(info);

    await userEvent.hover(info);

    expect(screen.getByText('Admin only. Internal.')).toBeVisible();
    // Opening the tip must not have collapsed the panel underneath it.
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('content')).toBeVisible();
  });

  /**
   * The mocks' `.ct`: a count or a total on the right of the panel header. It is
   * its own slot rather than something a screen concatenates into `title`,
   * because the heading is the section's accessible NAME and "Kin · 2" makes a
   * screen reader announce a number as part of it.
   */
  it('renders a header meta note beside the title without joining the heading', () => {
    render(
      <DenPanel title="Kin" meta="2 kin">
        <p>content</p>
      </DenPanel>,
    );
    expect(screen.getByRole('heading', { name: 'Kin' })).toBeInTheDocument();
    expect(screen.getByText('2 kin')).toBeInTheDocument();
  });
  it('renders no meta element at all for a blank note', () => {
    const { container } = render(
      <DenPanel title="Kin" meta="   ">
        <p>content</p>
      </DenPanel>,
    );
    expect(container.querySelector('.den-panel-meta')).toBeNull();
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

  // AO-404: the title used to be a `span`, invisible to heading navigation.
  // Every screen built from DenPanel gave a screen reader one h1 and nothing
  // else to jump to underneath it.
  it('renders the title as a heading, level 2 by default', () => {
    render(
      <DenPanel title="Today's Pack">
        <p>content</p>
      </DenPanel>,
    );
    const heading = screen.getByRole('heading', { level: 2, name: "Today's Pack" });
    expect(heading).toHaveClass('den-panel-title');
  });

  it('takes an explicit heading level for a panel composed inside another heading', () => {
    // BookingDetailModal composes DenPanel inside a Dialog whose own title is
    // already an h2, so its panels pass headingLevel=3 to keep the outline
    // nesting correctly instead of jumping back up a level mid-document.
    render(
      <DenPanel title="Staffing" headingLevel={3}>
        <p>content</p>
      </DenPanel>,
    );
    expect(screen.getByRole('heading', { level: 3, name: 'Staffing' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument();
  });

  it('keeps the explanation and the info button out of the heading\'s accessible name', () => {
    // The heading is the section's NAME. Neither the sentence nor the button's
    // own label may join it, or every panel announces itself as "Today's Pack
    // About this section".
    render(
      <DenPanel title="Today's Pack" detail="3 visits" subtitle="Your visit run for the day.">
        <p>content</p>
      </DenPanel>,
    );
    expect(screen.getByRole('heading', { name: "Today's Pack" })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /3 visits/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /visit run/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /About this section/ })).not.toBeInTheDocument();
  });

  it('does not emit an empty heading when there is no title', () => {
    render(
      <DenPanel title="">
        <p>content</p>
      </DenPanel>,
    );
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('still exposes the title as a heading when the panel is collapsible', () => {
    render(
      <DenPanel title="Today's Pack" collapsible>
        <p>content</p>
      </DenPanel>,
    );
    expect(screen.getByRole('heading', { level: 2, name: "Today's Pack" })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Today's Pack/ })).toBeInTheDocument();
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
