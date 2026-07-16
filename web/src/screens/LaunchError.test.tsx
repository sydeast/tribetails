// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LaunchError } from './LaunchError';

/**
 * O-36, at the DOM level. The hook test in lib/auth.test.ts proves the guard
 * logic; this proves the guard actually reaches the rendered control. A busy
 * flag that never makes it onto the button is exactly the class of bug unit
 * tests sail past — LaunchError is the sign-out surface for 13 screens, so it
 * is the one worth pinning.
 */
describe('LaunchError sign-out', () => {
  it('offers a live Sign out button when idle', () => {
    render(<LaunchError onRetry={vi.fn()} onSignOut={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled();
  });

  it('disables and relabels the button while signing out', () => {
    render(<LaunchError onRetry={vi.fn()} onSignOut={vi.fn()} signingOut />);
    const btn = screen.getByRole('button', { name: 'Signing out…' });
    expect(btn).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });

  it('drops taps that land while the sign-out is already in flight', async () => {
    const onSignOut = vi.fn();
    render(<LaunchError onRetry={vi.fn()} onSignOut={onSignOut} signingOut />);

    await userEvent.click(screen.getByRole('button', { name: 'Signing out…' }), { pointerEventsCheck: 0 });

    expect(onSignOut).not.toHaveBeenCalled();
  });

  it('keeps sign-out independent of the retry spinner', () => {
    render(<LaunchError onRetry={vi.fn()} onSignOut={vi.fn()} retrying />);
    expect(screen.getByRole('button', { name: 'Trying…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled();
  });
});
