// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { useSessionHealth } = vi.hoisted(() => ({ useSessionHealth: vi.fn() }));
const { signOut } = vi.hoisted(() => ({ signOut: vi.fn() }));

vi.mock('../lib/sessionHealth', () => ({ useSessionHealth }));
vi.mock('../lib/auth', () => ({ signOut }));

import { SessionBanner, sessionNotice } from './SessionBanner';

describe('sessionNotice', () => {
  it('has nothing to say about a healthy session', () => {
    expect(sessionNotice({ status: 'ok' })).toBeNull();
  });

  it('names the network, not the operator, while a refresh is being refused', () => {
    const notice = sessionNotice({ status: 'unreachable', failures: 3 });
    expect(notice?.tone).toBe('warning');
    expect(notice?.reauth).toBe(false);
    // The point of the copy: an operator must be able to connect an
    // unexplained refusal to this, so the consequence has to be spelled out.
    expect(notice?.body).toMatch(/turned down/);
  });

  it('asks for a fresh sign-in when only that will help', () => {
    const notice = sessionNotice({ status: 'expired' });
    expect(notice?.tone).toBe('error');
    expect(notice?.reauth).toBe(true);
  });

  it('says something different for each degraded state', () => {
    const unreachable = sessionNotice({ status: 'unreachable', failures: 1 });
    const expired = sessionNotice({ status: 'expired' });
    expect(unreachable?.title).not.toBe(expired?.title);
    expect(unreachable?.body).not.toBe(expired?.body);
  });
});

describe('SessionBanner', () => {
  beforeEach(() => {
    useSessionHealth.mockReset();
    signOut.mockReset();
  });

  it('renders nothing at all while the session is healthy', () => {
    useSessionHealth.mockReturnValue({ status: 'ok' });
    const { container } = render(<SessionBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('announces a refused refresh, with no sign-in button to press yet', () => {
    useSessionHealth.mockReturnValue({ status: 'unreachable', failures: 2 });
    render(<SessionBanner />);
    // role="alert" is what makes this reach a screen reader rather than just
    // occupy space (Banner grants it to warning and error only).
    expect(screen.getByRole('alert')).toHaveTextContent('Signed in, but out of touch');
    expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull();
  });

  it('offers the way out when the session cannot renew itself', async () => {
    useSessionHealth.mockReturnValue({ status: 'expired' });
    render(<SessionBanner />);
    expect(screen.getByRole('alert')).toHaveTextContent('Sign in again to keep working');

    await userEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});
