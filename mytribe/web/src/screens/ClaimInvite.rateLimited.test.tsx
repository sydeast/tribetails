// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * #931: `getInvitePreview` and `claimInviteSignup` both refuse with
 * `resource-exhausted` once their rate limit is hit. That must read as "wait",
 * never as "check your connection" (the preview's generic failure copy) or the
 * raw SDK message.
 */

const portal = vi.hoisted(() => ({
  getInvitePreview: vi.fn(),
  acceptInvite: vi.fn(),
  claimInviteSignup: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../api/portal', () => portal);
vi.mock('../lib/auth', () => ({
  signIn: vi.fn(),
  sendReset: vi.fn(),
  signInWithToken: vi.fn(),
  refreshEmailVerification: vi.fn(),
  resendVerificationEmail: vi.fn(),
  useAuth: () => ({ status: 'signedOut' }),
  useSignOut: () => ({ signOut: vi.fn(), signingOut: false }),
}));

import { ClaimInvite } from './ClaimInvite';
import { isRateLimitedError } from '../lib/authErrors';

/** What the Functions web SDK throws for the server's rate-limit refusal. */
const RATE_LIMITED = Object.assign(new Error('Too many attempts. Try again later.'), {
  code: 'functions/resource-exhausted',
});
const VALID = { status: 'valid', invitedEmail: 'kin@example.com', tribeName: 'The Parkers' };

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
  vi.clearAllMocks();
});

describe('#931 isRateLimitedError', () => {
  it('recognises the callable refusal by code or by the server message, and nothing else', () => {
    expect(isRateLimitedError(RATE_LIMITED)).toBe(true);
    expect(isRateLimitedError({ code: 'functions/resource-exhausted', message: 'rate-limited' })).toBe(true);
    expect(isRateLimitedError(new Error('Too many attempts. Try again later.'))).toBe(true);
    expect(isRateLimitedError({ code: 'functions/unavailable', message: 'Failed to fetch' })).toBe(false);
    expect(isRateLimitedError({ code: 'functions/not-found', message: 'invite not found' })).toBe(false);
    expect(isRateLimitedError(null)).toBe(false);
  });
});

describe('#931 ClaimInvite rate limits', () => {
  it('a rate-limited preview says to wait, not to check the connection, and the retry recovers', async () => {
    // The screen's own QueryClient has retry disabled here, so one refusal is enough.
    portal.getInvitePreview.mockRejectedValue(RATE_LIMITED);
    renderClaim();

    expect(await screen.findByText('Too many tries for now')).toBeInTheDocument();
    expect(screen.getByText('Wait a few minutes, then try again.')).toBeInTheDocument();
    expect(screen.queryByText('Could not open this invite')).toBeNull();
    expect(screen.queryByText('Check your connection and try again.')).toBeNull();

    portal.getInvitePreview.mockResolvedValue(VALID);
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(await screen.findByLabelText('Choose a password')).toBeInTheDocument();
  });

  it('any other preview failure keeps the connection card, not the wait one', async () => {
    portal.getInvitePreview.mockRejectedValue(
      Object.assign(new Error('Failed to fetch'), { code: 'functions/unavailable' }),
    );
    renderClaim();
    expect(await screen.findByText('Could not open this invite')).toBeInTheDocument();
    expect(screen.queryByText('Too many tries for now')).toBeNull();
  });

  it('a rate-limited signup claim shows the wait message on the create-account card', async () => {
    portal.getInvitePreview.mockResolvedValue(VALID);
    portal.claimInviteSignup.mockRejectedValue(RATE_LIMITED);
    renderClaim();

    const password = await screen.findByLabelText('Choose a password');
    fireEvent.change(password, { target: { value: 'longenough' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'longenough' } });
    fireEvent.submit(password.closest('form')!);

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many tries for now. Wait a few minutes, then try again.');
    expect(portal.claimInviteSignup).toHaveBeenCalledWith('inv-1', 'longenough');
  });
});
