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
  /^http:\/\/localhost(:\d+)?$/,
];
