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

/** The precached entry every in-app route is answered with when offline. */
export const NAVIGATION_FALLBACK_URL = '/index.html';

/**
 * Navigations the fallback must NOT answer.
 *
 * The portal is a single-page app and firebase.json rewrites `**` to
 * /index.html, so for an ORDINARY route serving the precached shell offline is
 * exactly what the server does online. It is not a compromise, and it is not a
 * swallowed 404: the router owns "no such route", and it cannot own it if the
 * navigation never reaches the router.
 *
 * The exceptions are the paths hosting does NOT rewrite.
 *
 * /share/** is `getSharedKinTalePage`, a Cloud Function returning its own
 * server-rendered HTML. Handing the app shell to a kinfolk's friend opening a
 * shared KinTale link would replace a real page with an app they cannot sign
 * in to. Denied here, so it falls through to the network and fails honestly
 * when there is none.
 *
 * The second pattern is anything that looks like a file request (a last path
 * segment carrying an extension). Those are assets, and a missing asset should
 * 404 rather than come back as HTML no image decoder, stylesheet parser or
 * script loader can read.
 */
export const NAVIGATION_FALLBACK_DENYLIST: RegExp[] = [/^\/share\//, /\/[^/?]+\.[^/.?]+$/];

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
 * NetworkFirst above, with its own two second deadline and its own per-URL
 * page cache, so a household on a working connection gets fresh HTML. What
 * this adds is the case NetworkFirst alone cannot answer: a navigation to a
 * route this device has never opened, which has no entry in the page cache to
 * fall back to. That is the field case exactly, because the way anyone reaches
 * a specific visit is a link to it, not the home screen.
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
