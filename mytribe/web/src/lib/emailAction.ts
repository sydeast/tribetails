/**
 * Parses a Firebase email action link (#892).
 *
 * The project's email action URL, Identity Toolkit's `callbackUri`, is
 * https://kinfolk.tribetails.com/account/secure-reset (read 2026-09-14 from
 * `admin/v2/projects/auntieos-ttpc/config`). It is ONE URL for the whole
 * project, so every Firebase auth email opens this page, whoever sent it:
 *
 *   - native resets (admin clients, and portal clients before #905):
 *     `?mode=resetPassword&oobCode=..&apiKey=..&lang=en`, plus `continueUrl`
 *     when the sender passed ActionCodeSettings
 *   - the `requestPasswordReset` email (portal web, Android and desktop since
 *     #905): the same, with `continueUrl` set by the server to the admin or
 *     portal sign-in. Links it sent before #905 (and any still in an inbox)
 *     continue to `https://kinfolk.tribetails.com/account/secure-reset?email=..`
 *   - `verifyEmail`, `verifyAndChangeEmail` and `recoverEmail` links
 *
 * No Firebase link carries an `email` param, which is why the old parser (that
 * required one) showed "This link is incomplete" to nearly everyone. The account
 * always comes from the verified code, never from the URL.
 */

export type EmailActionMode =
  | 'resetPassword'
  | 'verifyEmail'
  | 'verifyAndChangeEmail'
  | 'recoverEmail'
  | 'unsupported';

/** Who the link was sent for, read from where it continues to. Drives copy only. */
export type EmailActionAudience = 'staff' | 'kinfolk' | 'unknown';

export interface EmailActionLink {
  mode: EmailActionMode;
  /** The mode exactly as the link spelled it (or `resetPassword` when absent). */
  rawMode: string;
  oobCode: string;
  /** An allowlisted place to send the reader when they are done, or null. */
  continueUrl: string | null;
  audience: EmailActionAudience;
}

const STAFF_HOST = 'auntie.tribetails.com';
const PORTAL_HOST = 'kinfolk.tribetails.com';
const ACTION_PATHS = ['/account/secure-reset', '/account/action'];
const HANDLED_MODES: readonly EmailActionMode[] = [
  'resetPassword',
  'verifyEmail',
  'verifyAndChangeEmail',
  'recoverEmail',
];

/**
 * The continue target, if it is somewhere this page may send people.
 *
 * Allowed: https on the admin site or the portal, or this page's own origin
 * (local dev, the emulator harness, a preview channel). Anything else is
 * dropped so the page can never be used as an open redirect. A target that is
 * this action page itself (the `requestPasswordReset` shape) becomes that
 * host's sign-in, since sending someone back here would be a loop.
 */
export function safeContinueUrl(raw: string | null | undefined, origin: string): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const knownHost = url.protocol === 'https:' && (url.hostname === STAFF_HOST || url.hostname === PORTAL_HOST);
  if (!knownHost && url.origin !== origin) return null;
  if (ACTION_PATHS.some((p) => url.pathname === p || url.pathname.startsWith(`${p}/`))) {
    return `${url.origin}/signin`;
  }
  return url.href;
}

export function parseEmailActionLink(search: string, origin: string): EmailActionLink | null {
  const query = new URLSearchParams(search);
  const oobCode = query.get('oobCode');
  if (!oobCode) return null;

  const rawMode = query.get('mode') || 'resetPassword';
  const mode = (HANDLED_MODES as readonly string[]).includes(rawMode)
    ? (rawMode as EmailActionMode)
    : 'unsupported';
  const continueUrl = safeContinueUrl(query.get('continueUrl'), origin);

  let audience: EmailActionAudience = 'unknown';
  if (continueUrl) {
    const host = new URL(continueUrl).hostname;
    if (host === STAFF_HOST) audience = 'staff';
    else if (host === PORTAL_HOST) audience = 'kinfolk';
  }

  return { mode, rawMode, oobCode, continueUrl, audience };
}
