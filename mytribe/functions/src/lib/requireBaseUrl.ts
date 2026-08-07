import { HttpsError } from 'firebase-functions/v2/https';

/**
 * Reads an env var that is meant to be the base URL of a user-facing link
 * (a share link, an invite claim link, an operator review link, ...) and
 * refuses to proceed if it is not usably configured.
 *
 * Generalized out of `createShareLink.ts`'s `SHARE_LINK_BASE_URL` guard
 * (PR26): every one of these vars was interpolated straight into a template
 * literal with no check, so an unset or blank var mints a link reading
 * `undefined/<token>` — after the caller's writes have already happened.
 * There is no safe default host to fall back to: guessing one would mint a
 * link pointing at a host that may not serve it, which is the silent
 * degradation the repo's fail-loud rule forbids. A misconfigured deploy is
 * not the caller's fault, hence `failed-precondition` rather than
 * `invalid-argument`.
 *
 * A trailing slash is an operator typo in an env var, not a caller input,
 * and stripping it still produces a correct URL — so this normalizes rather
 * than rejects, per the fail-loud priority order (works correctly > fails
 * visibly > silent degradation). Normalization runs BEFORE the emptiness
 * check: a value of `"/"` or `"///"` is truthy but strips down to `""`, and
 * must be treated the same as unset rather than slipping through to build a
 * broken relative URL. (PR26 shipped this ordering wrong on its first pass.)
 *
 * Callers must use the returned value, not re-read `process.env` — the
 * normalization only takes effect if the caller interpolates what this
 * function returns.
 *
 * Trimmed BEFORE the trailing-slash strip: a value of `" "` (whitespace
 * only, e.g. a stray space pasted into the deploy config) is truthy and
 * survives the trailing-slash regex untouched, so without the trim it would
 * pass the emptiness check and mint a link starting with a literal space.
 * Inherited from PR26's inline guard, which had the same gap; closed here
 * since this is now the one place every one of these vars gets read.
 */
export function requireBaseUrl(varName: string): string {
  const value = (process.env[varName] ?? '').trim().replace(/\/+$/, '');
  if (!value) {
    throw new HttpsError('failed-precondition', `${varName} is not configured`);
  }
  return value;
}
