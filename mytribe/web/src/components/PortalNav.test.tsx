// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

const signOutSpy = vi.fn();
vi.mock('../lib/auth', () => ({
  useAuth: () => ({ status: 'signedIn', user: { uid: 'u1', email: 'jordan@example.com' } }),
  useSignOut: () => ({ signOut: signOutSpy, signingOut: false }),
}));
const accountMock = vi.hoisted(() => ({ getMyAccount: vi.fn() }));
vi.mock('../api/accountApi', () => ({ getMyAccount: (...a: unknown[]) => accountMock.getMyAccount(...a) }));
function renderNav(active: Parameters<typeof PortalNav>[0]['active'] = 'home') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <PortalNav active={active} />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  signOutSpy.mockReset();
  accountMock.getMyAccount.mockReset();
  accountMock.getMyAccount.mockResolvedValue({ displayName: 'Jordan Kinfolk', email: 'jordan@example.com', impersonated: false });
});
/**
 * #1309: the avatar is a small menu, not a bare link. Account and Notification
 * settings are real links, Sign out is a button, and none of it renders until
 * the menu is open.
 */
describe('PortalNav avatar menu (#1309, was #538)', () => {
  it('is a menu button, closed by default, with no sign-out in reach', () => {
    renderNav();
    const avatar = screen.getByRole('button', { name: 'Account menu' });
    expect(avatar).toHaveAttribute('aria-haspopup', 'menu');
    expect(avatar).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Sign out' })).toBeNull();
  });
  it('offers Account, Notification settings, About and Sign out when opened', async () => {
    renderNav();
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(screen.getByRole('button', { name: 'Account menu', expanded: true })).toBeTruthy();
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
    // #1411: About sits between the settings links and Sign out, the same
    // order as Android's ShellNav.accountMenu.
    expect(items.map((el) => el.textContent)).toEqual(['Account', 'Notification settings', 'About', 'Sign out']);
    expect(items[0]).toHaveAttribute('href', '/account');
    expect(items[1]).toHaveAttribute('href', '/account/notifications');
    expect(items[2]).toHaveAttribute('href', '/about');
    expect(items[3]?.tagName).toBe('BUTTON');
  });
  it('signs out only from the Sign out item', async () => {
    renderNav();
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(signOutSpy).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(signOutSpy).toHaveBeenCalledTimes(1);
  });
  it('closes on Escape, on a click outside, and after choosing a link', async () => {
    renderNav();
    const open = () => userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    await open();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    await open();
    await userEvent.click(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
    await open();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Account' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });
  it('keeps Account reachable from the menu once it has left the mobile bar (#1413)', async () => {
    renderNav('account');
    expect(screen.queryByRole('link', { name: /Account/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(screen.getByRole('menuitem', { name: 'Account' })).toHaveAttribute('href', '/account');
  });
});
/**
 * #1413 (operator ruling on #1295): the fifth mobile tab is Messages, the
 * direct line to the auntie, not Account. Account moves to the avatar menu,
 * which the specs above already pin. These read the `.tabbar` element itself
 * because the desktop `.navlinks` row also carries Home/Tribe/Schedule links
 * and a role query alone cannot tell the two bars apart.
 */
describe('PortalNav mobile tab bar (#1413)', () => {
  const tabLinks = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLAnchorElement>('.tabbar a'));
  it('is Home / Tribe / Schedule / Tales / Messages, in that order, with no Account tab', () => {
    const { container } = renderNav('home');
    const tabs = tabLinks(container);
    expect(tabs.map((a) => a.querySelector('small')?.textContent)).toEqual(['Home', 'Tribe', 'Schedule', 'Tales', 'Messages']);
    expect(tabs.map((a) => a.getAttribute('href'))).toEqual(['/home', '/tribe', '/schedule', '/kintales', '/messages']);
    expect(container.querySelector('.tabbar a[href="/account"]')).toBeNull();
  });
  it('lights up the Messages tab on the Messages screen and nothing else', () => {
    const { container } = renderNav('messages');
    const on = tabLinks(container).filter((a) => a.classList.contains('on'));
    expect(on.map((a) => a.getAttribute('href'))).toEqual(['/messages']);
  });
  it('lights up no tab on Account, which is a menu screen now', () => {
    const { container } = renderNav('account');
    expect(tabLinks(container).filter((a) => a.classList.contains('on'))).toEqual([]);
  });
  it('still lights up Tales on the KinTales feed', () => {
    const { container } = renderNav('kintales');
    const on = tabLinks(container).filter((a) => a.classList.contains('on'));
    expect(on.map((a) => a.getAttribute('href'))).toEqual(['/kintales']);
  });
});
/** #1290: the letter on the avatar is the person's, whichever screen draws it. */
describe('PortalNav avatar initial (#1290)', () => {
  it('is the initial of the saved display name', async () => {
    renderNav();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Account menu' })).toHaveTextContent('J'));
  });
  it('follows a changed display name, not the sign-in email', async () => {
    accountMock.getMyAccount.mockResolvedValue({ displayName: 'Casey QA', email: 'jordan@example.com', impersonated: false });
    renderNav();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Account menu' })).toHaveTextContent('C'));
  });
  it('falls back to the email initial when the name is empty', async () => {
    accountMock.getMyAccount.mockResolvedValue({ displayName: '', email: 'jordan@example.com', impersonated: false });
    renderNav();
    await waitFor(() => expect(accountMock.getMyAccount).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Account menu' })).toHaveTextContent('J');
  });
});
