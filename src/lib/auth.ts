import {
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth';
import { useSyncExternalStore } from 'react';
import { auth } from './firebase';

/**
 * Auth for the AuntieOS admin app. Structurally mirrors
 * MyTribe/web/src/lib/auth.ts (the onAuthStateChanged -> useSyncExternalStore
 * store + waitForAuthReady router hook), MINUS the reCAPTCHA/App Check bootstrap:
 * per firebase.ts, App Check is deliberately deferred to A8 (O-30 Phase 2), and
 * activating it here would re-introduce the Enterprise-loader collision that
 * silently stalls every callable. Do not add ensureRecaptcha here without
 * reading that ruling.
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

/** Sends the Firebase password-reset email. */
export async function sendReset(email: string): Promise<void> {
  await sendPasswordResetEmail(auth, email);
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
