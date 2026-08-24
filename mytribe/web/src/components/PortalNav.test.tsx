// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PortalNav } from './PortalNav';

/**
 * #538, "the upper right icon cannot be the signout. how else will they get
 * to their profile setting intuitively."
 *
 * Before this file, the avatar in the nav's `.right` slot was a bare `div`
 * with `onClick={signOut}`: the one control a kinfolk would reach for to find
 * their own profile signed them out instead, with no route to Account at all.
 *
 * Per the account mockup's own nav (mytribe-account-2026-05-31.html, the only
 * one of the 19 tracked ui-ideas mocks that renders this element on its own
 * active screen), the avatar's job is to open Account, `aria-label="Account"`
 * and all, and Sign Out lives on that screen's sticky save bar, not up here.
 * These specs pin the avatar to that job and prove it is a real link, not a
 * click handler bolted onto a non-interactive element.
 */

// Real anchors, the same convention Account.test.tsx and friends use: `to` is
// carried into href, and every prop React would otherwise put on an <a> is
// forwarded, because a test that cannot see a link's aria-label or href
// cannot tell a working link from the div it replaced.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...rest }: { children?: ReactNode; to?: string } & Record<string, unknown>) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('../lib/activeTribe', () => ({
  useAccessState: () => ({ isOperator: false }),
  getActiveKinfolkId: () => 'kin-1',
}));

vi.mock('../api/portal', () => ({
  getMyHome: vi.fn().mockResolvedValue({ businessLogoUrl: undefined, businessName: 'Tribe Tails Pet Care' }),
}));

// Deliberately no `useSignOut` here. PortalNav used to import it for the
// avatar's onClick; if that ever comes back, vitest's mock is strict about
// unlisted exports, so every render below throws immediately instead of
// quietly re-wiring sign-out to the one control kinfolk use to find Account.
vi.mock('../lib/auth', () => ({
  useAuth: () => ({ status: 'signedIn', user: { uid: 'u1', email: 'jordan@example.com' } }),
}));

function renderNav(active: Parameters<typeof PortalNav>[0]['active'] = 'home') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <PortalNav active={active} displayName="Jordan" />
    </QueryClientProvider>,
  );
}

describe('PortalNav avatar (#538)', () => {
  it('is a link to Account, not a sign-out control', () => {
    renderNav();

    const avatar = screen.getByRole('link', { name: 'Account' });
    expect(avatar).toHaveAttribute('href', '/account');
    // A real <a href>, so Tab/Enter operate it natively: no onClick, no
    // keydown handler, nothing standing between a screen reader user and the
    // route. That is the whole fix: restoring the semantics a div discarded.
    expect(avatar.tagName).toBe('A');
    expect(avatar).not.toHaveAttribute('onclick');
  });

  it('still shows the initial of the signed-in kinfolk on the avatar', () => {
    renderNav();
    expect(screen.getByRole('link', { name: 'Account' })).toHaveTextContent('J');
  });

  it('renders the Account tab in the mobile bar as its own separate link', () => {
    renderNav('account');

    // Two routes to Account exist by design: the avatar (desktop, every
    // screen) and the bottom tab (mobile). Both must resolve to /account.
    const links = screen.getAllByRole('link', { name: /Account/ });
    const hrefs = links.map((el) => el.getAttribute('href'));
    expect(hrefs).toContain('/account');
    expect(hrefs.filter((href) => href === '/account')).toHaveLength(2);
  });
});
