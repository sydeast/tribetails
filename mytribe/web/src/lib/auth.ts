import {
  applyActionCode,
  checkActionCode,
  confirmPasswordReset,
  initializeRecaptchaConfig,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  verifyPasswordResetCode,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth';
import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
// Import cycle with activeTribe.ts (it imports getAuthState/useAuth back), but
// every cross-reference is call-time and function declarations hoist, so
// neither side touches an uninitialized binding during module evaluation. The
// old dynamic import here never split a chunk anyway — activeTribe is
// statically imported by the router and most screens.
import { reportFailedLogin, signOutAllDevices } from '../api/authApi';
import { clearAccess, clearActiveTribeSession } from './activeTribe';
import { isCredentialSignInError } from './authErrors';
import { auth, activateAppCheck } from './firebase';
import { queryClient } from './queryClient';

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

/**
 * Email/password sign-in. Waits for the reCAPTCHA interceptor first.
 *
 * #886: a credential failure is reported to `recordFailedLogin` on the way out,
 * so the lockout and the household warning actually happen. Here and not in the
 * screens, because SignIn and ClaimInvite both sign in through this function.
 * The report never holds up or replaces the error: the original rejection is
 * rethrown on the same tick.
 */
export async function signIn(email: string, password: string): Promise<User> {
  await ensureRecaptcha();
  try {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    return cred.user;
  } catch (err) {
    reportCredentialFailure(email, err);
    throw err;
  }
}

/** Fire and forget. Swallows its own failures after logging them. */
function reportCredentialFailure(email: string, err: unknown): void {
  if (!isCredentialSignInError(err)) return;
  try {
    reportFailedLogin(email).catch((reportErr: unknown) => {
      console.warn('[Auth] recordFailedLogin report failed:', reportErr);
    });
  } catch (reportErr) {
    console.warn('[Auth] recordFailedLogin report failed:', reportErr);
  }
}

/** Custom-token sign-in (claim flow: claimInviteSignup returns the token). */
export async function signInWithToken(token: string): Promise<User> {
  await ensureRecaptcha();
  const cred = await signInWithCustomToken(auth, token);
  return cred.user;
}

/**
 * Where a portal reset link continues once the password is set (#892). The
 * link itself opens the project's email action page (/account/secure-reset);
 * this only decides where its "sign in" link goes.
 */
export const PORTAL_SIGN_IN_URL = 'https://kinfolk.tribetails.com/signin';

/**
 * Sends the Firebase password-reset email.
 *
 * `continueUrl` defaults to the portal sign-in. The email action page passes
 * the continue target of an expired link through, so a staff member who asks
 * for a fresh link there still ends on the admin sign-in.
 */
export async function sendReset(email: string, continueUrl: string | null = PORTAL_SIGN_IN_URL): Promise<void> {
  await ensureRecaptcha();
  if (continueUrl === null) {
    // A fresh link for a link that had no continue target (#892 review): the
    // page cannot tell a household from staff, so the new link stays bare and
    // the page again offers both sign-ins.
    await sendPasswordResetEmail(auth, email);
    return;
  }
  await sendPasswordResetEmail(auth, email, { url: continueUrl, handleCodeInApp: false });
}

/** Checks a reset link's oobCode without using it. Resolves the account email. */
export async function verifyResetCode(oobCode: string): Promise<string> {
  await ensureRecaptcha();
  return verifyPasswordResetCode(auth, oobCode);
}

/** Uses a reset link's oobCode to set the new password. */
export async function completeReset(oobCode: string, newPassword: string): Promise<void> {
  await ensureRecaptcha();
  await confirmPasswordReset(auth, oobCode, newPassword);
}

/**
 * Reads an email link's oobCode (verifyEmail, verifyAndChangeEmail,
 * recoverEmail) without using it.
 */
export async function readActionCode(
  oobCode: string,
): Promise<{ operation: string; email: string | null; previousEmail: string | null }> {
  await ensureRecaptcha();
  const info = await checkActionCode(auth, oobCode);
  // `operation` is what the CODE is, whatever the link's `mode` says (#892 review).
  return { operation: info.operation, email: info.data.email ?? null, previousEmail: info.data.previousEmail ?? null };
}

/** Uses an email link's oobCode (confirms, changes or restores the address). */
export async function applyEmailAction(oobCode: string): Promise<void> {
  await ensureRecaptcha();
  await applyActionCode(auth, oobCode);
}

/**
 * Re-read verification state from Firebase and mint a fresh ID token.
 *
 * THIS IS THE STEP THAT MAKES "verify your email, then try again" actually
 * work. Clicking a verification link flips `emailVerified` on the Firebase user
 * record, but the ID token already held by this tab was minted before that and
 * still carries `email_verified: false` for up to an hour, until it rotates on
 * its own. `acceptInvite` reads the TOKEN, so an invitee who really did verify
 * would keep being refused by a session that has not noticed, which reads as the
 * verification link being broken.
 *
 * `reload()` refreshes the local user record; `getIdToken(true)` forces a new
 * token off it. Returns whether the refreshed state is verified, so the caller
 * can say "we still cannot see it" instead of retrying into the same refusal.
 */
export async function refreshEmailVerification(): Promise<boolean> {
  const user = auth.currentUser;
  if (!user) return false;
  await user.reload();
  await user.getIdToken(true);
  return auth.currentUser?.emailVerified === true;
}

/**
 * Re-send a verification email to the signed-in user.
 *
 * `acceptInvite` already sends one when it refuses, so this is the "it never
 * arrived" path, not the primary one.
 */
export async function resendVerificationEmail(): Promise<void> {
  const user = auth.currentUser;
  if (!user) throw new Error('Sign in first.');
  await ensureRecaptcha();
  await sendEmailVerification(user);
}

/**
 * How long sign-out waits on the two calls that have to happen while the
 * session is still valid, before it stops waiting and ends the session anyway.
 *
 * Four seconds because both are ordinary callables (`lib/fns.ts` gives them a
 * 20s deadline of their own) and neither is worth more than a moment of a
 * kinfolk's patience. What the number must NOT be is "however long they take":
 * see #539 below.
 */
export const SIGN_OUT_CLEANUP_TIMEOUT_MS = 4_000;

/** Resolves when `work` settles or the timeout elapses, whichever comes first. Never rejects. */
async function bestEffort(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * End the session.
 *
 * #539 — "clicking the signout does not honor logout. users can click browser
 * back or forward to regain access without logging in again." The shape of that
 * defect was an ordering one, and it is worth naming because the old code reads
 * perfectly reasonably:
 *
 *   1. it AWAITED push cleanup — a dynamic `import()` plus a network round trip
 *      — before touching the auth session at all. A rejected chunk fetch or a
 *      stalled callable therefore meant `firebaseSignOut` never ran. Nothing
 *      surfaced: `useSignOut`'s catch quietly re-enabled the button, and the
 *      kinfolk stayed signed in on a device they believed they had left.
 *   2. every other part of teardown — the route guards, the React Query cache,
 *      the persisted tribe pick — was delegated to `window.location.reload()`,
 *      which is the last line of a function whose first line could hang.
 *
 * So the fix is an order, not a trick. Everything that needs a live session is
 * time-boxed and best-effort; the session teardown itself is unconditional; the
 * caches are purged explicitly rather than by reloading over them; and the
 * reload stays as the final flourish rather than the load-bearing step.
 *
 * Rejects only if Firebase itself refuses to sign out, which is the one case
 * where the kinfolk really is still signed in and the button should come back.
 */
export async function signOut(): Promise<void> {
  // Read BEFORE the sign-out; `auth.currentUser` is null afterwards and the
  // persisted tribe pick is keyed by uid.
  const uid = auth.currentUser?.uid ?? null;

  // Both of these need the ID token that is about to go away, so they go first
  // — but they go first with a clock on them. Lazy import for push.ts, which
  // pulls in firebase/messaging; no need to load that on every module init.
  await bestEffort(
    Promise.all([
      import('./push').then(({ unregisterForPush }) => unregisterForPush()),
      // Ends the session server-side. Local sign-out only drops this browser's
      // copy of the refresh token; the token itself stays valid until revoked.
      // See api/authApi.ts for exactly what this does and does not cover.
      signOutAllDevices(),
    ]),
    SIGN_OUT_CLEANUP_TIMEOUT_MS,
  );

  try {
    await firebaseSignOut(auth);
  } finally {
    // Even a failed sign-out leaves nothing of this account cached: the caches
    // are worthless to a session that is on its way out either way, and a purge
    // that only runs on the happy path is not a purge.
    purgeSessionCaches(uid);
  }

  // S7-BLOCKER-1: if App Check activated during this session, its Enterprise
  // api.js still owns `grecaptcha`, and an in-SPA hop to /signin (or the
  // claim screen's "Sign out and continue") would hit the collision on the
  // next sign-in. A full reload gives the signed-out page a clean slate and
  // preserves the current URL (claim links keep their ?invite= param).
  //
  // No longer load-bearing, and that is the point of #539: by the time this
  // runs the auth store has already flipped, router.tsx has already re-run
  // every guard on the mounted route, and the caches above are already empty.
  // If the reload never happens — jsdom throws "Not implemented: navigation",
  // a browser may refuse it mid-unload — the session is still over.
  try {
    window.location.reload();
  } catch {
    // Test environment; the auth listener above already flipped state.
  }
}

/**
 * Everything this browser still holds about the account that just left.
 *
 * The Firebase SDK clears its own persisted user. It knows nothing about the
 * three caches this app keeps on top of that, and any one of them left behind
 * is the previous kinfolk's household sitting in memory, ready to paint the
 * moment an authenticated route mounts again.
 */
/**
 * Exported for `revokedSession.ts` (#557), which tears a session down when the
 * SERVER ends it rather than when the kinfolk asks. That path cannot call
 * `signOut()` above (it starts with two authenticated callables, and being
 * refused is what got it there), but it must leave exactly as little behind.
 * One definition of what a session leaves behind means the next thing added
 * here covers both ways out.
 */
export function purgeSessionCaches(uid: string | null): void {
  clearAccess();
  // Every screen's data, keyed by kinfolk id. `clear()` and not
  // `removeQueries()`: there is no query in here that a signed-out visitor
  // should keep.
  queryClient.clear();
  if (uid !== null) clearActiveTribeSession(uid);
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

/**
 * Subscribe to auth-state transitions outside React (#539).
 *
 * `useAuth` covers components. The router is not a component: its guards run
 * on navigation and on nothing else, so a session that ends while a screen is
 * already mounted reaches no guard at all — the authenticated screen simply
 * stays up until something else moves. router.tsx subscribes here so the end of
 * a session counts as a reason to re-run them. Returns an unsubscribe.
 */
export function subscribeAuthState(listener: () => void): () => void {
  return subscribe(listener);
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
