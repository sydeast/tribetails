/**
 * The service worker's routing policy, in a module of its own so it can be
 * tested and so the two decisions below are written down once.
 *
 * IT IS SEPARATE FROM src/sw.ts FOR A BUILD REASON, not a stylistic one.
 * `sw.ts` is compiled as a worker (tsconfig.sw.json, `WebWorker` lib) and is
 * excluded from the app's own `tsc --noEmit`. A spec that imported `./sw`
 * would drag it back into the app's program under the `DOM` lib, where the
 * two global scopes collide and the build fails. Everything here is plain
 * DOM-compatible types, so the app, the worker and vitest can all read it.
 */

/**
 * How long a navigation waits for the network before the cached app shell is
 * served instead.
 *
 * TWO SECONDS, DOWN FROM FIVE (operator ruling 2026-09-12). Mobile web is the
 * FIELD FALLBACK, used when the Android app will not load on the job, and for
 * iOS households it is the only client there is. On a weak-but-alive signal
 * the old five seconds was five seconds of blank screen before the shell the
 * worker already had appeared, which is the exact case the ruling is about.
 *
 * STILL NetworkFirst, NOT StaleWhileRevalidate, and that is deliberate.
 * StaleWhileRevalidate would paint instantly, and this repo has already
 * measured what it costs: it kept serving old bundles one load behind every
 * release (the gotcha recorded in vite.config.ts). `registerType: 'autoUpdate'`
 * does not rescue that. The new worker does take control as soon as it
 * installs, but a stale-while-revalidate navigation is answered FROM THE CACHE
 * before the revalidation lands, so the first visit after a deploy still
 * paints the previous shell and only the second one is current. A release that
 * reaches a household one visit late is worse than two seconds of waiting on a
 * bad signal.
 *
 * TWO RATHER THAN ONE OR ZERO. A healthy connection answers a navigation well
 * inside two seconds, so an ordinary load never reaches this deadline and
 * still gets fresh HTML. Cutting it shorter starts serving the cache to people
 * whose network was slow but working, which is the stale-shell problem again
 * wearing a different hat.
 */
export const NAVIGATION_NETWORK_TIMEOUT_SECONDS = 2;

/** Cache that holds navigation responses (the app shell). */
export const NAVIGATION_CACHE_NAME = 'mytribe-pages';

/** True for a top-level page load, which is what the shell cache answers. */
export function isNavigationRequest(request: Request): boolean {
  return request.mode === 'navigate';
}

/**
 * Hosts whose responses must NEVER be cached: Cloud Functions, Firestore and
 * Auth. A stale answer here is not a slow screen, it is wrong data or a
 * refused sign-in, and caching them blocks the auth SDK outright (the same
 * rule the Kotlin app's worker carried).
 */
export function isNeverCachedHost(url: URL): boolean {
  return (
    url.hostname.endsWith('cloudfunctions.net') ||
    url.hostname.endsWith('googleapis.com') ||
    url.hostname.endsWith('firebaseio.com')
  );
}
