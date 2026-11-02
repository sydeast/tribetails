// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AvatarMenu } from './AvatarMenu';

/**
 * #1454 (operator ruling on #1295): "On Android/mobile web, the edit option
 * should only be under the account icon." The Tribe page's own button is
 * hidden at phone width (TribeHub.test.tsx), so this menu is the one way into
 * the Tribe Profile editor there. The entry sits between Account and
 * Notification settings, the slot the Android account menu gives it.
 *
 * PortalNav.test.tsx covers the menu's open/close behaviour through the nav;
 * this file pins the menu's own item list and destinations on their own.
 */

// Real anchors, the convention PortalNav.test.tsx uses: `to` is carried into
// href and the rest of the props ride along, so role and href are readable.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...rest }: { children?: ReactNode; to?: string } & Record<string, unknown>) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

async function openMenu(billingAccess = false, isOperator = false, businessName?: string | null) {
  const onSignOut = vi.fn();
  render(
    <AvatarMenu initial="J" onSignOut={onSignOut} signingOut={false} billingAccess={billingAccess} isOperator={isOperator} businessName={businessName} />,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
  return { onSignOut, items: within(screen.getByRole('menu')).getAllByRole('menuitem') };
}

describe('AvatarMenu items (#1454)', () => {
  it('lists Account, Edit Tribe Profile, Notification settings, About, Sign out in that order without billing access', async () => {
    const { items } = await openMenu();
    expect(items.map((el) => el.textContent)).toEqual(['Account', 'Edit Tribe Profile', 'Notification settings', 'About your Auntie', 'Sign out']);
  });

  it('sends Edit Tribe Profile to the Tribe Profile editor as a real link', async () => {
    const { items } = await openMenu();
    const edit = items[1]!;
    expect(edit.tagName).toBe('A');
    expect(edit).toHaveAttribute('href', '/tribe/edit');
    expect(items[0]).toHaveAttribute('href', '/account');
    expect(items[2]).toHaveAttribute('href', '/account/notifications');
  });

  it('closes after choosing Edit Tribe Profile, like the other links', async () => {
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Edit Tribe Profile' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: 'Account menu' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps Sign out as the only button, and the only item that signs out', async () => {
    const { items, onSignOut } = await openMenu();
    expect(items.filter((el) => el.tagName === 'BUTTON').map((el) => el.textContent)).toEqual(['Sign out']);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Edit Tribe Profile' }));
    expect(onSignOut).not.toHaveBeenCalled();
  });
});

/**
 * #1457 (#1295 mobile map): Invoices has no other door on a phone, so the menu
 * carries it for a member with billing access, between Account and Edit Tribe
 * Profile. Without billing access it is not drawn, the way the desktop nav's
 * Invoices link is not. Android's ShellNav.accountMenu takes the same flag.
 */
describe('AvatarMenu Invoices (#1457)', () => {
  it('puts Invoices between Account and Edit Tribe Profile with billing access', async () => {
    const { items } = await openMenu(true);
    expect(items.map((el) => el.textContent)).toEqual([
      'Account',
      'Invoices',
      'Edit Tribe Profile',
      'Notification settings',
      'About your Auntie',
      'Sign out',
    ]);
    expect(items[1]!.tagName).toBe('A');
    expect(items[1]).toHaveAttribute('href', '/invoices');
  });

  it('leaves Invoices out without billing access', async () => {
    await openMenu(false);
    expect(screen.queryByRole('menuitem', { name: 'Invoices' })).toBeNull();
  });

  it('closes after choosing Invoices, like the other links', async () => {
    const { onSignOut } = await openMenu(true);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Invoices' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onSignOut).not.toHaveBeenCalled();
  });
});

/**
 * #1459 (#1295 mobile map): an operator's way back to the tribe picker moves
 * from the header icon into this menu, directly above Sign out. A kinfolk
 * account never sees it. Android's ShellNav.accountMenu has had the same item.
 */
describe('AvatarMenu Back to Directory (#1459)', () => {
  it('shows an operator Back to Directory, linking to /pick, directly above Sign out', async () => {
    const { items } = await openMenu(false, true);
    const labels = items.map((el) => el.textContent);
    expect(labels.slice(-2)).toEqual(['Back to Directory', 'Sign out']);
    const back = screen.getByRole('menuitem', { name: 'Back to Directory' });
    expect(back.tagName).toBe('A');
    expect(back).toHaveAttribute('href', '/pick');
  });

  it('does not show Back to Directory to a kinfolk account', async () => {
    await openMenu(true, false);
    expect(screen.queryByRole('menuitem', { name: 'Back to Directory' })).toBeNull();
  });

  it('closes after choosing Back to Directory and does not sign out', async () => {
    const { onSignOut } = await openMenu(false, true);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Back to Directory' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onSignOut).not.toHaveBeenCalled();
  });

  /**
   * The full #1295 map order, the same as Android's ShellNav.accountMenu for an
   * operator with billing access (ShellNavTest.accountMenu_fullMapOrder).
   */
  it('lists the full map order for an operator with billing access', async () => {
    const { items } = await openMenu(true, true);
    expect(items.map((el) => el.textContent)).toEqual([
      'Account',
      'Invoices',
      'Edit Tribe Profile',
      'Notification settings',
      'About your Auntie',
      'Back to Directory',
      'Sign out',
    ]);
    expect(items.map((el) => el.getAttribute('href'))).toEqual([
      '/account',
      '/invoices',
      '/tribe/edit',
      '/account/notifications',
      '/about',
      '/pick',
      null,
    ]);
  });
});

/**
 * #1490: the About item reads "About {business name}" (the #1295 map), and
 * "About your Auntie" when no name is cached, the About screen's own title.
 * Android's ShellNav.accountMenu(businessName) gives the same words.
 */
describe('AvatarMenu About label (#1490)', () => {
  it('names the business', async () => {
    const { items } = await openMenu(false, false, 'Sunny Paws');
    expect(items[3]).toHaveTextContent('About Sunny Paws');
    expect(items[3]).toHaveAttribute('href', '/about');
  });
  it('trims the name', async () => {
    const { items } = await openMenu(false, false, '  Sunny Paws  ');
    expect(items[3]!.textContent).toBe('About Sunny Paws');
  });
  it.each([[undefined], [null], [''], ['   ']])('falls back to About your Auntie for %j', async (name) => {
    const { items } = await openMenu(false, false, name);
    expect(items[3]!.textContent).toBe('About your Auntie');
  });
});
