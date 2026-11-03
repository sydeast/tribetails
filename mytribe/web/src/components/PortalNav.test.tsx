// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PortalNav } from './PortalNav';
import { getMyHome } from '../api/portal';

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

const accessMock = vi.hoisted(() => ({ isOperator: false }));
vi.mock('../lib/activeTribe', () => ({
  useAccessState: () => ({ isOperator: accessMock.isOperator }),
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
  accessMock.isOperator = false;
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
  it('offers Account, Invoices, Edit Tribe Profile, Notification settings, About and Sign out when opened', async () => {
    renderNav();
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(screen.getByRole('button', { name: 'Account menu', expanded: true })).toBeTruthy();
    await screen.findByRole('menuitem', { name: 'About Tribe Tails Pet Care' });
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
    // #1454: Edit Tribe Profile joins the menu between Account and Notification
    // settings. #1411: About sits between the settings links and Sign out.
    // #1457: Invoices follows Account for billing access, which this mock's
    // getMyHome answer (no billingAccess field) counts as granted. The same
    // order as Android's ShellNav.accountMenu.
    expect(items.map((el) => el.textContent)).toEqual([
      'Account',
      'Invoices',
      'Edit Tribe Profile',
      'Notification settings',
      'About Tribe Tails Pet Care',
      'Sign out',
    ]);
    expect(items[0]).toHaveAttribute('href', '/account');
    expect(items[1]).toHaveAttribute('href', '/invoices');
    expect(items[2]).toHaveAttribute('href', '/tribe/edit');
    expect(items[3]).toHaveAttribute('href', '/account/notifications');
    expect(items[4]).toHaveAttribute('href', '/about');
    expect(items[5]?.tagName).toBe('BUTTON');
  });

  /** #1457: the menu's Invoices item follows getMyHome.billingAccess, the same answer as the desktop link. */
  it('leaves Invoices out of the menu and the desktop nav without billing access', async () => {
    vi.mocked(getMyHome).mockResolvedValueOnce({
      businessLogoUrl: undefined,
      businessName: 'Tribe Tails Pet Care',
      billingAccess: false,
    } as unknown as Awaited<ReturnType<typeof getMyHome>>);
    renderNav();
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Invoices' })).toBeNull());
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    await screen.findByRole('menuitem', { name: 'About Tribe Tails Pet Care' });
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
    expect(items.map((el) => el.textContent)).toEqual(['Account', 'Edit Tribe Profile', 'Notification settings', 'About Tribe Tails Pet Care', 'Sign out']);
  });
  /** #1490: with no business name cached the item falls back to the About screen's own title words. */
  it('reads About your Auntie in the menu when getMyHome has no business name', async () => {
    vi.mocked(getMyHome).mockResolvedValueOnce({
      businessLogoUrl: undefined,
      businessName: '',
    } as unknown as Awaited<ReturnType<typeof getMyHome>>);
    renderNav();
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(await screen.findByRole('menuitem', { name: 'About your Auntie' })).toHaveAttribute('href', '/about');
    expect(screen.queryByRole('menuitem', { name: 'About Tribe Tails Pet Care' })).toBeNull();
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

/**
 * #1459 (#1295 mobile map): operators leave a tribe from the avatar menu, not a
 * header icon. The icon is gone at every width; jsdom draws one tree for every
 * width, so its absence here is its absence everywhere.
 */
describe('PortalNav Back to Directory (#1459)', () => {
  it('has no Switch tribe control in the header for an operator', () => {
    accessMock.isOperator = true;
    renderNav();
    expect(screen.queryByRole('link', { name: 'Switch tribe' })).toBeNull();
    expect(screen.queryByTitle('Back to Directory')).toBeNull();
    expect(document.querySelector('.nav a[href="/pick"]')).toBeNull();
  });

  it('puts Back to Directory in an operator\'s menu, in the full map order', async () => {
    accessMock.isOperator = true;
    renderNav();
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    await screen.findByRole('menuitem', { name: 'About Tribe Tails Pet Care' });
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
    expect(items.map((el) => el.textContent)).toEqual([
      'Account',
      'Invoices',
      'Edit Tribe Profile',
      'Notification settings',
      'About Tribe Tails Pet Care',
      'Back to Directory',
      'Sign out',
    ]);
    expect(screen.getByRole('menuitem', { name: 'Back to Directory' })).toHaveAttribute('href', '/pick');
  });

  it('gives a kinfolk account neither the header icon nor the menu item', async () => {
    renderNav();
    expect(screen.queryByRole('link', { name: 'Switch tribe' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(screen.queryByRole('menuitem', { name: 'Back to Directory' })).toBeNull();
  });
});

/**
 * #1316: the bell opens the notifications LIST, not Notification settings,
 * and carries the unread count off the same cached `getMyHome` answer the
 * branding reads. Settings stay in the avatar menu, pinned above.
 */
describe('PortalNav bell (#1316)', () => {
  function homeWith(unreadNotifications?: number) {
    vi.mocked(getMyHome).mockResolvedValueOnce({
      businessLogoUrl: undefined,
      businessName: 'Tribe Tails Pet Care',
      ...(unreadNotifications !== undefined ? { unreadNotifications } : {}),
    } as unknown as Awaited<ReturnType<typeof getMyHome>>);
  }

  it('is a link to /notifications named Notifications, and the header has no settings link', async () => {
    homeWith(0);
    renderNav();
    const bell = screen.getByRole('link', { name: 'Notifications' });
    expect(bell).toHaveAttribute('href', '/notifications');
    expect(bell).toHaveClass('iconbtn');
    expect(screen.queryByRole('link', { name: 'Notification settings' })).toBeNull();
    // Settings are still one menu away.
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(screen.getByRole('menuitem', { name: 'Notification settings' })).toHaveAttribute('href', '/account/notifications');
  });

  it('shows the unread count on the bell once getMyHome answers, and says it in the link name', async () => {
    homeWith(3);
    renderNav();
    const badge = await screen.findByTestId('bell-badge');
    expect(badge).toHaveTextContent('3');
    // The badge is aria-hidden, so the count has to be in the accessible name
    // or a screen reader hears only "Notifications".
    const bell = screen.getByRole('link', { name: 'Notifications, 3 unread' });
    expect(bell).toContainElement(badge);
    expect(bell).toHaveAttribute('href', '/notifications');
    expect(screen.queryByRole('link', { name: 'Notifications' })).toBeNull();
  });

  it('draws no badge and reads plain Notifications at 0, and when an older server leaves the field out', async () => {
    homeWith(0);
    renderNav();
    await waitFor(() => expect(getMyHome).toHaveBeenCalled());
    expect(screen.queryByTestId('bell-badge')).toBeNull();
    expect(screen.getByRole('link', { name: 'Notifications' })).toHaveAttribute('href', '/notifications');
    cleanup();
    homeWith();
    renderNav();
    await waitFor(() => expect(getMyHome).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('bell-badge')).toBeNull();
    expect(screen.getByRole('link', { name: 'Notifications' })).toHaveAttribute('href', '/notifications');
  });

  it('caps the drawn badge at 99+ while the name carries the exact count', async () => {
    homeWith(150);
    renderNav();
    expect(await screen.findByTestId('bell-badge')).toHaveTextContent('99+');
    expect(screen.getByRole('link', { name: 'Notifications, 150 unread' })).toBeTruthy();
  });
});
