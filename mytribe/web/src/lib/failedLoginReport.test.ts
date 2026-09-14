import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #886: the portal's sign-in reports credential failures to `recordFailedLogin`,
 * and only those, without ever holding up or changing the error the kinfolk sees.
 *
 * `signIn` is driven for real; Firebase Auth and the callable wrapper are the
 * only fakes. The report is a promise that NEVER settles, so a `signIn` that
 * awaited it would hang this test instead of rejecting.
 */

const { signInWithEmailAndPassword, reportFailedLogin } = vi.hoisted(() => ({
  signInWithEmailAndPassword: vi.fn(),
  reportFailedLogin: vi.fn(),
}));

vi.mock('./firebase', () => ({ auth: { currentUser: null }, activateAppCheck: vi.fn() }));
vi.mock('./activeTribe', () => ({ clearAccess: vi.fn(), clearActiveTribeSession: vi.fn() }));
vi.mock('./queryClient', () => ({ queryClient: { clear: vi.fn() } }));
vi.mock('./push', () => ({ unregisterForPush: vi.fn() }));
vi.mock('../api/authApi', () => ({ signOutAllDevices: vi.fn(), reportFailedLogin }));
vi.mock('firebase/auth', () => ({
  initializeRecaptchaConfig: vi.fn().mockResolvedValue(undefined),
  onAuthStateChanged: vi.fn().mockReturnValue(vi.fn()),
  sendEmailVerification: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  signInWithCustomToken: vi.fn(),
  signInWithEmailAndPassword,
  signOut: vi.fn(),
}));

import { signIn } from './auth';
import {
  ACCOUNT_LOCKED_MESSAGE,
  isAccountLockedError,
  isCredentialSignInError,
  mapAuthError,
} from './authErrors';

const EMAIL = 'pat@household.test';

/** The shape the JS SDK throws: a FirebaseError-like object with a code and message. */
function authError(code: string, message = `Firebase: Error (${code}).`): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/**
 * What the JS SDK makes of beforeSignIn's refusal. The server text is the Auth
 * emulator's verbatim 400 body for a locked account (2026-09-14 run); the SDK
 * keeps the part after " : " and tags it auth/internal-error.
 */
const LOCKED = authError(
  'auth/internal-error',
  'Firebase: ((HTTP request to http://127.0.0.1:5699/auntieos-ttpc/us-central1/beforeSignIn returned HTTP error 403: {"error":{"message":"This account is locked. Use the reset password link or contact support.","status":"PERMISSION_DENIED"}})) (auth/internal-error).',
);

const neverSettles = () => new Promise<{ ok: true }>(() => {});

beforeEach(() => {
  vi.clearAllMocks();
  reportFailedLogin.mockImplementation(neverSettles);
});

describe('#886 portal signIn reports credential failures', () => {
  it.each(['auth/wrong-password', 'auth/user-not-found', 'auth/invalid-credential', 'auth/invalid-login-credentials'])(
    '%s: reports the email, and rejects with the untouched error without waiting for the report',
    async (code) => {
      const err = authError(code);
      signInWithEmailAndPassword.mockRejectedValue(err);

      await expect(signIn(EMAIL, 'guess')).rejects.toBe(err);

      expect(reportFailedLogin).toHaveBeenCalledTimes(1);
      expect(reportFailedLogin).toHaveBeenCalledWith(EMAIL);
    },
  );

  it.each([
    ['a network failure', authError('auth/network-request-failed')],
    ['too many requests', authError('auth/too-many-requests')],
    ['a disabled user', authError('auth/user-disabled')],
    ['a malformed email', authError('auth/invalid-email')],
    ["beforeSignIn's locked refusal", LOCKED],
    ['a fetch that never left', new TypeError('Failed to fetch')],
  ])('%s: does not report', async (_label, err) => {
    signInWithEmailAndPassword.mockRejectedValue(err);
    await expect(signIn(EMAIL, 'pw')).rejects.toBe(err);
    expect(reportFailedLogin).not.toHaveBeenCalled();
  });

  it('a report that rejects is swallowed: the sign-in error is still the one thrown, and nothing is unhandled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = authError('auth/wrong-password');
    signInWithEmailAndPassword.mockRejectedValue(err);
    reportFailedLogin.mockRejectedValue(new Error('functions/unavailable'));

    await expect(signIn(EMAIL, 'guess')).rejects.toBe(err);
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledWith('[Auth] recordFailedLogin report failed:', expect.any(Error));
    warn.mockRestore();
  });

  it('a report that throws synchronously is swallowed too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = authError('auth/invalid-credential');
    signInWithEmailAndPassword.mockRejectedValue(err);
    reportFailedLogin.mockImplementation(() => {
      throw new Error('boom');
    });

    await expect(signIn(EMAIL, 'guess')).rejects.toBe(err);
    warn.mockRestore();
  });

  it('a successful sign-in reports nothing', async () => {
    signInWithEmailAndPassword.mockResolvedValue({ user: { uid: 'u1' } });
    await expect(signIn(EMAIL, 'right')).resolves.toEqual({ uid: 'u1' });
    expect(reportFailedLogin).not.toHaveBeenCalled();
  });
});

describe('#886 portal locked-state mapping', () => {
  it("recognises beforeSignIn's refusal and nothing else as locked", () => {
    expect(isAccountLockedError(LOCKED)).toBe(true);
    expect(isAccountLockedError(authError('auth/internal-error', 'Firebase: Error (auth/internal-error).'))).toBe(false);
    expect(isAccountLockedError(authError('auth/wrong-password'))).toBe(false);
  });

  it('maps the refusal to the locked message, which names the reset control', () => {
    const out = mapAuthError(LOCKED);
    expect(out).toEqual({ kind: 'locked', message: ACCOUNT_LOCKED_MESSAGE });
    expect(out.message).toContain('Forgot password?');
  });

  it('leaves the ordinary credential message exactly as it was', () => {
    expect(mapAuthError(authError('auth/invalid-credential'))).toEqual({
      kind: 'credentials',
      message: 'That email and password did not match. Check for typos and try again.',
    });
  });

  it('counts the REST credential codes and not the locked refusal', () => {
    expect(isCredentialSignInError(new Error('INVALID_LOGIN_CREDENTIALS'))).toBe(true);
    expect(isCredentialSignInError(new Error('INVALID_PASSWORD'))).toBe(true);
    expect(isCredentialSignInError(new Error('EMAIL_NOT_FOUND'))).toBe(true);
    expect(isCredentialSignInError(LOCKED)).toBe(false);
  });
});
