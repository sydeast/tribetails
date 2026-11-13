// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * #2140: the claim card's "Sign out and continue" (an invite opened while
 * signed in as someone else) is a sign-out like any other. It shows a wait
 * while it runs and says so when it failed, instead of handing the button
 * back with nothing said.
 */

const { signOut, state } = vi.hoisted(() => ({
  signOut: vi.fn(),
  state: { signingOut: false, error: null as string | null },
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../api/portal', () => ({
  getInvitePreview: vi.fn().mockResolvedValue({ status: 'valid', invitedEmail: 'pawsome@hanasamku.com', tribeName: 'The Parkers' }),
  acceptInvite: vi.fn(),
  claimInviteSignup: vi.fn(),
}));
vi.mock('../lib/auth', () => ({
  signIn: vi.fn(),
  sendReset: vi.fn(),
  signInWithToken: vi.fn(),
  refreshEmailVerification: vi.fn(),
  resendVerificationEmail: vi.fn(),
  useAuth: () => ({ status: 'signedIn', user: { uid: 'u-1', email: 'catch@hanasamku.com' } }),
  useSignOut: () => ({ signOut, signingOut: state.signingOut, error: state.error }),
}));

import { ClaimInvite } from './ClaimInvite';

const FAILED = "We couldn't sign you out. You are still signed in. Check your connection and try again.";

function renderClaim() {
  window.history.replaceState({}, '', '/claim?invite=inv-1');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ClaimInvite />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  signOut.mockReset();
  state.signingOut = false;
  state.error = null;
});

describe('ClaimInvite: Sign out and continue (#2140)', () => {
  it('signs out when pressed, with no failure said beforehand', async () => {
    renderClaim();
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out and continue' }));
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a wait and cannot be pressed again while signing out', async () => {
    state.signingOut = true;
    renderClaim();
    expect(await screen.findByRole('button', { name: /Signing out/ })).toBeDisabled();
  });

  it('says sign-out failed and leaves the button usable for another try', async () => {
    state.error = FAILED;
    renderClaim();
    expect(await screen.findByRole('alert')).toHaveTextContent('You are still signed in');
    await userEvent.click(screen.getByRole('button', { name: 'Sign out and continue' }));
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});
