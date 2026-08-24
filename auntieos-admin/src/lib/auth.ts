import { FirebaseError } from 'firebase/app';
import {
  EmailAuthProvider,
  onAuthStateChanged,
  reauthenticateWithCredential,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  updatePassword,
  verifyBeforeUpdateEmail,
  type User,
} from 'firebase/auth';
import { useSyncExternalStore } from 'react';
import { decideAttestation } from './boot';
import { auth } from './firebase';

/**
 * Auth for the AuntieOS admin app. Structurally mirrors
 * MyTribe/web/src/lib/auth.ts (the onAuthStateChanged -> useSyncExternalStore
 * store + waitForAuthReady router hook).
 *
 * APP CHECK IS WIRED NOW (#576). This comment used to say it was deferred to A8
 * and warn the next reader off adding it; that was true until the backend policy
 * layer landed in #562, and it is exactly the stale note the issue cites. What
 * survives from it is the REASON for the shape: only one reCAPTCHA Enterprise
 * loader may exist per page lifetime, so attestation is decided ONCE — in the
 * listener below, from the first resolved auth state — rather than activated at
 * module init. `lib/boot.ts` holds that decision and the whole argument for it.
 * Do not move the call out of the listener without reading it.
 *
 * There is deliberately still no `ensureRecaptcha` here. The portal needs one
 * because a tokenless sign-in is refused on its surfaces; this app has never
 * needed the pre-warm, and adding it would start the auth loader on every boot —
 * the shape that made App Check unreachable in the portal for months (#556).
 *
 * The admin GATE (is this signed-in user allowed into the app at all) lives in
 * access.ts, which reads the custom claims off the ID token. This module only
 * answers "is someone signed in".
 */

/** Email/password sign-in. */
export async function signIn(email: string, password: string): Promise<User> {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

// ---------------------------------------------------------------------------
// Credential changes (Account > Security). Firebase Auth client SDK only; there
// is no callable behind any of this and there does not need to be.
// ---------------------------------------------------------------------------

/**
 * What went wrong, as a value the UI can branch on.
 *
 * The point of a code is that no caller ever has to read a Firebase message, or
 * worse, match on one. Firebase is free to reword `auth/wrong-password`'s prose
 * in any patch release; the code is the contract. Every function below throws
 * exactly this type, so a caller's catch has one shape to handle.
 */
export type AccountSecurityErrorCode =
  | 'not-signed-in'
  | 'no-email'
  | 'wrong-password'
  | 'weak-password'
  | 'requires-recent-login'
  | 'email-already-in-use'
  | 'invalid-email'
  | 'too-many-requests'
  | 'network-error'
  | 'unknown';

/** Typed credential-change failure. `message` is already operator-facing copy. */
export class AccountSecurityError extends Error {
  readonly code: AccountSecurityErrorCode;

  constructor(code: AccountSecurityErrorCode, message: string) {
    super(message);
    this.name = 'AccountSecurityError';
    this.code = code;
  }
}

/** Firebase's shortest password. The project policy may demand more; the server says so. */
const MIN_PASSWORD_LENGTH = 6;

/**
 * Firebase error code to (code, copy). Mirrors Android's
 * `SecurityHelpers.friendlyAuthErrorForCode` one-for-one so an operator gets the
 * same sentence on both surfaces, with the web codes (`auth/...`) in place of
 * the Android SDK's (`ERROR_...`).
 *
 * The fallback keeps the Firebase MESSAGE (which is sometimes genuinely useful)
 * but never the code, because "auth/internal-error" is not a sentence.
 */
function toSecurityError(err: unknown): AccountSecurityError {
  if (err instanceof AccountSecurityError) return err;
  const code = err instanceof FirebaseError ? err.code : '';
  switch (code) {
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
    case 'auth/invalid-login-credentials':
      return new AccountSecurityError('wrong-password', 'Current password is incorrect.');
    case 'auth/weak-password':
      return new AccountSecurityError(
        'weak-password',
        'Choose a stronger password (at least 6 characters).',
      );
    case 'auth/requires-recent-login':
      return new AccountSecurityError(
        'requires-recent-login',
        'Please sign in again, then retry this change.',
      );
    case 'auth/email-already-in-use':
      return new AccountSecurityError('email-already-in-use', 'That email is already in use.');
    case 'auth/invalid-email':
    case 'auth/missing-email':
      return new AccountSecurityError('invalid-email', "That email address doesn't look right.");
    case 'auth/user-not-found':
      return new AccountSecurityError('invalid-email', 'No account uses that email address.');
    case 'auth/too-many-requests':
      return new AccountSecurityError(
        'too-many-requests',
        'Too many attempts. Wait a minute and try again.',
      );
    case 'auth/network-request-failed':
      return new AccountSecurityError(
        'network-error',
        'Network error. Check your connection and try again.',
      );
    default: {
      const raw = err instanceof Error ? err.message.trim() : '';
      return new AccountSecurityError(
        'unknown',
        raw === ''
          ? "Couldn't complete that change."
          : `Couldn't complete that change: ${raw}`,
      );
    }
  }
}

/** The signed-in user plus their login email, or a typed failure. */
function requireSignedInUser(): { user: User; email: string } {
  const user = auth.currentUser;
  if (user === null || user === undefined) {
    throw new AccountSecurityError('not-signed-in', 'You are not signed in.');
  }
  const email = (user.email ?? '').trim();
  if (email === '') {
    throw new AccountSecurityError(
      'no-email',
      'This account has no email address, so its password cannot be changed here.',
    );
  }
  return { user, email };
}

/**
 * Proves the person at the keyboard is the account owner.
 *
 * Firebase requires this before any credential change, and it enforces it only
 * when the session is old enough to bother. That is exactly what makes it easy
 * to get wrong: a change-password flow that skips the reauthentication works
 * fine for whoever just signed in and fails for everyone else with
 * `auth/requires-recent-login`. Both callers below go through here first, and
 * auth.test.ts asserts the call ORDER rather than merely that it happened.
 */
export async function reauthenticate(currentPassword: string): Promise<User> {
  const { user, email } = requireSignedInUser();
  try {
    await reauthenticateWithCredential(
      user,
      EmailAuthProvider.credential(email, currentPassword),
    );
  } catch (err) {
    throw toSecurityError(err);
  }
  return user;
}

/**
 * Reauthenticate, then set the new password. Mirrors Android's
 * `AuntieRepository.updateLoginPassword`.
 */
export async function changePassword(currentPassword: string, next: string): Promise<void> {
  if (next.length < MIN_PASSWORD_LENGTH) {
    // Caught here rather than spent on a round-trip. The server check still
    // stands behind it: a project password policy can demand more than six.
    throw new AccountSecurityError(
      'weak-password',
      'Choose a stronger password (at least 6 characters).',
    );
  }
  const user = await reauthenticate(currentPassword);
  try {
    await updatePassword(user, next);
  } catch (err) {
    throw toSecurityError(err);
  }
}

/**
 * Reauthenticate, then send a verification link to the NEW address.
 *
 * `verifyBeforeUpdateEmail`, not `updateEmail`: the login email flips only once
 * the operator opens the link in the new inbox. So this resolving means "we sent
 * a link", never "your email changed", and the UI must say the former. Mirrors
 * Android's `AuntieRepository.updateLoginEmail`.
 */
export async function changeEmail(currentPassword: string, newEmail: string): Promise<void> {
  const target = newEmail.trim();
  if (target === '') {
    throw new AccountSecurityError('invalid-email', 'Enter the new login email address.');
  }
  const user = await reauthenticate(currentPassword);
  try {
    await verifyBeforeUpdateEmail(user, target);
  } catch (err) {
    throw toSecurityError(err);
  }
}

/**
 * Sends the Firebase password-reset email.
 *
 * Wired from the Account > Security panel ("Send reset email"), matching
 * Android's SecurityPanel, which is the only place either app offers it.
 */
export async function sendReset(email: string): Promise<void> {
  try {
    await sendPasswordResetEmail(auth, email.trim());
  } catch (err) {
    throw toSecurityError(err);
  }
}

/**
 * Sign out, then hard-reload for a clean slate. Full reload (not an in-SPA hop)
 * mirrors the portal's O-36 signOut: it drops any lingering listener/token state
 * that a soft navigation would carry into the next sign-in. try/catch because
 * jsdom throws "Not implemented: navigation" on reload under test.
 */
export async function signOut(): Promise<void> {
  await firebaseSignOut(auth);
  try {
    window.location.reload();
  } catch {
    // Test environment; the auth listener below already flipped state.
  }
}

/**
 * Sign out WITHOUT a page reload. Used when a non-admin authenticated
 * successfully but is denied entry: the store flips to signedOut and the
 * sign-in form re-renders in place with the "not authorized" message, rather
 * than reloading out from under it.
 */
export async function signOutSilent(): Promise<void> {
  await firebaseSignOut(auth);
}

// ---------------------------------------------------------------------------
// Auth state store (onAuthStateChanged -> useSyncExternalStore)
// ---------------------------------------------------------------------------

export type AuthState =
  | { status: 'loading' }
  | { status: 'signedOut' }
  | { status: 'signedIn'; user: User };

let currentState: AuthState = { status: 'loading' };
const listeners = new Set<() => void>();

onAuthStateChanged(auth, (user) => {
  currentState = user ? { status: 'signedIn', user } : { status: 'signedOut' };
  // #576: the attestation decision, taken from the first auth state Firebase
  // resolves and BEFORE subscribers are notified. Order matters both ways: this
  // is the earliest point at which "does this lifetime make callables or sign
  // somebody in" is answerable, and a subscriber that fires a callable on the
  // very next line already has (or already knows it lacks) a token. Idempotent,
  // so the sign-in transition below cannot start a second reCAPTCHA loader.
  decideAttestation(currentState.status === 'signedIn');
  for (const l of listeners) l();
});

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): AuthState {
  return currentState;
}

/** Reactive auth state for components. */
export function useAuth(): AuthState {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Non-reactive read for router guards. */
export function getAuthState(): AuthState {
  return currentState;
}

/** Resolves once the initial auth state is known (signedIn or signedOut). */
export function waitForAuthReady(): Promise<AuthState> {
  if (currentState.status !== 'loading') return Promise.resolve(currentState);
  return new Promise((resolve) => {
    const un = subscribe(() => {
      if (currentState.status !== 'loading') {
        un();
        resolve(currentState);
      }
    });
  });
}
