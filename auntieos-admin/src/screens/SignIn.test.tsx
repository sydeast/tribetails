// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

/**
 * What the sign-in screen has to say about a session that ended without the
 * operator asking (#573), and how it hands the form back to a denied non-admin
 * once App Check is running (#576).
 *
 * The notice is asserted through the REAL `revokedSession` and `signInNotice`
 * modules — only `lib/firebase` and `firebase/auth` are stubbed beneath them —
 * so the key the writer uses and the key the reader uses cannot drift apart.
 */

const { useAuth, signIn, signOutSilent } = vi.hoisted(() => ({
  useAuth: vi.fn(),
  signIn: vi.fn(),
  signOutSilent: vi.fn().mockResolvedValue(undefined),
}));
const { useNavigate } = vi.hoisted(() => {
  const navigate = vi.fn();
  return { useNavigate: vi.fn(() => navigate) };
});
const { resolveAccess } = vi.hoisted(() => ({ resolveAccess: vi.fn() }));
const { getAppCheckStatus } = vi.hoisted(() => ({ getAppCheckStatus: vi.fn(() => 'inactive') }));

vi.mock('../lib/auth', () => ({ useAuth, signIn, signOutSilent }));
vi.mock('@tanstack/react-router', () => ({ useNavigate }));
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

const DENIED_MSG = 'This account is not authorized for the AuntieOS admin app.';

beforeEach(() => {
  vi.clearAllMocks();
  resetRevokedSessionForTest();
  sessionStorage.clear();
  useAuth.mockReturnValue({ status: 'signedOut' });
  getAppCheckStatus.mockReturnValue('inactive');
  signOutSilent.mockResolvedValue(undefined);
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
