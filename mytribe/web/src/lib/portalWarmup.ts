import type { Query, QueryClient } from '@tanstack/react-query';
import { getAccessState, subscribeAccess } from './activeTribe';
import { getAuthState } from './auth';
import { queryClient } from './queryClient';

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
 *
 * THE OPENED SCREEN GOES FIRST (#1561). Access resolves inside the route
 * guard, before the screen's chunk has loaded and before any of its
 * `useQuery`s exist, so firing the fan-out then put twenty reads on the wire
 * ahead of the one the household came for. On a deep link to an invoice over
 * the emulator's HTTP/1.1 origin (six connections, 1-2.5 s cold starts each)
 * `getMyInvoices` reached the server 18 s after the visit. So the fan-out now
 * waits for [routeSettled]: a query with an observer (a mounted screen; the
 * warm-up's own `fetchQuery` reads have none) has appeared, and no observed
 * query has been fetching for [timing.quietMs]. The quiet window covers a
 * screen's second wave, the reads it enables from the first one's answer. A
 * screen that never settles (a hung read, a paused offline query) does not
 * cancel the warm-up: after [timing.maxWaitMs] it runs anyway. Access is
 * re-checked after the wait, so a sign-out or tribe switch during it warms
 * nothing for the tribe that left.
 */
const warmed = new Set<string>();
/** Bumped whenever access is cleared, so a run still waiting on its screen knows its session ended. */
let generation = 0;

/** How long the warm-up yields to the opened screen. Fixed outside tests. */
const DEFAULT_TIMING = { quietMs: 150, maxWaitMs: 10_000 };
let timing = { ...DEFAULT_TIMING };

/** A query some mounted component reads. The warm-up's own `fetchQuery` reads have no observers. */
const isObserved = (q: Query): boolean => q.getObserversCount() > 0;

/**
 * Resolves once a screen has mounted at least one query and none of the
 * screen's queries has been fetching for [quietMs], or after [maxWaitMs]
 * whatever the screen is doing. Never rejects.
 */
export function routeSettled(client: QueryClient, { quietMs, maxWaitMs } = timing): Promise<void> {
  return new Promise((resolve) => {
    const cache = client.getQueryCache();
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(quietTimer);
      clearTimeout(maxTimer);
      unsubscribe();
      resolve();
    };
    const check = () => {
      if (done) return;
      const mounted = cache.getAll().some(isObserved);
      if (!mounted || client.isFetching({ predicate: isObserved }) > 0) {
        clearTimeout(quietTimer);
        quietTimer = undefined;
      } else {
        quietTimer ??= setTimeout(finish, quietMs);
      }
    };
    const maxTimer = setTimeout(finish, maxWaitMs);
    const unsubscribe = cache.subscribe(check);
    check();
  });
}

let inFlight: Promise<void> | null = null;
let uninstall: (() => void) | null = null;

function onAccessChange(): void {
  const access = getAccessState();
  if (access === null) {
    // Sign-out purge, a Retry on the account-error screen, or a reconnect after
    // a failed fetch: whatever resolves next is a fresh session as far as the
    // cache is concerned, so it gets warmed again.
    warmed.clear();
    generation += 1;
    return;
  }
  if (access.error !== null || access.activeKinfolkId === null) return;
  const auth = getAuthState();
  if (auth.status !== 'signedIn') return;
  const tag = `${auth.user.uid}/${access.activeKinfolkId}`;
  if (warmed.has(tag)) return;
  warmed.add(tag);
  const kinfolkId = access.activeKinfolkId;
  const uid = auth.user.uid;
  const started = generation;
  // The chunk loads while the screen does; the reads wait for the screen.
  const run = Promise.all([import('./portalWarmupReads'), routeSettled(queryClient)])
    .then(([reads]) => {
      const now = getAccessState();
      const who = getAuthState();
      const sameSession = started === generation && who.status === 'signedIn' && who.user.uid === uid;
      if (!sameSession || now?.activeKinfolkId !== kinfolkId) return;
      return reads.warmPortalScreens(kinfolkId);
    })
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

/** Test seam: forget which tribes were warmed, and set how long the warm-up yields. */
export function resetPortalWarmupForTest(t: Partial<typeof DEFAULT_TIMING> = {}): void {
  timing = { ...DEFAULT_TIMING, ...t };
  generation += 1;
  warmed.clear();
  inFlight = null;
  uninstall?.();
}
