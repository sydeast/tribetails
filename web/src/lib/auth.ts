import {
  initializeRecaptchaConfig,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth';
import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { auth, activateAppCheck } from './firebase';

/**
 * reCAPTCHA Enterprise bootstrap.
 *
 * Identity Toolkit rejects sign-in with HTTP 503 "Error code: 47" when the
 * project has a Web site key configured and no reCAPTCHA token rides along.
 * initializeRecaptchaConfig installs an interceptor that attaches a token to
 * every sign-in / sign-up / password-reset call.
 *
 * The Kotlin app had a race here: sign-in could fire before the interceptor
 * was installed. We fix it by AWAITING this promise before every auth call.
 * Failure is logged but never thrown (falls back to no-token attach), so the
 * await can never strand sign-in.
 */
let recaptchaReady: Promise<void> | null = null;

/**
 * S7-BLOCKER-1 addendum: once the AUTH reCAPTCHA has loaded in this session,
 * App Check must never activate in the same page lifetime. The collision cuts
 * both ways — whichever Enterprise script loads second executes its key
 * against the other's instance and its token promise PENDS silently. When
 * that second script is App Check's, every subsequent callable stalls before
 * the network (the functions SDK awaits the App Check token outside its own
 * timeout), which is exactly the "Accepting your invite…" hang on the claim
 * screen. App Check instead activates on the NEXT full page load, where the
 * signed-in boot path runs before any auth recaptcha exists.
 */
export function authRecaptchaLoaded(): boolean {
  return recaptchaReady !== null;
}

export function ensureRecaptcha(): Promise<void> {
  if (!recaptchaReady) {
    recaptchaReady = initializeRecaptchaConfig(auth)
      .then(() => {
        console.log('[Auth] reCAPTCHA Enterprise initialized');
      })
      .catch((err: unknown) => {
        console.warn('[Auth] initializeRecaptchaConfig failed:', err);
      });
  }
  return recaptchaReady;
}

/** Email/password sign-in. Waits for the reCAPTCHA interceptor first. */
export async function signIn(email: string, password: string): Promise<User> {
  await ensureRecaptcha();
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

/** Custom-token sign-in (claim flow: claimInviteSignup returns the token). */
export async function signInWithToken(token: string): Promise<User> {
  await ensureRecaptcha();
  const cred = await signInWithCustomToken(auth, token);
  return cred.user;
}

/** Sends the Firebase password-reset email. */
export async function sendReset(email: string): Promise<void> {
  await ensureRecaptcha();
  await sendPasswordResetEmail(auth, email);
}

export async function signOut(): Promise<void> {
  // Best-effort, before the auth state that authorizes unregisterFcmToken's
  // caller-owns-this-token check disappears. Lazy import: push.ts pulls in
  // firebase/messaging, no need to load it on every module init.
  const { unregisterForPush } = await import('./push');
  await unregisterForPush();

  await firebaseSignOut(auth);
  // Lazy import: activeTribe.ts imports getAuthState/useAuth from this module,
  // so a static import here would be circular at module-init time.
  const { clearAccess } = await import('./activeTribe');
  clearAccess();

  // S7-BLOCKER-1: if App Check activated during this session, its Enterprise
  // api.js still owns `grecaptcha`, and an in-SPA hop to /signin (or the
  // claim screen's "Sign out and continue") would hit the collision on the
  // next sign-in. A full reload gives the signed-out page a clean slate and
  // preserves the current URL (claim links keep their ?invite= param).
  // try/catch: jsdom throws "Not implemented: navigation" on reload.
  try {
    window.location.reload();
  } catch {
    // Test environment; the auth listener above already flipped state.
  }
}

/**
 * signOut() plus the busy flag every Sign Out button needs (O-36).
 *
 * unregisterForPush round-trips to unregisterFcmToken before the auth state
 * that authorizes it disappears, so the wait is multi-second. The ref guard
 * (not the state flag) is what actually swallows a double tap: React batches
 * state, so two clicks in one tick would both read signingOut === false.
 *
 * Success deliberately leaves signingOut true — signOut() ends in a full page
 * reload, and re-enabling would flash a live button onto an unloading page.
 * Only a failure hands the button back.
 */
export function useSignOut(): { signOut: () => void; signingOut: boolean } {
  const [signingOut, setSigningOut] = useState(false);
  const inFlight = useRef(false);

  const run = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSigningOut(true);
    void signOut().catch(() => {
      inFlight.current = false;
      setSigningOut(false);
    });
  }, []);

  return { signOut: run, signingOut };
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
  // S7-BLOCKER-1: App Check activates only once signed in, so the auth
  // recaptcha always owns `grecaptcha` on the signed-out surfaces — and never
  // in a session where the auth recaptcha already loaded (the reverse
  // collision silently stalls every callable; see authRecaptchaLoaded above).
  // Sessions that signed in via a form pick App Check up on their next boot.
  if (user && !authRecaptchaLoaded()) activateAppCheck();
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
