import { HttpsError } from 'firebase-functions/v2/https';

/**
 * Shared CORS allowlist for all callable + HTTP functions.
 *
 * Replaces `cors: true` (wildcard) which let any origin drive a victim's
 * browser-session token against our callables. The allowlist is narrow enough
 * to reject random origins yet permissive enough for local dev across both
 * AuntieOS admin (auntie.tribetails.com) and the kinfolk portal
 * (kinfolk.tribetails.com).
 *
 * Per-callable overrides remain possible by passing a different array to
 * `onCall({ cors: [...] }, …)`, use a narrower list for endpoints that only
 * one surface should be able to call.
 */
export const TRIBETAILS_CORS: Array<string | RegExp> = [
  'https://auntie.tribetails.com',
  'https://kinfolk.tribetails.com',
  'https://tribetails.com',
  // Firebase Hosting default domains for the auntieos-ttpc site. The custom
  // domain (auntie.tribetails.com) is the primary, but the .web.app/.firebaseapp.com
  // URLs serve the SAME app and must be able to call callables too — otherwise the
  // browser blocks every callable response (no ACAO header) with a CORS "Failed to
  // fetch" that the client surfaces as a generic "internal" (verified 2026-06-08).
  'https://auntieos-ttpc.web.app',
  'https://auntieos-ttpc.firebaseapp.com',
  // React portal rebuild beta (web/ dist) — remove after cutover to
  // kinfolk.tribetails.com or keep for staging.
  'https://mytribe-kinfolk-beta.web.app',
  // The portal site's own default domains. Same app as kinfolk.tribetails.com.
  'https://kinfolk-portal.web.app',
  'https://kinfolk-portal.firebaseapp.com',
  // Hosting preview channels (main channel, PR previews) of the two sites this
  // project owns: `<site>--<channelId>-<hash>.web.app`. Only project deployers
  // can create a channel on these sites. Fully anchored, so a lookalike such
  // as `kinfolk-portal--x.web.app.evil.com` or `evilkinfolk-portal--x.web.app`
  // does not match. Without this the browser drops every callable response on
  // those origins (no ACAO header) and the portal shows "trouble loading".
  /^https:\/\/(auntieos-ttpc|kinfolk-portal)--[a-z0-9-]+\.web\.app$/,
  /^http:\/\/localhost(:\d+)?$/,
];
/**
 * Same test the `cors` package applies to an array option: a string must equal
 * the Origin exactly, a RegExp must match it. Exported for tests.
 */
export function isAllowedOrigin(
  origin: string,
  allow: Array<string | RegExp> = TRIBETAILS_CORS,
): boolean {
  return allow.some((entry) => (typeof entry === 'string' ? entry === origin : entry.test(origin)));
}

/*
 * Lives here rather than in a module of its own so the entrypoint's eager
 * import graph does not grow (test/coldStartImportGraph.test.ts): both
 * callables that use it already import this file.
 */
/**
 * WHERE STRIPE MAY SEND A HOUSEHOLD BACK TO (#2366).
 *
 * `payInvoice` and `createBillingSetupSession` take their return addresses from
 * the caller and hand them to Stripe as `success_url` and `cancel_url`. Stripe
 * redirects to whatever it is given, from a page that carries this business's
 * name and the household's own bill. Left unchecked, any signed-in caller could
 * mint a real checkout page that ends on a site this business does not own.
 *
 * So the address must be on one of the MyTribe web portal's own origins, and
 * nothing else. This is narrower than `TRIBETAILS_CORS` above on purpose: the admin
 * site and the apex domain can call callables, but neither is a page a
 * household is sent back to after paying.
 *
 * ORIGIN ONLY, NOT PATH. A MyTribe Android build from before #2366 still sends
 * `/portal/payment-success`, and refusing it would stop that household paying
 * at all. The path is the client's business; the origin is the safety line.
 *
 * Three paths are in use by installed MyTribe apps, and all three must keep
 * passing (#2401): `/portal/payment-success` (before #2366), `/invoices/{id}`
 * (#2366, and what the web portal itself sends), and `/app/invoices/{id}`
 * (#2401, an address on this origin that the app claims, so the phone opens
 * the app). The app's own `mytribe://` link is NOT a return address and is
 * refused like any other scheme: Stripe is only ever given https on the portal.
 *
 * Compared on the parsed `URL.origin`, never a prefix of the raw string, so
 * `https://kinfolk.tribetails.com.evil.example` and
 * `https://kinfolk.tribetails.com@evil.example` are both refused. A URL with a
 * user or password part is refused outright.
 */
export const PORTAL_RETURN_ORIGINS: readonly string[] = [
  'https://kinfolk.tribetails.com',
  // The portal site's default domains: the same app as the custom domain.
  'https://kinfolk-portal.web.app',
  'https://kinfolk-portal.firebaseapp.com',
  // The React portal beta site (see TRIBETAILS_CORS above).
  'https://mytribe-kinfolk-beta.web.app',
];

/**
 * Hosting preview channels of the portal site (the main channel and PR
 * previews): `kinfolk-portal--<channel>.web.app`. Only project deployers can
 * create a channel on this site. Fully anchored.
 */
const PORTAL_PREVIEW_ORIGIN = /^https:\/\/kinfolk-portal--[a-z0-9-]+\.web\.app$/;

/**
 * The local portal under the Functions emulator only: the e2e suites serve it
 * from `http://127.0.0.1:<port>`, and a developer from `http://localhost:<port>`.
 * A deployed function never sends a household to a loopback address.
 */
const LOOPBACK_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

export function inFunctionsEmulator(): boolean {
  return process.env.FUNCTIONS_EMULATOR === 'true';
}

/** True when `raw` is an absolute URL on one of the portal's own origins. */
export function isPortalReturnUrl(raw: string, opts: { emulator?: boolean } = {}): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '') return false;
  const origin = url.origin;
  if (PORTAL_RETURN_ORIGINS.includes(origin)) return true;
  if (PORTAL_PREVIEW_ORIGIN.test(origin)) return true;
  const emulator = opts.emulator ?? inFunctionsEmulator();
  return emulator && LOOPBACK_ORIGIN.test(origin);
}

/** The code a refused return address carries, for tests and logs. */
export const RETURN_URL_REFUSED_CODE = 'return_url_refused';

/**
 * Refuses the call unless both return addresses are portal addresses. Thrown
 * before anything is read or written, so a refused call changes nothing.
 */
export function requirePortalReturnUrls(urls: { successUrl: string; cancelUrl: string }): void {
  if (isPortalReturnUrl(urls.successUrl) && isPortalReturnUrl(urls.cancelUrl)) return;
  throw new HttpsError('invalid-argument', 'This payment page cannot be opened from here.', {
    code: RETURN_URL_REFUSED_CODE,
  });
}
