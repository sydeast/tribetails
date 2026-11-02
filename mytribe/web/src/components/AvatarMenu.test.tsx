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

async function openMenu() {
  const onSignOut = vi.fn();
  render(<AvatarMenu initial="J" onSignOut={onSignOut} signingOut={false} />);
  await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
  return { onSignOut, items: within(screen.getByRole('menu')).getAllByRole('menuitem') };
}

describe('AvatarMenu items (#1454)', () => {
  it('lists Account, Edit Tribe Profile, Notification settings, About, Sign out in that order', async () => {
    const { items } = await openMenu();
    expect(items.map((el) => el.textContent)).toEqual(['Account', 'Edit Tribe Profile', 'Notification settings', 'About', 'Sign out']);
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
