import crypto from 'crypto';

/**
 * The "this browser already typed the passcode" token for a passcode-protected
 * share (#1280).
 *
 * The `/share/<token>` page used to take the passcode as `?passcode=` on a GET,
 * so it landed in browser history, hosting logs and every link the family
 * copied. The passcode now arrives once, in a POST body, and the page answers
 * with this token in an HttpOnly cookie. Every later request proves the unlock
 * with the cookie instead of the passcode.
 *
 * WHY THE HMAC KEY IS THE PASSCODE HASH, NOT A NEW SECRET. The argon2 hash in
 * `sharedKinTales/{id}.passcodeHash` is server-only (it is never copied into
 * `scrubbedPayload`, the only part a reader ever receives), so it is already a
 * per-share secret. Keying on it means:
 *  - no new Secret Manager entry the operator has to create before this works;
 *  - a token for share A can never unlock share B (different key, and the
 *    share id is in the signed message too);
 *  - changing or clearing the passcode invalidates every outstanding token.
 *
 * WHAT IT DOES NOT CHANGE. Guessing the passcode still costs one argon2 verify
 * per attempt, the only brute-force brake the page had before. A forged token
 * is refused by an HMAC compare, which is cheaper than argon2 but useless to an
 * attacker who does not hold the hash.
 */

/** How long one unlock lasts. Short on purpose: the cookie is a session for reading one tale. */
export const SHARE_UNLOCK_TTL_MS = 60 * 60 * 1000;

/**
 * Firebase Hosting strips every cookie except `__session` before it forwards a
 * request to a function, so this is the only name that reaches the handler in
 * production. The cookie's `Path` is the share's own path, so two shares never
 * share one.
 */
export const SHARE_UNLOCK_COOKIE = '__session';

const VERSION = 'v1';

function sign(shareId: string, expMs: number, passcodeHash: string): string {
  return crypto.createHmac('sha256', passcodeHash).update(`${VERSION}.${shareId}.${expMs}`).digest('base64url');
}

/** A fresh token for `shareId`, valid for `SHARE_UNLOCK_TTL_MS` from `nowMs`. */
export function mintShareUnlock(shareId: string, passcodeHash: string, nowMs: number = Date.now()): string {
  const expMs = nowMs + SHARE_UNLOCK_TTL_MS;
  return `${VERSION}.${expMs}.${sign(shareId, expMs, passcodeHash)}`;
}

/** True only for an unexpired token minted for this share under this passcode hash. */
export function verifyShareUnlock(
  token: string | undefined,
  shareId: string,
  passcodeHash: string,
  nowMs: number = Date.now(),
): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return false;
  const expMs = Number(parts[1]);
  if (!Number.isSafeInteger(expMs) || expMs <= nowMs) return false;
  const expected = Buffer.from(sign(shareId, expMs, passcodeHash));
  const supplied = Buffer.from(parts[2]);
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

/**
 * Every `__session` value in a raw `Cookie` header. A browser can hold more than
 * one cookie of the same name at different paths and sends all of them, so the
 * caller tries each rather than trusting whichever came first.
 */
export function readUnlockCookies(cookieHeader: string | undefined): string[] {
  if (!cookieHeader) return [];
  const out: string[] = [];
  for (const pair of cookieHeader.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() !== SHARE_UNLOCK_COOKIE) continue;
    const value = pair.slice(eq + 1).trim();
    if (value) out.push(value);
  }
  return out;
}

/** The `Set-Cookie` value that stores `token` for one share path. */
export function unlockSetCookie(token: string, path: string): string {
  return [
    `${SHARE_UNLOCK_COOKIE}=${token}`,
    `Path=${path}`,
    `Max-Age=${Math.floor(SHARE_UNLOCK_TTL_MS / 1000)}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}
