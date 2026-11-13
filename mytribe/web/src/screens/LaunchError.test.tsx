// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

/**
 * #2140: a failed sign-out from this screen used to just hand the button back,
 * so the person could not tell it had not worked.
 */
describe('LaunchError failed sign-out (#2140)', () => {
  const FAILED = "We couldn't sign you out. You are still signed in. Check your connection and try again.";

  it('says sign-out failed, in plain words, and leaves Sign out usable', async () => {
    const onSignOut = vi.fn();
    render(<LaunchError onRetry={vi.fn()} onSignOut={onSignOut} signOutError={FAILED} />);
    expect(screen.getByRole('alert')).toHaveTextContent('You are still signed in');
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('says nothing about sign-out when nothing failed', () => {
    render(<LaunchError onRetry={vi.fn()} onSignOut={vi.fn()} signOutError={null} />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('is handed the failure by every screen that draws it', () => {
    // The screen only says what its caller passes. A new caller that forgets
    // the prop would bring the silent failure back, so every call site is read.
    const root = resolve(process.cwd(), 'src');
    const sources = (readdirSync(root, { recursive: true }) as string[])
      .filter((p) => /\.tsx$/.test(p) && !/\.test\.tsx$/.test(p) && !p.endsWith('LaunchError.tsx'));
    const missing: string[] = [];
    let seen = 0;
    for (const rel of sources) {
      const text = readFileSync(join(root, rel), 'utf8');
      for (const m of text.matchAll(/<LaunchError\b[\s\S]*?\/>/g)) {
        seen += 1;
        if (!/signOutError=\{/.test(m[0])) missing.push(rel);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(19);
    expect(missing).toEqual([]);
  });
});
