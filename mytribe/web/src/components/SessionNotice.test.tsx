// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { useSessionHealth } = vi.hoisted(() => ({ useSessionHealth: vi.fn() }));
const { signOut, useSignOut } = vi.hoisted(() => ({ signOut: vi.fn(), useSignOut: vi.fn() }));

vi.mock('../lib/sessionHealth', () => ({ useSessionHealth }));
vi.mock('../lib/auth', () => ({ useSignOut }));

import { SessionNotice, sessionNoticeContent } from './SessionNotice';

describe('sessionNoticeContent', () => {
  it('has nothing to say about a healthy session', () => {
    expect(sessionNoticeContent({ status: 'ok' })).toBeNull();
  });

  it('names the consequence while a renewal is being refused', () => {
    const content = sessionNoticeContent({ status: 'unreachable', failures: 4 });
    expect(content?.reauth).toBe(false);
    // A kinfolk who is about to lose a booking needs to be told that, not just
    // that something technical happened.
    expect(content?.body).toMatch(/may not go through/);
  });

  it('asks for a fresh sign-in when only that will help', () => {
    expect(sessionNoticeContent({ status: 'expired' })?.reauth).toBe(true);
  });

  it('says something different for each degraded state', () => {
    const unreachable = sessionNoticeContent({ status: 'unreachable', failures: 1 });
    const expired = sessionNoticeContent({ status: 'expired' });
    expect(unreachable?.title).not.toBe(expired?.title);
    expect(unreachable?.body).not.toBe(expired?.body);
  });

  it('writes for a kinfolk, never naming the token', () => {
    for (const health of [
      { status: 'unreachable', failures: 1 } as const,
      { status: 'expired' } as const,
    ]) {
      const content = sessionNoticeContent(health);
      expect(`${content?.title} ${content?.body}`).not.toMatch(/token|refresh|auth/i);
    }
  });
});

describe('SessionNotice', () => {
  beforeEach(() => {
    useSessionHealth.mockReset();
    signOut.mockReset();
    useSignOut.mockReturnValue({ signOut, signingOut: false });
  });

  it('renders nothing at all while the session is healthy', () => {
    useSessionHealth.mockReturnValue({ status: 'ok' });
    const { container } = render(<SessionNotice />);
    expect(container).toBeEmptyDOMElement();
  });

  it('announces a refused renewal, with no button to press yet', () => {
    useSessionHealth.mockReturnValue({ status: 'unreachable', failures: 2 });
    render(<SessionNotice />);
    expect(screen.getByRole('alert')).toHaveTextContent('Trouble keeping you signed in');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers the way out when the session cannot renew itself', async () => {
    useSessionHealth.mockReturnValue({ status: 'expired' });
    render(<SessionNotice />);
    expect(screen.getByRole('alert')).toHaveTextContent('Please sign in again');

    await userEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('does not let a second tap start a second sign-out', () => {
    useSessionHealth.mockReturnValue({ status: 'expired' });
    useSignOut.mockReturnValue({ signOut, signingOut: true });
    render(<SessionNotice />);
    expect(screen.getByRole('button', { name: 'Signing out…' })).toBeDisabled();
  });
});
