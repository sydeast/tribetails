/**
 * #2259: where a tapped push lands, as an address on THIS origin.
 *
 * `route` is `data.route` off the push: an in-app path the server builds from
 * what the notice is about (`/schedule/<visit>`, `/kintales?tale=<id>`,
 * `/invoices/<id>`, `/kin/<id>`...), or the notifications list. It is not
 * settable per recipient, but a push is still input from outside the page, so
 * nothing in it may leave the portal: an absolute address, `//host`,
 * `/\host`, `javascript:` and `data:` all resolve to another origin (or to
 * none) and open Home instead.
 *
 * No route at all opens Home, which is what a push carried before it had one.
 *
 * Pure, and free of the worker's globals, so `sw.ts` and its spec share it.
 * The signed-out case needs nothing here: the route guard carries the path
 * through sign-in (`lib/signInRedirect.ts`, #1384).
 */
export const PUSH_FALLBACK_PATH = '/home';

export function pushClickUrl(route: unknown, origin: string): string {
  const fallback = origin + PUSH_FALLBACK_PATH;
  if (typeof route !== 'string' || route.trim() === '') return fallback;
  let requested: URL;
  try {
    requested = new URL(route, origin);
  } catch {
    return fallback;
  }
  return requested.origin === origin ? requested.href : fallback;
}
