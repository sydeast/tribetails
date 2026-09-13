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

/** The precached entry every in-app route is answered with when offline. */
export const NAVIGATION_FALLBACK_URL = '/index.html';

/**
 * Navigations the fallback must NOT answer.
 *
 * The admin is a single-page app and firebase.json rewrites `**` to
 * /index.html, so for an ORDINARY route serving the precached shell offline is
 * exactly what the server does online. It is not a compromise, and it is not a
 * swallowed 404: the router owns "no such route", and it cannot own it if the
 * navigation never reaches the router.
 *
 * The exceptions are the paths hosting does NOT rewrite.
 *
 * /api/** is `signCloudinaryUpload` and `generateAuntieCopy`, two functions
 * wearing this site's own hostname. They are already NetworkOnly above, and
 * denied here as well so the rule holds whichever route matches first.
 *
 * The second pattern is anything that looks like a file request (a last path
 * segment carrying an extension). Those are assets, and a missing asset should
 * 404 rather than come back as HTML no image decoder, stylesheet parser or
 * script loader can read.
 */
export const NAVIGATION_FALLBACK_DENYLIST: RegExp[] = [/^\/api\//, /\/[^/?]+\.[^/.?]+$/];

/**
 * Whether the navigation fallback is denied for [url]. Mirrors how Workbox's
 * NavigationRoute applies a denylist: against the path plus the query.
 */
export function isDeniedNavigation(url: URL): boolean {
  const pathAndSearch = url.pathname + url.search;
  return NAVIGATION_FALLBACK_DENYLIST.some((pattern) => pattern.test(pathAndSearch));
}

/**
 * Try the network strategy; serve the precached shell when it comes back with
 * nothing at all.
 *
 * THE FALLBACK IS NOT A REPLACEMENT FOR TRYING. Online this is still the
 * NetworkFirst above, with its own two second deadline and its own per-URL page
 * cache, so an operator on a working connection gets fresh HTML. What this adds
 * is the case NetworkFirst alone cannot answer: a navigation to a route this
 * device has never opened, which has no entry in the page cache to fall back
 * to. That is the field case exactly. The operator reaches for mobile web
 * BECAUSE Android already failed on the job, and the way they get to one
 * booking or session is a deep link, not the home screen.
 *
 * ONLY A TOTAL FAILURE REACHES THE SHELL. A 404 or a 500 is a Response, so
 * NetworkFirst resolves with it and the fallback never runs. A server saying
 * "no" is an answer, and it has to reach the browser unaltered. The catch is
 * for the case where there is no answer to pass on.
 *
 * Generic rather than typed against Workbox, so this module stays free of
 * worker-only types and a spec can exercise the real branch with fakes.
 */
export function navigationHandler<Options, Result>(handlers: {
  fromNetwork: (options: Options) => Promise<Result>;
  fromPrecachedShell: (options: Options) => Promise<Result>;
}): (options: Options) => Promise<Result> {
  return async (options: Options) => {
    try {
      return await handlers.fromNetwork(options);
    } catch {
      return await handlers.fromPrecachedShell(options);
    }
  };
}
