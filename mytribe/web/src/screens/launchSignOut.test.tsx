// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NoTribes } from './NoTribes';
import { TribePicker } from './TribePicker';

/**
 * #1931, #1849: the two screens that render before the shell have their own
 * sign-out link. It reads "Sign out" like the avatar menu, shows a wait while
 * signing out, and says so when sign-out failed (the person is still signed in).
 */
const signOutSpy = vi.fn();
const state: { signingOut: boolean; error: string | null } = { signingOut: false, error: null };
vi.mock('../lib/auth', () => ({
  useSignOut: () => ({ signOut: signOutSpy, signingOut: state.signingOut, error: state.error }),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../api/portal', () => ({
  getBusinessContact: vi.fn().mockResolvedValue({ email: null }),
  getTribeSummaries: vi.fn().mockResolvedValue([]),
}));
vi.mock('../lib/activeTribe', () => ({
  setActiveKinfolkId: vi.fn(),
  useAccessState: () => ({ kinfolkIds: [], isOperator: true }),
}));

function wrap(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  signOutSpy.mockReset();
  state.signingOut = false;
  state.error = null;
});

describe.each([
  ['NoTribes', () => <NoTribes />],
  ['TribePicker', () => <TribePicker />],
])('%s sign-out link', (_name, screen_) => {
  it('reads "Sign out" and signs out when pressed', async () => {
    wrap(screen_());
    expect(screen.queryByText('Sign Out')).toBeNull();
    await userEvent.click(screen.getByText('Sign out'));
    expect(signOutSpy).toHaveBeenCalledTimes(1);
  });

  it('shows a wait indicator while signing out', () => {
    state.signingOut = true;
    wrap(screen_());
    expect(screen.getByText(/Signing out/)).toBeTruthy();
    expect(screen.queryByText('Sign out')).toBeNull();
  });

  it('tells the person when sign-out failed and that they are still signed in', () => {
    state.error = "We couldn't sign you out. You are still signed in.";
    wrap(screen_());
    expect(screen.getByRole('alert').textContent).toContain('still signed in');
    expect(screen.getByText('Sign out')).toBeTruthy();
  });
});
