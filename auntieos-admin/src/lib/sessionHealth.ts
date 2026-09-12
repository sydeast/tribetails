import { onAuthStateChanged } from 'firebase/auth';
import { useSyncExternalStore } from 'react';
import { auth } from './firebase';
import { reportError } from './sentry';

/**
 * Watches whether this signed-in session can still mint an ID token.
 *
 * WHY THIS EXISTS (#454). The 2026-08-17 admin walk captured 19 POSTs to
 * `securetoken.googleapis.com/v1/token`, the Firebase Auth refresh endpoint.
 * Thirteen returned 200. Six failed with `Failed to fetch`, all inside one
 * ~13-second window on /my-notifications, and the seventh attempt succeeded.
 * The same walk shows ten identical `Failed to fetch` results against
 * firestore.googleapis.com, so the cause was the machine losing the network for
 * a few seconds, not this app: the hosting CSP already allows the endpoint
 * (`connect-src https://*.googleapis.com`, and thirteen requests proved it
 * live), and an extension or blocker would have failed all nineteen.
 *
 * The DEFECT is what the walk does not contain. Across 22 hours and 16 failed
 * requests, the console capture holds no auth line at all, because nothing in
 * this app was listening. `onAuthStateChanged` does not fire when a refresh
 * fails — the SDK keeps `currentUser` and keeps serving the cached token until
 * it expires. The SDK's own ProactiveRefresh (see @firebase/auth
 * proactive_refresh.js) retries a network failure on a 30s-to-16min backoff and
 * silently gives up altogether on any other error, telling nobody either way.
 * So a refresh outage that outlives the cached token leaves an operator signed
 * in, clicking, and being refused — reading as "the app is broken" with no
 * clue why. This module is the missing observer.
 *
 * HOW IT PROBES, AND WHY IT IS CHEAP. `getIdToken(false)` returns the cached
 * token without touching the network unless that token is within 30 seconds of
 * expiring (StsTokenManager.getToken). So the probe costs nothing for most of
 * a token's hour, and reaches the network exactly when the SDK would have had
 * to anyway. It is also why a brief blip mid-token reports healthy, which is
 * correct: while the cached token is still valid nothing the operator does is
 * being refused, and a banner then would be crying wolf. The session is only
 * called degraded once a refresh is genuinely needed and cannot be had.
 *
 * WHY A BANNER RATHER THAN console + Sentry. `lib/useUnreadInbox.ts` argues
 * the opposite way for the rail's unread count, and is right to: a missing
 * badge is cosmetic, and welding a red banner to every screen over one is
 * noise. This is a different kind of fact. A session that cannot refresh will
 * start refusing saves, and the operator is the only one who can fix it (sign
 * in again) or wait it out knowingly. That belongs on screen. It still reports
 * to Sentry as well.
 */

/** How often a healthy session re-checks. */
export const PROBE_INTERVAL_MS = 60_000;
/** First retry gap after a failed probe. */
export const RETRY_MIN_MS = 5_000;
/** Ceiling on the retry gap, so a long outage settles at one probe a minute. */
export const RETRY_MAX_MS = 60_000;

export type SessionHealth =
  /** The session can mint a token, or has no reason to doubt it. */
  | { status: 'ok' }
  /**
   * A refresh is due and the network refused it. Self-clearing: the walk shows
   * recovery is the normal outcome, so this retries rather than nagging anyone
   * to sign in over a few seconds of bad wifi.
   */
  | { status: 'unreachable'; failures: number }
  /** A refresh failed for a reason retrying cannot fix. Only a re-auth will. */
  | { status: 'expired' };

/**
 * Which of the two degraded states a rejected `getIdToken` means.
 *
 * Only `auth/network-request-failed` is worth retrying — it is the code the
 * SDK itself uses as its retry gate. Everything else is the residue: the two
 * codes that really mean "this session is over", `auth/user-token-expired` and
 * `auth/user-disabled`, never reach here at all, because `_logoutIfInvalidated`
 * signs the user out on them and lib/auth.ts's store flips to signedOut. What
 * is left (`auth/internal-error` and friends) is rare, unretryable, and best
 * answered by signing in again.
 */
export function classifyRefreshFailure(err: unknown): 'unreachable' | 'expired' {
  const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : '';
  return code === 'auth/network-request-failed' ? 'unreachable' : 'expired';
}

/** Exponential backoff, 5s doubling to a 60s ceiling. `failures` starts at 1. */
export function retryDelayMs(failures: number): number {
  const n = Math.max(1, failures);
  return Math.min(RETRY_MIN_MS * 2 ** (n - 1), RETRY_MAX_MS);
}

let current: SessionHealth = { status: 'ok' };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

function publish(next: SessionHealth): void {
  if (next.status === current.status) {
    if (next.status !== 'unreachable') return;
    if (next.failures === (current as { failures: number }).failures) return;
  }
  current = next;
  for (const l of listeners) l();
}

function cancel(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

function schedule(ms: number): void {
  cancel();
  timer = setTimeout(() => {
    void probe();
  }, ms);
}

/**
 * Record a token refresh that has ALREADY failed, wherever it failed.
 *
 * The probe below is not the only thing in this app that asks Firebase to mint
 * a token, and until #812 it was the only one that told anybody when the answer
 * was no. `router.tsx`'s admin gate mints one on every navigation
 * (`resolveAccess` -> `getIdTokenResult`), and on a cold offline deep link that
 * is the FIRST refresh of the page's life, a full minute before the probe's
 * own first tick. Handing the failure here, rather than letting the gate invent
 * copy of its own, means the operator gets the banner this module already owns
 * on the first paint, and the retry loop starts from the same instant.
 *
 * Returns which of the two degraded states it settled on, because the gate has
 * to branch on it: `unreachable` is admitted read-only, `expired` is sent to
 * sign in again.
 */
export function noteRefreshFailure(err: unknown): 'unreachable' | 'expired' {
  if (classifyRefreshFailure(err) === 'expired') {
    // Retrying cannot mint a token this session. Stop probing and say so.
    cancel();
    publish({ status: 'expired' });
    reportError(err, 'sessionHealthExpired');
    return 'expired';
  }
  const failures = current.status === 'unreachable' ? current.failures + 1 : 1;
  // Reported once per episode, not once per retry: a five-minute outage
  // should be one Sentry event, not sixty.
  if (failures === 1) reportError(err, 'sessionHealthUnreachable');
  publish({ status: 'unreachable', failures });
  schedule(retryDelayMs(failures));
  return 'unreachable';
}

async function probe(): Promise<void> {
  const user = auth.currentUser;
  if (!user) {
    publish({ status: 'ok' });
    return;
  }
  try {
    await user.getIdToken(false);
    publish({ status: 'ok' });
    schedule(PROBE_INTERVAL_MS);
  } catch (err) {
    noteRefreshFailure(err);
  }
}

/**
 * Its OWN listener, deliberately not a hook into lib/auth.ts's store: that
 * module's job is "is someone signed in", and Firebase is happy to hold more
 * than one observer. Keeping them apart means neither file has to know the
 * other exists.
 */
onAuthStateChanged(auth, (user) => {
  cancel();
  publish({ status: 'ok' });
  if (user) schedule(PROBE_INTERVAL_MS);
});

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): SessionHealth {
  return current;
}

/**
 * Non-component subscription, for `router.tsx`'s recovery watch (#812). The
 * router is not a component and cannot use the hook below, but it is the one
 * thing that has to act when a degraded session heals: re-running the gate is
 * what turns the read-only entry back into the real app.
 */
export function subscribeSessionHealth(listener: () => void): () => void {
  return subscribe(listener);
}

/** Reactive session health for components (the shell banner). */
export function useSessionHealth(): SessionHealth {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Non-reactive read. */
export function getSessionHealth(): SessionHealth {
  return current;
}

/** Test seam: forget everything this module has observed. */
export function resetSessionHealthForTest(): void {
  cancel();
  current = { status: 'ok' };
  listeners.clear();
}
