import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FirebaseError } from 'firebase/app';

/**
 * Credential-change coverage for lib/auth.ts (Account security panel).
 *
 * Two things this file exists to pin down, both of which a "does it call
 * Firebase" smoke test would miss:
 *
 *  1. ORDER. Firebase will happily run updatePassword without a fresh
 *     reauthentication and fail with `auth/requires-recent-login` only
 *     sometimes (it depends how old the session is), so a change-password flow
 *     that forgot to reauthenticate passes by luck on a fresh login and breaks
 *     for the operator who has been signed in all week. Every happy-path test
 *     below asserts the recorded call sequence, not just that both mocks ran.
 *  2. TYPED errors. The panel must never render `auth/wrong-password` at a
 *     human, and it must never branch on an error MESSAGE (those are Firebase's
 *     to reword). Every sad path asserts the `code` on the thrown
 *     AccountSecurityError, and asserts the copy carries no raw Firebase code.
 */

const calls: string[] = [];

const {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  reauthenticateWithCredential,
  updatePassword,
  verifyBeforeUpdateEmail,
  credential,
} = vi.hoisted(() => ({
  onAuthStateChanged: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  reauthenticateWithCredential: vi.fn(),
  updatePassword: vi.fn(),
  verifyBeforeUpdateEmail: vi.fn(),
  credential: vi.fn(),
}));

const { authStub } = vi.hoisted(() => ({
  authStub: { currentUser: null as unknown },
}));

vi.mock('firebase/auth', () => ({
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  reauthenticateWithCredential,
  updatePassword,
  verifyBeforeUpdateEmail,
  EmailAuthProvider: { credential },
}));
vi.mock('./firebase', () => ({ auth: authStub }));

import {
  AccountSecurityError,
  changeEmail,
  changePassword,
  sendReset,
} from './auth';

function signedInUser(email: string | null = 'auntie@tribetails.com') {
  return { uid: 'op-1', email };
}

function fbError(code: string, message = 'Firebase said no'): FirebaseError {
  return new FirebaseError(code, message);
}

beforeEach(() => {
  calls.length = 0;
  authStub.currentUser = signedInUser();
  credential.mockReset();
  credential.mockImplementation((email: string, password: string) => ({
    kind: 'email-credential',
    email,
    password,
  }));
  reauthenticateWithCredential.mockReset();
  reauthenticateWithCredential.mockImplementation(async () => {
    calls.push('reauthenticateWithCredential');
  });
  updatePassword.mockReset();
  updatePassword.mockImplementation(async () => {
    calls.push('updatePassword');
  });
  verifyBeforeUpdateEmail.mockReset();
  verifyBeforeUpdateEmail.mockImplementation(async () => {
    calls.push('verifyBeforeUpdateEmail');
  });
  sendPasswordResetEmail.mockReset();
  sendPasswordResetEmail.mockImplementation(async () => {
    calls.push('sendPasswordResetEmail');
  });
});

describe('changePassword', () => {
  it('reauthenticates BEFORE updating, never the other way round', async () => {
    await changePassword('old-secret', 'new-secret-1');
    expect(calls).toEqual(['reauthenticateWithCredential', 'updatePassword']);
  });

  it('builds the reauth credential from the signed-in email and the CURRENT password', async () => {
    await changePassword('old-secret', 'new-secret-1');
    expect(credential).toHaveBeenCalledWith('auntie@tribetails.com', 'old-secret');
    expect(reauthenticateWithCredential).toHaveBeenCalledWith(
      authStub.currentUser,
      expect.objectContaining({ kind: 'email-credential' }),
    );
    expect(updatePassword).toHaveBeenCalledWith(authStub.currentUser, 'new-secret-1');
  });

  it('maps a wrong current password to code wrong-password and NEVER updates', async () => {
    reauthenticateWithCredential.mockRejectedValueOnce(fbError('auth/wrong-password'));
    const err = await changePassword('nope', 'new-secret-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountSecurityError);
    expect((err as AccountSecurityError).code).toBe('wrong-password');
    expect((err as Error).message).toBe('Current password is incorrect.');
    expect(updatePassword).not.toHaveBeenCalled();
  });

  it('maps auth/invalid-credential (the modern wrong-password code) the same way', async () => {
    reauthenticateWithCredential.mockRejectedValueOnce(fbError('auth/invalid-credential'));
    const err = await changePassword('nope', 'new-secret-1').catch((e: unknown) => e);
    expect((err as AccountSecurityError).code).toBe('wrong-password');
  });

  it('rejects a too-short new password locally, before touching Firebase at all', async () => {
    const err = await changePassword('old-secret', '12345').catch((e: unknown) => e);
    expect((err as AccountSecurityError).code).toBe('weak-password');
    expect(reauthenticateWithCredential).not.toHaveBeenCalled();
    expect(updatePassword).not.toHaveBeenCalled();
  });

  it('maps the SERVER weak-password verdict too (the project policy can exceed 6 chars)', async () => {
    updatePassword.mockRejectedValueOnce(fbError('auth/weak-password'));
    const err = await changePassword('old-secret', 'new-secret-1').catch((e: unknown) => e);
    expect((err as AccountSecurityError).code).toBe('weak-password');
    expect((err as Error).message).toMatch(/stronger password/i);
  });

  it('maps requires-recent-login to a "sign in again" instruction', async () => {
    updatePassword.mockRejectedValueOnce(fbError('auth/requires-recent-login'));
    const err = await changePassword('old-secret', 'new-secret-1').catch((e: unknown) => e);
    expect((err as AccountSecurityError).code).toBe('requires-recent-login');
    expect((err as Error).message).toMatch(/sign in again/i);
  });

  it('maps a network failure to its own code rather than a generic shrug', async () => {
    reauthenticateWithCredential.mockRejectedValueOnce(fbError('auth/network-request-failed'));
    const err = await changePassword('old-secret', 'new-secret-1').catch((e: unknown) => e);
    expect((err as AccountSecurityError).code).toBe('network-error');
    expect((err as Error).message).toMatch(/connection|network/i);
  });

  it('fails loud with not-signed-in rather than throwing a TypeError on a null user', async () => {
    authStub.currentUser = null;
    const err = await changePassword('old-secret', 'new-secret-1').catch((e: unknown) => e);
    expect((err as AccountSecurityError).code).toBe('not-signed-in');
    expect(reauthenticateWithCredential).not.toHaveBeenCalled();
  });

  it('fails loud when the account has no email to reauthenticate against', async () => {
    authStub.currentUser = signedInUser(null);
    const err = await changePassword('old-secret', 'new-secret-1').catch((e: unknown) => e);
    expect((err as AccountSecurityError).code).toBe('no-email');
  });

  it('keeps an unmapped Firebase failure visible, and still never shows the raw code', async () => {
    updatePassword.mockRejectedValueOnce(fbError('auth/internal-error', 'backend boom'));
    const err = await changePassword('old-secret', 'new-secret-1').catch((e: unknown) => e);
    expect((err as AccountSecurityError).code).toBe('unknown');
    expect((err as Error).message).toContain('backend boom');
    expect((err as Error).message).not.toContain('auth/');
  });

  it('never leaks a raw auth/ code into user-facing copy on any mapped path', async () => {
    const codes = [
      'auth/wrong-password',
      'auth/weak-password',
      'auth/requires-recent-login',
      'auth/too-many-requests',
      'auth/network-request-failed',
    ];
    for (const code of codes) {
      reauthenticateWithCredential.mockRejectedValueOnce(fbError(code));
      const err = await changePassword('old-secret', 'new-secret-1').catch((e: unknown) => e);
      expect((err as Error).message).not.toContain('auth/');
    }
  });
});

describe('changeEmail', () => {
  it('reauthenticates BEFORE sending the verification link', async () => {
    await changeEmail('old-secret', 'new@tribetails.com');
    expect(calls).toEqual(['reauthenticateWithCredential', 'verifyBeforeUpdateEmail']);
  });

  it('sends a verify-before-update link to the trimmed new address', async () => {
    await changeEmail('old-secret', '  new@tribetails.com  ');
    expect(verifyBeforeUpdateEmail).toHaveBeenCalledWith(
      authStub.currentUser,
      'new@tribetails.com',
    );
  });

  it('maps email-already-in-use, and never claims the address changed', async () => {
    verifyBeforeUpdateEmail.mockRejectedValueOnce(fbError('auth/email-already-in-use'));
    const err = await changeEmail('old-secret', 'taken@tribetails.com').catch((e: unknown) => e);
    expect((err as AccountSecurityError).code).toBe('email-already-in-use');
    expect((err as Error).message).toMatch(/already in use/i);
  });

  it('maps an invalid new address', async () => {
    verifyBeforeUpdateEmail.mockRejectedValueOnce(fbError('auth/invalid-email'));
    const err = await changeEmail('old-secret', 'not-an-email').catch((e: unknown) => e);
    expect((err as AccountSecurityError).code).toBe('invalid-email');
  });

  it('maps a wrong current password without ever sending a link', async () => {
    reauthenticateWithCredential.mockRejectedValueOnce(fbError('auth/wrong-password'));
    const err = await changeEmail('nope', 'new@tribetails.com').catch((e: unknown) => e);
    expect((err as AccountSecurityError).code).toBe('wrong-password');
    expect(verifyBeforeUpdateEmail).not.toHaveBeenCalled();
  });

  it('maps requires-recent-login', async () => {
    verifyBeforeUpdateEmail.mockRejectedValueOnce(fbError('auth/requires-recent-login'));
    const err = await changeEmail('old-secret', 'new@tribetails.com').catch((e: unknown) => e);
    expect((err as AccountSecurityError).code).toBe('requires-recent-login');
  });

  it('maps a network failure', async () => {
    verifyBeforeUpdateEmail.mockRejectedValueOnce(fbError('auth/network-request-failed'));
    const err = await changeEmail('old-secret', 'new@tribetails.com').catch((e: unknown) => e);
    expect((err as AccountSecurityError).code).toBe('network-error');
  });

  it('rejects a blank new address locally', async () => {
    const err = await changeEmail('old-secret', '   ').catch((e: unknown) => e);
    expect((err as AccountSecurityError).code).toBe('invalid-email');
    expect(reauthenticateWithCredential).not.toHaveBeenCalled();
  });
});

describe('sendReset', () => {
  it('sends the reset mail to the trimmed address', async () => {
    await sendReset('  auntie@tribetails.com ');
    expect(sendPasswordResetEmail).toHaveBeenCalledWith(authStub, 'auntie@tribetails.com', expect.anything());
  });

  it('continues the reset link back to the admin sign-in, not the portal (#892)', async () => {
    // The project's email action URL is the portal's /account/secure-reset, so
    // the link always opens there. The continue URL is what brings staff back.
    await sendReset('auntie@tribetails.com');
    const settings = sendPasswordResetEmail.mock.calls[0]?.[2] as { url: string; handleCodeInApp: boolean };
    expect(settings).toEqual({ url: 'https://auntie.tribetails.com/signin', handleCodeInApp: false });
  });

  it('maps a Firebase failure to a typed AccountSecurityError, not a raw code', async () => {
    sendPasswordResetEmail.mockRejectedValueOnce(fbError('auth/too-many-requests'));
    const err = await sendReset('auntie@tribetails.com').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountSecurityError);
    expect((err as AccountSecurityError).code).toBe('too-many-requests');
    expect((err as Error).message).not.toContain('auth/');
  });
});
