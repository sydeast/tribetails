// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';

const { useRouteContext } = vi.hoisted(() => ({ useRouteContext: vi.fn() }));
const { useAuth, signOut } = vi.hoisted(() => ({ useAuth: vi.fn(), signOut: vi.fn() }));
// Mocked at the FIRESTORE boundary, not at the hook: these tests then exercise
// the real CONVERSATIONS_QUERY, the real useUnreadInbox, the real unread count
// and the real railCount refusal rules, which is the whole slice the rail's one
// live number goes through.
const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
const { reportError } = vi.hoisted(() => ({ reportError: vi.fn() }));

vi.mock('@tanstack/react-router', () => ({
  useRouteContext,
  Outlet: () => null,
  linkOptions: (o: unknown) => o,
  // Mirrors the real Link closely enough for the shell: renders an anchor and
  // forwards aria-label. `activeProps` is swallowed (nothing is active here).
  Link: ({
    to,
    children,
    className,
    activeProps: _activeProps,
    ...rest
  }: {
    to: string;
    children: ReactNode;
    className?: string;
    activeProps?: unknown;
  }) => (
    <a href={to} className={className} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('../lib/auth', () => ({ useAuth, signOut }));
vi.mock('../lib/firestore', () => ({ useCollection }));
vi.mock('../lib/sentry', () => ({ reportError }));

import { AppShell, RailItem, railCount } from './AppShell';
import { CONVERSATIONS_QUERY } from '../api/inbox';
import { railEntries, type NavEntry } from '../lib/nav';

/** What the shell's conversations listener hands back this render. */
function threads(...unread: boolean[]) {
  return { status: 'ready', data: unread.map((unreadForAdmin) => ({ unreadForAdmin })) };
}

function signedIn(over: Record<string, unknown> = {}) {
  return {
    status: 'signedIn',
    user: { uid: 'op-1', email: 'nora@tribetails.com', displayName: 'Auntie Nora', ...over },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useRouteContext.mockReturnValue({ access: { status: 'admin' } });
  useAuth.mockReturnValue(signedIn());
  // Default for the tests that are not about the badge: the listener has not
  // reported yet, so no count exists and no pill renders.
  useCollection.mockReturnValue({ status: 'loading' });
});

describe('AppShell account chip', () => {
  it('gives the operator a real way into their account settings (issue #2)', () => {
    render(<AppShell />);
    const chip = screen.getByRole('link', { name: /account/i });
    expect(chip).toHaveAttribute('href', '/account');
  });

  it('shows the operator name and a monogram, not just a bare role word', () => {
    render(<AppShell />);
    const chip = screen.getByRole('link', { name: /account/i });
    expect(within(chip).getByText('Auntie Nora')).toBeInTheDocument();
    expect(within(chip).getByText('AN')).toBeInTheDocument();
  });

  it('keeps the role visible on the chip, so a sandbox session still reads as one', () => {
    useRouteContext.mockReturnValue({ access: { status: 'testAdmin', testTribeId: '0I' } });
    render(<AppShell />);
    const chip = screen.getByRole('link', { name: /account/i });
    expect(within(chip).getByText('Test admin, sandbox')).toBeInTheDocument();
  });

  it('falls back to the email local-part when no display name is set, never blank', () => {
    useAuth.mockReturnValue(signedIn({ displayName: '' }));
    render(<AppShell />);
    const chip = screen.getByRole('link', { name: /account/i });
    expect(within(chip).getByText('nora')).toBeInTheDocument();
  });

  it('renders without a user rather than crashing the whole shell', () => {
    useAuth.mockReturnValue({ status: 'loading' });
    render(<AppShell />);
    const chip = screen.getByRole('link', { name: /account/i });
    // Scoped to the name line: "Operator" is also the role line's text for a
    // full admin, and the honest fallback name happens to be the same word.
    expect(
      within(chip).getByText('Operator', { selector: '.shell__account-name' }),
    ).toBeInTheDocument();
  });

  it('still offers Sign out beside the chip', () => {
    render(<AppShell />);
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });

  it('keeps the sandbox banner for a test admin', () => {
    useRouteContext.mockReturnValue({ access: { status: 'testAdmin', testTribeId: '0I' } });
    render(<AppShell />);
    expect(screen.getByText('Sandbox account')).toBeInTheDocument();
  });

  it('still renders the rail groups it always did', () => {
    render(<AppShell />);
    expect(screen.getByRole('navigation', { name: /the den/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Invoices' })).toHaveAttribute('href', '/invoices');
  });

  it('does NOT pin Account into the rail: the chip is its only entry point', () => {
    render(<AppShell />);
    const rail = screen.getByRole('complementary', { name: /primary navigation/i });
    expect(within(rail).queryByText('Account')).toBeNull();
  });
});

/**
 * ITEM 5 of docs/2026-07-25-mock-vs-shipped-ui.md: the rail had no icons and no
 * count pills, and it is the one component on every screen, so its flatness is
 * the flatness the operator sees most often.
 */
describe('AppShell rail glyphs', () => {
  function rail() {
    return screen.getByRole('complementary', { name: /primary navigation/i });
  }

  it('gives every live rail entry its own glyph, none shared and none missing', () => {
    render(<AppShell />);
    for (const entry of railEntries()) {
      const link = screen.getByRole('link', { name: entry.title });
      expect(
        link.querySelector(`svg[data-glyph="${entry.dest}"]`),
        `${entry.title} has no glyph`,
      ).not.toBeNull();
    }
    // Not vacuous: one glyph per pinned entry, so a shared or duplicated icon
    // would not slip through the per-entry lookup above.
    const drawn = rail().querySelectorAll('svg[data-glyph]');
    expect(drawn).toHaveLength(railEntries().length);
    expect(new Set([...drawn].map((g) => g.getAttribute('data-glyph')))).toHaveLength(
      railEntries().length,
    );
  });

  it('keeps the glyph out of the accessible name, so a link is still just its label', () => {
    render(<AppShell />);
    const link = screen.getByRole('link', { name: 'Invoices' });
    const glyph = link.querySelector('svg[data-glyph="invoices"]');
    expect(glyph).toHaveAttribute('aria-hidden', 'true');
    expect(glyph).toHaveAttribute('focusable', 'false');
    expect(link.textContent).toBe('Invoices');
  });

  it('draws no glyph for a contextual destination, which is never pinned', () => {
    render(<AppShell />);
    expect(rail().querySelector('svg[data-glyph="accountSettings"]')).toBeNull();
    expect(rail().querySelector('svg[data-glyph="mediaGallery"]')).toBeNull();
  });
});

describe('AppShell rail count pills', () => {
  function pills() {
    return screen
      .getByRole('complementary', { name: /primary navigation/i })
      .querySelectorAll('.shell__count');
  }

  it('pills only the entries that carry a number, and leaves the rest alone', () => {
    render(<AppShell counts={{ inbox: 4, bookings: 12 }} />);
    expect(pills()).toHaveLength(2);
    expect(
      screen.getByRole('link', { name: /^Inbox/ }).querySelector('.shell__count'),
    ).toHaveTextContent('4');
    expect(
      screen.getByRole('link', { name: /^Bookings/ }).querySelector('.shell__count'),
    ).toHaveTextContent('12');
    expect(screen.getByRole('link', { name: 'Directory' }).querySelector('.shell__count')).toBeNull();
  });

  it('reads the count out as part of the link, since a badge nobody hears is not a badge', () => {
    render(<AppShell counts={{ inbox: 4 }} />);
    expect(screen.getByRole('link', { name: 'Inbox 4' })).toBeInTheDocument();
  });

  it('renders nothing for zero, negative or non-finite counts rather than "0" or "NaN"', () => {
    render(
      <AppShell counts={{ inbox: 0, bookings: -3, invoices: Number.NaN, directory: Infinity }} />,
    );
    expect(pills()).toHaveLength(0);
  });

  it('ignores a slug that names no rail entry instead of inventing a row for it', () => {
    render(<AppShell counts={{ 'not-a-screen': 9 }} />);
    expect(pills()).toHaveLength(0);
  });

  it('an explicit counts prop still wins over the live listener (the harness seam)', () => {
    useCollection.mockReturnValue(threads(true, true, true));
    render(<AppShell counts={{ bookings: 2 }} />);
    expect(pills()).toHaveLength(1);
    expect(
      screen.getByRole('link', { name: /^Bookings/ }).querySelector('.shell__count'),
    ).toHaveTextContent('2');
  });

  it('railCount: keeps positives, floors fractions, refuses everything else', () => {
    expect(railCount({ inbox: 4 }, 'inbox')).toBe(4);
    expect(railCount({ inbox: 4.7 }, 'inbox')).toBe(4);
    expect(railCount({ inbox: 0 }, 'inbox')).toBeNull();
    expect(railCount({ inbox: -1 }, 'inbox')).toBeNull();
    expect(railCount({ inbox: Number.NaN }, 'inbox')).toBeNull();
    expect(railCount({}, 'inbox')).toBeNull();
  });
});

/**
 * The rail's one REAL number, end to end: the shell's own bounded conversations
 * listener, through `useUnreadInbox` and `unreadThreadCount`, onto the Inbox
 * pill. Only `lib/firestore`'s useCollection is mocked, so everything between
 * the snapshot and the pixel is the shipping code.
 */
describe('AppShell live Inbox count', () => {
  function railPills() {
    return screen
      .getByRole('complementary', { name: /primary navigation/i })
      .querySelectorAll('.shell__count');
  }

  it('opens ONE bounded, ordered, capped listener on conversations, no more', () => {
    render(<AppShell />);
    expect(useCollection).toHaveBeenCalledTimes(1);
    expect(useCollection).toHaveBeenCalledWith(CONVERSATIONS_QUERY);
    // Bounded and server-ordered per the useCollection contract. A `filters`
    // predicate here would need a composite index deployed alongside it.
    expect(CONVERSATIONS_QUERY).toEqual({
      path: 'conversations',
      order: ['lastMessageAtMs', 'desc'],
      max: 200,
    });
  });

  it('shows no pill while the count is still loading, rather than a zero', () => {
    useCollection.mockReturnValue({ status: 'loading' });
    render(<AppShell />);
    expect(railPills()).toHaveLength(0);
  });

  it('pills the real unread total once the listener resolves', () => {
    useCollection.mockReturnValue(threads(true, false, true, true, false));
    render(<AppShell />);
    const pill = screen.getByRole('link', { name: /^Inbox/ }).querySelector('.shell__count');
    expect(pill).toHaveTextContent('3');
    expect(railPills()).toHaveLength(1);
  });

  it('shows no pill when every thread is read: an empty inbox wears no badge', () => {
    useCollection.mockReturnValue(threads(false, false, false));
    render(<AppShell />);
    expect(railPills()).toHaveLength(0);
    expect(screen.getByRole('link', { name: 'Inbox' })).toBeInTheDocument();
  });

  it('shows no pill for an empty collection either', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [] });
    render(<AppShell />);
    expect(railPills()).toHaveLength(0);
  });

  it('survives a failed count: no pill, no banner in the rail, every link still there', () => {
    useCollection.mockReturnValue({
      status: 'error',
      message: 'Missing or insufficient permissions.',
      retry: vi.fn(),
    });
    render(<AppShell />);
    const rail = screen.getByRole('complementary', { name: /primary navigation/i });
    expect(railPills()).toHaveLength(0);
    // The failure must not leak into the navigation as a banner or a message.
    expect(within(rail).queryByText(/permission/i)).toBeNull();
    expect(within(rail).queryByRole('alert')).toBeNull();
    // And the rail is still a rail: every pinned destination, still a link.
    expect(within(rail).getAllByRole('link')).toHaveLength(railEntries().length);
    expect(screen.getByRole('link', { name: 'Inbox' })).toHaveAttribute('href', '/inbox');
  });

  it('reports the failure instead of swallowing it, once per distinct message', () => {
    const { rerender } = render(<AppShell />);
    useCollection.mockReturnValue({ status: 'error', message: 'Load failed' });
    rerender(<AppShell />);
    rerender(<AppShell />);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(new Error('Load failed'), 'railInboxCount');
  });

  it('does not report anything when the count loads fine', () => {
    useCollection.mockReturnValue(threads(true));
    render(<AppShell />);
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe('AppShell rail: an entry whose screen is not built', () => {
  // Every rail slug is live today (AppShell.railLinks.test.ts asserts it), so
  // the fallback branch is only reachable through RailItem directly.
  const pending: NavEntry = {
    dest: 'home',
    title: 'Someday',
    group: 'den',
    slug: 'not-a-screen',
  };

  it('renders as disabled text, not as a link', () => {
    render(<RailItem entry={pending} count={null} />);
    expect(screen.queryByRole('link', { name: /someday/i })).toBeNull();
    const item = screen.getByText('Someday').closest('.shell__link');
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveClass('shell__link--pending');
    expect(item?.textContent).toContain('(coming soon)');
  });

  it('still carries its glyph, so the rail does not lose alignment on one row', () => {
    render(<RailItem entry={pending} count={null} />);
    expect(document.querySelector('svg[data-glyph="home"]')).not.toBeNull();
  });

  it('wears no pill even when handed a count: there is no screen for it to be about', () => {
    render(<RailItem entry={pending} count={7} />);
    expect(document.querySelector('.shell__count')).toBeNull();
    expect(screen.queryByText('7')).toBeNull();
  });
});

describe('AppShell brand mark', () => {
  it('renders the monogram tile above the rail without doubling the wordmark', () => {
    render(<AppShell />);
    const rail = screen.getByRole('complementary', { name: /primary navigation/i });
    const mark = rail.querySelector('.shell__brand-mark');
    expect(mark).toHaveTextContent('A');
    // Decoration on top of the wordmark right beside it: announcing it would
    // read "A AuntieOS".
    expect(mark).toHaveAttribute('aria-hidden', 'true');
    expect(within(rail).getByText('AuntieOS')).toBeInTheDocument();
  });
});
