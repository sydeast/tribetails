/**
 * The service worker's routing policy, in a module of its own so it can be
 * tested and so the decisions below are written down once.
 *
 * IT IS SEPARATE FROM src/sw.ts FOR A BUILD REASON, not a stylistic one.
 * `sw.ts` is compiled as a worker (tsconfig.sw.json, `WebWorker` lib) and is
 * excluded from the app's own `tsc --noEmit`. A spec that imported `./sw`
 * would drag it back into the app's program under the `DOM` lib, where the two
 * global scopes collide and the build fails. Everything here is plain
 * DOM-compatible types, so the app, the worker and vitest can all read it.
 *
 * DELIBERATELY THE SAME SHAPE AS mytribe/web/src/lib/swPolicy.ts, which
 * established it. The two are separate workspaces with separate caches and no
 * shared package worth creating for sixty lines, but the rules they encode are
 * the same rules, and a difference between them should be a decision somebody
 * made rather than a drift nobody noticed.
 */

/**
 * How long a navigation waits for the network before the cached app shell is
 * served instead.
 *
 * TWO SECONDS. Operator ruling 2026-09-12: mobile web is the FIELD FALLBACK,
 * used when the Android app will not load on the job, so the case that matters
 * is a weak-but-alive signal rather than a clean one. A longer deadline is a
 * longer blank screen before the shell the worker already has appears.
 *
 * NetworkFirst, NOT StaleWhileRevalidate. The portal measured what
 * stale-while-revalidate costs and wrote it down: it kept serving old bundles
 * one load behind every release. `registerType: 'autoUpdate'` does not rescue
 * that, because a stale-while-revalidate navigation is answered from the cache
 * BEFORE the revalidation lands, so the first visit after a deploy still paints
 * the previous shell. For an admin whose operator is looking at live bookings,
 * a screen that is one release stale is worse than two seconds of waiting.
 */
export const NAVIGATION_NETWORK_TIMEOUT_SECONDS = 2;

/** Cache that holds navigation responses (the app shell). */
export const NAVIGATION_CACHE_NAME = 'auntieos-pages';

/** True for a top-level page load, which is what the shell cache answers. */
export function isNavigationRequest(request: Request): boolean {
  return request.mode === 'navigate';
}

/**
 * Hosts whose responses must NEVER be cached: Cloud Functions, Firestore and
 * Auth. A stale answer here is not a slow screen, it is wrong data or a refused
 * sign-in, and caching them blocks the auth SDK outright. No admin screen may
 * ever show a cached booking, invoice or session as though it were current.
 */
export function isNeverCachedHost(url: URL, origin: string): boolean {
  return (
    url.hostname.endsWith('cloudfunctions.net') ||
    url.hostname.endsWith('googleapis.com') ||
    url.hostname.endsWith('firebaseio.com') ||
    // Second-generation functions answer on Cloud Run hostnames too.
    url.hostname.endsWith('run.app') ||
    // The admin reaches two of its own functions through the /api/* rewrites in
    // firebase.json. Those are SAME-ORIGIN, so without this clause they would
    // fall to the navigation rule, which caches. `origin` is passed in rather
    // than read from `self` so this stays a plain function a spec can call.
    (url.origin === origin && url.pathname.startsWith('/api/'))
  );
}
