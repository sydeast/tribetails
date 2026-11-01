// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SignIn } from './SignIn';
import { CARETAKER_REASON, SESSION_ENDED_STORAGE_KEY, sessionEndedMessage } from '../lib/revokedSession';

const { navigate, push, search, signIn } = vi.hoisted(() => ({
  navigate: vi.fn(),
  push: vi.fn(),
  search: { current: {} as Record<string, unknown> },
  signIn: vi.fn(),
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useSearch: () => search.current,
  useRouter: () => ({ history: { push } }),
}));
vi.mock('../lib/auth', () => ({ signIn, sendReset: vi.fn() }));

/**
 * #557, the last step of the chain. The backend refuses a revoked session, the
 * callable client signs the kinfolk out and lands them here — and if this
 * screen says nothing, the whole thing reads as "the app logged me out for no
 * reason", which is a worse experience than the bug being fixed.
 */
describe('SignIn session-ended notice', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('says why, when the sign-out was not the kinfolk’s doing', () => {
    sessionStorage.setItem(SESSION_ENDED_STORAGE_KEY, 'Your session ended, so we signed you out.');
    render(<SignIn />);
    expect(screen.getByTestId('session-ended-notice')).toHaveTextContent(/session ended/i);
  });

  // Docket Q1: an Auntie signed in to the portal, getMyAccess refused her, and
  // the teardown left this for her. Plain words about where she does sign in.
  it('tells an Auntie the portal is for households', () => {
    sessionStorage.setItem(SESSION_ENDED_STORAGE_KEY, sessionEndedMessage(CARETAKER_REASON));
    render(<SignIn />);
    expect(screen.getByTestId('session-ended-notice')).toHaveTextContent(
      'This sign-in is for households. Aunties use the AuntieOS app.',
    );
  });

  it('says nothing on an ordinary visit', () => {
    render(<SignIn />);
    expect(screen.queryByTestId('session-ended-notice')).toBeNull();
  });

  it('shows the notice once — a remount does not resurrect it', () => {
    sessionStorage.setItem(SESSION_ENDED_STORAGE_KEY, 'Your session ended, so we signed you out.');
    const first = render(<SignIn />);
    expect(screen.getByTestId('session-ended-notice')).toBeInTheDocument();
    first.unmount();
    render(<SignIn />);
    expect(screen.queryByTestId('session-ended-notice')).toBeNull();
  });
});

/**
 * #1384: a household that opened an email link while signed out lands on that
 * link after signing in, and a `redirect` that is not an in-app path is
 * ignored rather than followed.
 */
describe('SignIn, landing after sign-in', () => {
  async function submit() {
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'pawsome@hanasamku.com' } });
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: 'pw-not-real' } });
    fireEvent.submit(screen.getByLabelText(/email/i).closest('form') as HTMLFormElement);
    await waitFor(() => expect(navigate.mock.calls.length + push.mock.calls.length).toBe(1));
  }
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    search.current = {};
    signIn.mockResolvedValue(undefined);
  });
  it('goes to Home when no redirect was carried', async () => {
    render(<SignIn />);
    await submit();
    expect(navigate).toHaveBeenCalledWith({ to: '/home' });
    expect(push).not.toHaveBeenCalled();
  });
  it('lands on the carried deep link, search and all', async () => {
    search.current = { redirect: '/invoices/inv_1?from=email' };
    render(<SignIn />);
    await submit();
    expect(push).toHaveBeenCalledWith('/invoices/inv_1?from=email');
    expect(navigate).not.toHaveBeenCalled();
  });
  it.each([
    'https://evil.example/home',
    '//evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
    'home',
    '/signin',
  ])('ignores %s and goes to Home', async (bad) => {
    search.current = { redirect: bad };
    render(<SignIn />);
    await submit();
    expect(navigate).toHaveBeenCalledWith({ to: '/home' });
    expect(push).not.toHaveBeenCalled();
  });
});
