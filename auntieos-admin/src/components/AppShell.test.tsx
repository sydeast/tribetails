// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';

const { useRouteContext } = vi.hoisted(() => ({ useRouteContext: vi.fn() }));
const { useAuth, signOut } = vi.hoisted(() => ({ useAuth: vi.fn(), signOut: vi.fn() }));

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

import { AppShell } from './AppShell';

function signedIn(over: Record<string, unknown> = {}) {
  return {
    status: 'signedIn',
    user: { uid: 'op-1', email: 'nora@tribetails.com', displayName: 'Auntie Nora', ...over },
  };
}

beforeEach(() => {
  useRouteContext.mockReturnValue({ access: { status: 'admin' } });
  useAuth.mockReturnValue(signedIn());
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
