// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * #886: a returning invitee signs in on the claim card. When `beforeSignIn`
 * refuses a locked account, the message names "Forgot password?", so the claim
 * card has to carry that link and it has to send the reset.
 */

const { signIn, sendReset } = vi.hoisted(() => ({ signIn: vi.fn(), sendReset: vi.fn() }));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../api/portal', () => ({
  getInvitePreview: vi.fn().mockResolvedValue({ status: 'valid', invitedEmail: 'kin@example.com', tribeName: 'The Parkers' }),
  acceptInvite: vi.fn(),
  claimInviteSignup: vi.fn(),
}));
vi.mock('../lib/auth', () => ({
  signIn,
  sendReset,
  signInWithToken: vi.fn(),
  refreshEmailVerification: vi.fn(),
  resendVerificationEmail: vi.fn(),
  useAuth: () => ({ status: 'signedOut' }),
  useSignOut: () => ({ signOut: vi.fn(), signingOut: false }),
}));

import { ClaimInvite } from './ClaimInvite';
import { ACCOUNT_LOCKED_MESSAGE } from '../lib/authErrors';

const LOCKED = Object.assign(
  new Error(
    'Firebase: ((HTTP request to https://example.test/beforeSignIn returned HTTP error 403: {"error":{"message":"This account is locked. Use the reset password link or contact support.","status":"PERMISSION_DENIED"}})) (auth/internal-error).',
  ),
  { code: 'auth/internal-error' },
);

function renderClaim() {
  window.history.replaceState({}, '', '/claim?invite=inv-1');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ClaimInvite />
    </QueryClientProvider>,
  );
}

async function signInOnClaimCard(): Promise<void> {
  renderClaim();
  fireEvent.click(await screen.findByText('Already have a password? Sign in'));
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'right-password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in & join' }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('#886 ClaimInvite locked state', () => {
  it('shows the locked message and a working Forgot password? link on the claim card', async () => {
    signIn.mockRejectedValue(LOCKED);
    sendReset.mockResolvedValue(undefined);
    await signInOnClaimCard();

    expect(await screen.findByRole('alert')).toHaveTextContent(ACCOUNT_LOCKED_MESSAGE);
    const reset = screen.getByText('Forgot password?');
    expect(reset).toBeVisible();

    fireEvent.click(reset);
    expect(await screen.findByText('Reset link sent. Check your inbox.')).toBeInTheDocument();
    expect(sendReset).toHaveBeenCalledWith('kin@example.com');
  });

  it('a failed reset says so instead of claiming the link was sent', async () => {
    signIn.mockRejectedValue(LOCKED);
    sendReset.mockRejectedValue(new Error('network'));
    await signInOnClaimCard();
    await screen.findByRole('alert');

    fireEvent.click(screen.getByText('Forgot password?'));
    expect(await screen.findByText("Couldn't send reset email. Try again in a moment.")).toBeInTheDocument();
    expect(screen.queryByText('Reset link sent. Check your inbox.')).toBeNull();
  });

  it('the create-account card has no reset link, because there is no password to forget', async () => {
    renderClaim();
    expect(await screen.findByRole('button', { name: 'Create account & join' })).toBeInTheDocument();
    expect(screen.queryByText('Forgot password?')).toBeNull();
  });
});
