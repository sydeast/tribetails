import { getAccessState, subscribeAccess } from './activeTribe';
import { getAuthState } from './auth';
/**
 * #1282: when to warm the portal screens. What gets warmed, and why, is in
 * `lib/portalWarmupReads.ts`, which this module imports on demand so the api
 * modules it pulls in stay out of the entry chunk (O-26).
 *
 * ONCE PER SESSION PER TRIBE. The access store notifies on every change and
 * the route guards resolve access on every navigation, so the fan-out is keyed
 * by `uid/kinfolkId` and runs once for each. The set empties when access is
 * cleared (sign-out purges the query cache in the same breath, and an
 * operator's tribe switch resolves a new id), so the next resolution warms
 * again. Installed from `main.tsx`, not from a route guard or a component,
 * because an active tribe is a fact about the session that arrives without a
 * navigation, and because the guards run inside thirty test files that mock
 * only what their own screen reads. Nothing here fires before access resolves
 * with an active tribe, which only happens behind a portal route guard, so the
 * sign-in, invite and public routes never warm anything.
 */
const warmed = new Set<string>();
let inFlight: Promise<void> | null = null;
let uninstall: (() => void) | null = null;

function onAccessChange(): void {
  const access = getAccessState();
  if (access === null) {
    // Sign-out purge, a Retry on the account-error screen, or a reconnect after
    // a failed fetch: whatever resolves next is a fresh session as far as the
    // cache is concerned, so it gets warmed again.
    warmed.clear();
    return;
  }
  if (access.error !== null || access.activeKinfolkId === null) return;
  const auth = getAuthState();
  if (auth.status !== 'signedIn') return;
  const tag = `${auth.user.uid}/${access.activeKinfolkId}`;
  if (warmed.has(tag)) return;
  warmed.add(tag);
  const kinfolkId = access.activeKinfolkId;
  const run = import('./portalWarmupReads')
    .then((reads) => reads.warmPortalScreens(kinfolkId))
    .catch(() => undefined) // a chunk that will not load warms nothing; the screens still work
    .finally(() => {
      if (inFlight === run) inFlight = null;
    });
  inFlight = run;
}

/**
 * Starts listening for a resolved active tribe. Idempotent: a second call
 * returns the same teardown. Called once from `main.tsx`.
 */
export function installPortalWarmup(): () => void {
  if (uninstall !== null) return uninstall;
  const unsubscribe = subscribeAccess(onAccessChange);
  uninstall = () => {
    unsubscribe();
    uninstall = null;
  };
  onAccessChange();
  return uninstall;
}

/** Test seam: the fan-out currently running, if any. */
export function portalWarmupInFlight(): Promise<void> | null {
  return inFlight;
}

/** Test seam: forget which tribes were warmed. */
export function resetPortalWarmupForTest(): void {
  warmed.clear();
  inFlight = null;
  uninstall?.();
}
