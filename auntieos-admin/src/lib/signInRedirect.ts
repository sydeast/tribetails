/**
 * Carrying an operator's intended location through sign-in (#1384).
 *
 * A signed-out operator who opens an email deep link (`/invites/<id>`,
 * `/directory/<id>?section=unapplied-payments&paymentId=...`) is bounced to
 * /signin by the route guard. The guard puts the location it turned them away
 * from in a `redirect` search param, and the sign-in screen lands there instead
 * of on Home.
 *
 * The param arrives from the address bar, so it is untrusted input: anything
 * that could leave this origin is refused, and the caller falls back to /home.
 */
/** Where sign-in lands when no usable `redirect` was carried. */
export const DEFAULT_SIGN_IN_LANDING = '/home';
/**
 * The value if it is a same-origin, in-app path (with its search and hash),
 * otherwise null.
 *
 * Refused: non-strings; anything not starting with a single `/` (absolute URLs
 * such as `https://evil.example`, `javascript:` and `data:` URIs, protocol-relative
 * `//evil.example`); `/\` (browsers read a backslash as a slash, so `/\evil.example`
 * is protocol-relative in practice); control characters and whitespace; and the
 * sign-in screen itself, which would loop.
 */
export function safeRedirectPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f\\]/.test(raw.split('?')[0] ?? '')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, 'http://app.invalid');
  } catch {
    return null;
  }
  if (url.origin !== 'http://app.invalid') return null;
  if (url.pathname === '/signin' || url.pathname.startsWith('/signin/')) return null;
  return raw;
}
/** The `search` for a /signin redirect from `location`; empty when there is nothing worth carrying. */
export function signInSearchFor(location: {
  pathname: string;
  searchStr?: string;
  hash?: string;
}): { redirect?: string } {
  const path =
    location.pathname + (location.searchStr ?? '') + (location.hash ? `#${location.hash.replace(/^#/, '')}` : '');
  const safe = safeRedirectPath(path);
  return safe === null || safe === '/' ? {} : { redirect: safe };
}
/** The `validateSearch` for /signin: keeps `redirect` only when it is a safe in-app path. */
export function signInSearch(search: Record<string, unknown>): { redirect?: string } {
  const safe = safeRedirectPath(search['redirect']);
  return safe === null ? {} : { redirect: safe };
}
