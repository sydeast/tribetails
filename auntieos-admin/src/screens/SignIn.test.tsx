// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * What the sign-in screen has to say about a session that ended without the
 * operator asking (#573), and how it hands the form back to a denied non-admin
 * once App Check is running (#576).
 *
 * The notice is asserted through the REAL `revokedSession` and `signInNotice`
 * modules — only `lib/firebase` and `firebase/auth` are stubbed beneath them —
 * so the key the writer uses and the key the reader uses cannot drift apart.
 */

const { useAuth, signIn, signOutSilent, sendReset } = vi.hoisted(() => ({
  useAuth: vi.fn(),
  signIn: vi.fn(),
  signOutSilent: vi.fn().mockResolvedValue(undefined),
  sendReset: vi.fn().mockResolvedValue(undefined),
}));
const { useNavigate } = vi.hoisted(() => {
  const navigate = vi.fn();
  return { useNavigate: vi.fn(() => navigate) };
});
const { resolveAccess } = vi.hoisted(() => ({ resolveAccess: vi.fn() }));
const { getAppCheckStatus } = vi.hoisted(() => ({ getAppCheckStatus: vi.fn(() => 'inactive') }));

vi.mock('../lib/auth', () => ({ useAuth, signIn, signOutSilent, sendReset }));
const { push, search } = vi.hoisted(() => ({ push: vi.fn(), search: { current: {} as Record<string, unknown> } }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate,
  useSearch: () => search.current,
  useRouter: () => ({ history: { push } }),
}));
vi.mock('../lib/access', () => ({ resolveAccess }));
vi.mock('../lib/firebase', () => ({ auth: { name: 'test-auth' }, getAppCheckStatus }));
vi.mock('firebase/auth', () => ({ signOut: vi.fn().mockResolvedValue(undefined) }));

import { SignIn } from './SignIn';
import {
  DISABLED_REASON,
  REVOKED_REASON,
  endRevokedSession,
  resetRevokedSessionForTest,
} from '../lib/revokedSession';
import { SIGN_IN_NOTICE_STORAGE_KEY } from '../lib/signInNotice';

const DENIED_MSG = 'This account does not have admin access.';

beforeEach(() => {
  vi.clearAllMocks();
  search.current = {};
  resetRevokedSessionForTest();
  sessionStorage.clear();
  useAuth.mockReturnValue({ status: 'signedOut' });
  getAppCheckStatus.mockReturnValue('inactive');
  signOutSilent.mockResolvedValue(undefined);
  sendReset.mockResolvedValue(undefined);
});
/**
 * The structure the mock draws (`ui-ideas/auntieos-sign-in-2026-05-27.html`,
 * #755): mark, wordmark, then one card carrying the greeting, two bottom-rule
 * fields, the full-width primary and a ghost at the right. Every visible
 * string is the mock's.
 */
describe('SignIn, the mock structure', () => {
  it('stacks the mark, the wordmark and the card in that order', () => {
    const { container } = render(<SignIn />);
    const stage = container.querySelector('.signin__stage');
    expect(stage).not.toBeNull();
    const blocks = Array.from(stage!.children).map((el) =>
      ['signin__mark', 'signin__brand', 'signin__card'].find((c) => el.classList.contains(c)),
    );
    expect(blocks).toEqual(['signin__mark', 'signin__brand', 'signin__card']);
    // The card is the kit's GlassSurface, not a local re-creation of one.
    expect(container.querySelector('.signin__card')).toHaveClass('glass-surface');
    // The paw is decoration; the wordmark is the only "AuntieOS" on the page.
    expect(container.querySelector('.signin__mark')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getAllByText('AuntieOS')).toHaveLength(1);
  });
  it('greets from inside the card, with the mock line under the heading', () => {
    render(<SignIn />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Welcome home, Auntie');
    expect(screen.getByText('Sign in to keep the Kinfolk taken care of.')).toBeInTheDocument();
    expect(screen.queryByText('Operator sign-in')).toBeNull();
  });
  it('labels the fields the way the mock does, placeholders included', () => {
    render(<SignIn />);
    const email = screen.getByLabelText('Email');
    const password = screen.getByLabelText('Password');
    expect(email).toHaveAttribute('placeholder', 'you@auntieos.com');
    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveAttribute('placeholder', '••••••••');
  });
  it('reveals and re-masks the password from the control inside its rule', () => {
    render(<SignIn />);
    const password = screen.getByLabelText('Password');
    const reveal = screen.getByRole('button', { name: 'Show password' });
    expect(reveal).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(reveal);
    expect(password).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(password).toHaveAttribute('type', 'password');
  });
  it('names the two controls as the mock does', () => {
    render(<SignIn />);
    expect(screen.getByRole('button', { name: 'Jump back in!' })).toHaveClass('auntie-btn--primary');
    expect(screen.getByRole('button', { name: 'Forgot password?' })).toHaveClass('auntie-btn--ghost');
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  });
  it('refuses an empty submit per field, highlights both, and puts no banner on the form (#1600)', async () => {
    render(<SignIn />);
    fireEvent.click(screen.getByRole('button', { name: 'Jump back in!' }));
    expect(await screen.findByText('Enter your email.')).toBeInTheDocument();
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Email').closest('.signin__input')).toHaveAttribute('data-invalid', 'true');
    // No banner means nothing above the form to push it down.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Email and password are required.')).toBeNull();
    // First refused field takes focus.
    expect(screen.getByLabelText('Email')).toHaveFocus();
    expect(signIn).not.toHaveBeenCalled();
  });
  it('names only the field that is empty', async () => {
    render(<SignIn />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'auntie@tribetails.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Jump back in!' }));
    expect(await screen.findByText('Enter your password.')).toBeInTheDocument();
    expect(screen.queryByText('Enter your email.')).toBeNull();
    expect(screen.getByLabelText('Email')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByLabelText('Password')).toHaveFocus();
  });
  it('clears a field message the moment that field is edited', async () => {
    render(<SignIn />);
    fireEvent.click(screen.getByRole('button', { name: 'Jump back in!' }));
    await screen.findByText('Enter your email.');
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a' } });
    expect(screen.queryByText('Enter your email.')).toBeNull();
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();
  });
  it('always lays out the message line under each field, so a refusal moves nothing', async () => {
    render(<SignIn />);
    const lines = () => document.querySelectorAll('.signin__fielderr');
    expect(lines()).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Jump back in!' }));
    await screen.findByText('Enter your email.');
    expect(lines()).toHaveLength(2);
  });
  it('sends the reset to the typed email and says so in the mock words', async () => {
    render(<SignIn />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: ' auntie@tribetails.com ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    expect(await screen.findByText('Reset link sent. Check your inbox.')).toBeInTheDocument();
    expect(sendReset).toHaveBeenCalledWith('auntie@tribetails.com');
    // A notice, not an alarm: the confirmation is not an error.
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('asks for the email first when the reset has nowhere to go', async () => {
    render(<SignIn />);
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    expect(await screen.findByText('Type your email above first.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(sendReset).not.toHaveBeenCalled();
  });
  it('shows a refused reset as an error, in the words the auth layer gave', async () => {
    sendReset.mockRejectedValueOnce(new Error('Couldn\'t send reset email.'));
    render(<SignIn />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'auntie@tribetails.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn\'t send reset email.');
  });
});

describe('SignIn, involuntary sign-out notice', () => {
  it('is silent on an ordinary visit', () => {
    render(<SignIn />);
    expect(screen.queryByText(/signed out/i)).toBeNull();
  });

  it('explains a revoked session in the first paint', async () => {
    await endRevokedSession(REVOKED_REASON);
    render(<SignIn />);
    expect(screen.getByText(/your session ended/i)).toBeTruthy();
  });

  it('says something different for a turned-off account', async () => {
    await endRevokedSession(DISABLED_REASON);
    render(<SignIn />);
    expect(screen.getByText(/turned off/i)).toBeTruthy();
  });

  it('shows the notice once, not on the next visit to the screen', async () => {
    await endRevokedSession(REVOKED_REASON);
    const first = render(<SignIn />);
    expect(screen.getByText(/your session ended/i)).toBeTruthy();
    first.unmount();

    render(<SignIn />);
    expect(screen.queryByText(/your session ended/i)).toBeNull();
  });
});

describe('SignIn, denying a non-admin who is already signed in', () => {
  beforeEach(() => {
    useAuth.mockReturnValue({ status: 'signedIn', user: { uid: 'kin-1' } });
    resolveAccess.mockResolvedValue({ status: 'denied' });
  });

  it('signs them out and says so in place when App Check never activated', async () => {
    render(<SignIn />);
    await waitFor(() => {
      expect(signOutSilent).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByText(DENIED_MSG)).toBeTruthy();
    });
    // No handoff needed: nothing owns `grecaptcha`, so the form is usable as it
    // stands and the message must NOT be parked for a reload that never comes.
    expect(sessionStorage.getItem(SIGN_IN_NOTICE_STORAGE_KEY)).toBeNull();
  });

  it('parks the refusal for a fresh document when App Check owns grecaptcha', async () => {
    // A lifetime that booted signed-in activated App Check, so handing the form
    // back on this document would make the next sign-in collide with its
    // reCAPTCHA Enterprise instance and spin forever.
    getAppCheckStatus.mockReturnValue('active');
    render(<SignIn />);
    await waitFor(() => {
      expect(sessionStorage.getItem(SIGN_IN_NOTICE_STORAGE_KEY)).toBe(DENIED_MSG);
    });
    expect(signOutSilent).toHaveBeenCalledTimes(1);
  });

  it('parks it while the first attestation token is still in flight, too', async () => {
    // `pending` is as much a reCAPTCHA owner as `active`: the script is loaded,
    // the token simply has not come back yet.
    getAppCheckStatus.mockReturnValue('pending');
    render(<SignIn />);
    await waitFor(() => {
      expect(sessionStorage.getItem(SIGN_IN_NOTICE_STORAGE_KEY)).toBe(DENIED_MSG);
    });
  });

  it('does not park it when attestation is merely unconfigured or failed', async () => {
    // Neither state loaded a script, so neither can collide with the auth
    // loader. Reloading for them would cost an operator a page load for nothing.
    for (const status of ['unconfigured', 'failed'] as const) {
      sessionStorage.clear();
      getAppCheckStatus.mockReturnValue(status);
      const view = render(<SignIn />);
      await waitFor(() => {
        expect(screen.getAllByText(DENIED_MSG).length).toBeGreaterThan(0);
      });
      expect(sessionStorage.getItem(SIGN_IN_NOTICE_STORAGE_KEY)).toBeNull();
      view.unmount();
    }
  });
});

/**
 * #1384: an operator who opened an email deep link while signed out lands on
 * that record after signing in, and a `redirect` that is not an in-app path is
 * ignored rather than followed.
 */
describe('SignIn, landing after sign-in', () => {
  function navigateMock() {
    return useNavigate() as unknown as ReturnType<typeof vi.fn>;
  }
  async function submit() {
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'e2e-admin@tribetails.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw-not-real' } });
    fireEvent.submit(screen.getByLabelText('Email').closest('form') as HTMLFormElement);
    await waitFor(() => expect(navigateMock().mock.calls.length + push.mock.calls.length).toBe(1));
  }
  beforeEach(() => {
    signIn.mockResolvedValue({ uid: 'admin-1' });
    resolveAccess.mockResolvedValue({ status: 'admin' });
  });
  it('goes to Home when no redirect was carried', async () => {
    render(<SignIn />);
    await submit();
    expect(navigateMock()).toHaveBeenCalledWith({ to: '/home' });
    expect(push).not.toHaveBeenCalled();
  });
  it('lands on the carried deep link, search and all', async () => {
    search.current = { redirect: '/directory/k1?section=unapplied-payments&paymentId=p1' };
    render(<SignIn />);
    await submit();
    expect(push).toHaveBeenCalledWith('/directory/k1?section=unapplied-payments&paymentId=p1');
    expect(navigateMock()).not.toHaveBeenCalled();
  });
  it.each([
    'https://evil.example/home',
    '//evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
    'invites/abc',
    '/signin',
  ])('ignores %s and goes to Home', async (bad) => {
    search.current = { redirect: bad };
    render(<SignIn />);
    await submit();
    expect(navigateMock()).toHaveBeenCalledWith({ to: '/home' });
    expect(push).not.toHaveBeenCalled();
  });
  it('lands on the carried link when a session already exists on arrival (guard bounce)', async () => {
    useAuth.mockReturnValue({ status: 'signedIn', user: { uid: 'admin-1' } });
    search.current = { redirect: '/invites/inv_9' };
    render(<SignIn />);
    await waitFor(() => expect(push).toHaveBeenCalledWith('/invites/inv_9'));
  });
});
