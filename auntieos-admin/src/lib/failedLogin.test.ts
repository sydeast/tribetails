import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #886: the admin sign-in reports credential failures to `recordFailedLogin`,
 * and only those, without holding up or changing the error the operator sees.
 *
 * `signIn` runs for real. Firebase Auth and the callable seam (`./fns`) are the
 * fakes, and the callable NEVER settles, so a `signIn` that awaited the report
 * would hang instead of rejecting.
 */

const { signInWithEmailAndPassword, call } = vi.hoisted(() => ({
  signInWithEmailAndPassword: vi.fn(),
  call: vi.fn(),
}));

vi.mock('firebase/auth', () => ({
  onAuthStateChanged: vi.fn(),
  signInWithEmailAndPassword,
  signOut: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  reauthenticateWithCredential: vi.fn(),
  updatePassword: vi.fn(),
  verifyBeforeUpdateEmail: vi.fn(),
  EmailAuthProvider: { credential: vi.fn() },
}));
vi.mock('./firebase', () => ({ auth: { currentUser: null } }));
vi.mock('./boot', () => ({ decideAttestation: vi.fn() }));
vi.mock('./fns', () => ({ call }));

import { signIn } from './auth';
import { ACCOUNT_LOCKED_MSG, isAccountLockedError, isCredentialSignInError } from './failedLogin';

const EMAIL = 'auntie@tribetails.test';

function authError(code: string, message = `Firebase: Error (${code}).`): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** The JS SDK's form of beforeSignIn's refusal (server text from the Auth emulator, 2026-09-14). */
const LOCKED = authError(
  'auth/internal-error',
  'Firebase: ((HTTP request to http://127.0.0.1:5699/auntieos-ttpc/us-central1/beforeSignIn returned HTTP error 403: {"error":{"message":"This account is locked. Use the reset password link or contact support.","status":"PERMISSION_DENIED"}})) (auth/internal-error).',
);

beforeEach(() => {
  vi.clearAllMocks();
  call.mockImplementation(() => new Promise(() => {}));
});

describe('#886 admin signIn reports credential failures', () => {
  it.each(['auth/wrong-password', 'auth/user-not-found', 'auth/invalid-credential', 'auth/invalid-login-credentials'])(
    '%s: calls recordFailedLogin with the email and rejects with the same error at once',
    async (code) => {
      const err = authError(code);
      signInWithEmailAndPassword.mockRejectedValue(err);

      await expect(signIn(EMAIL, 'guess')).rejects.toBe(err);

      expect(call).toHaveBeenCalledTimes(1);
      expect(call).toHaveBeenCalledWith('recordFailedLogin', { email: EMAIL });
    },
  );

  it.each([
    ['a network failure', authError('auth/network-request-failed')],
    ['too many requests', authError('auth/too-many-requests')],
    ['a disabled user', authError('auth/user-disabled')],
    ['a malformed email', authError('auth/invalid-email')],
    ["beforeSignIn's locked refusal", LOCKED],
  ])('%s: does not call recordFailedLogin', async (_label, err) => {
    signInWithEmailAndPassword.mockRejectedValue(err);
    await expect(signIn(EMAIL, 'pw')).rejects.toBe(err);
    expect(call).not.toHaveBeenCalled();
  });

  it('swallows a report that rejects (offline, unstubbed in e2e) after logging it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = authError('auth/wrong-password');
    signInWithEmailAndPassword.mockRejectedValue(err);
    call.mockRejectedValue(new Error('OfflineCallError'));

    await expect(signIn(EMAIL, 'guess')).rejects.toBe(err);
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledWith('[Auth] recordFailedLogin report failed:', expect.any(Error));
    warn.mockRestore();
  });

  it('swallows a report that throws synchronously', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = authError('auth/invalid-credential');
    signInWithEmailAndPassword.mockRejectedValue(err);
    call.mockImplementation(() => {
      throw new Error('boom');
    });
    await expect(signIn(EMAIL, 'guess')).rejects.toBe(err);
    warn.mockRestore();
  });
});

describe('#886 admin locked-state detection', () => {
  it('identifies only the locked refusal', () => {
    expect(isAccountLockedError(LOCKED)).toBe(true);
    expect(isAccountLockedError(authError('auth/internal-error'))).toBe(false);
    expect(isCredentialSignInError(LOCKED)).toBe(false);
    expect(ACCOUNT_LOCKED_MSG).toContain('Forgot password?');
  });
});
