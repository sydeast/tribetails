import { auth } from './firebase';
import { OfflineSessionError, isReadOnlySession } from './readOnlySession';

/**
 * The one way this app talks to its own `/api/*` endpoints.
 *
 * There are exactly two of them, both `onRequest` handlers in
 * `auntieos-admin/web/functions/index.js` reached through the hosting rewrites
 * in `firebase.json`: `/api/cloudinary/sign-upload` (signCloudinaryUpload) and
 * `/api/generate` (generateAuntieCopy). Everything else this admin calls is a
 * Firebase callable, and callables are not routed through here.
 *
 * WHY THIS EXISTS. Marks 3 and 12 of the 2026-08-17 admin walk were reported as
 * two unrelated defects, "cannot upload media" and "generator down". They were
 * one thing. Both endpoints returned:
 *
 *     401 {"error":"invalid_bearer_token"}
 *
 * while callables made from the same page in the same minute returned 200
 * (`recap_recent_comms` is in the walk immediately before `/api/generate`
 * fails). The token was not missing and the endpoints were not down.
 *
 * The difference is `requireStaffToken` (named `requireAdminToken` until #944
 * taught it the caretaker role), which these two endpoints and nothing
 * else go through. It calls `verifyIdToken(token, true)`, and that second
 * argument is `checkRevoked`. Callables verify without it. So a token that is
 * still inside its one-hour validity but was minted before the account's
 * `tokensValidAfterTime` passes everywhere in the app EXCEPT here. A browser
 * left open across a password change or a session revocation lands in exactly
 * that state, and the walk that produced these marks ran for 22 hours.
 *
 * WHY RETRY RATHER THAN ALWAYS FORCE-REFRESHING. `getIdToken(true)` is a
 * network round trip every time. The failure is rare and self-announcing (401,
 * with a body naming the reason), so the cheap path stays cheap and the
 * expensive path only runs when the server has already said no. One retry, not
 * a loop: if a freshly-minted token is also refused, the problem is the account
 * and not the cache, and hammering it would only bury that.
 */

/** Thrown when nobody is signed in. Separate from a rejected token on purpose. */
export class NotSignedInError extends Error {}

export interface AdminApiFetchInit {
  /** Request body, serialized by the caller's own contract. */
  body: BodyInit;
  /** Merged over `Authorization`, which this function owns and callers cannot set. */
  headers?: Record<string, string>;
  method?: string;
}

/**
 * POSTs to one of this app's own `/api/*` endpoints with the admin's ID token,
 * refreshing that token once and retrying if the endpoint rejects it.
 *
 * Returns the Response, including non-2xx ones: each caller already has its own
 * fail-loud error type and message, and swallowing the status here would take
 * that away from them. The one thing this hides is the retry, because a caller
 * has nothing useful to do with "your first token was stale".
 *
 * @param action short phrase for the sign-in error, e.g. "generating a draft"
 */
export async function adminApiFetch(
  path: string,
  action: string,
  init: AdminApiFetchInit,
): Promise<Response> {
  // #812: the second of the two seams that make the degraded entry read-only.
  // These two endpoints are the strictest thing this app calls (they verify
  // with `checkRevoked`, which is the whole subject of the header above), so a
  // session whose token could not be refreshed has no business reaching them.
  // Refused before `getIdToken` rather than after, because that call is itself
  // the refresh that just failed.
  if (isReadOnlySession()) throw new OfflineSessionError(action);
  const user = auth.currentUser;
  if (!user) throw new NotSignedInError(`Sign-in required before ${action}.`);

  const send = async (forceRefresh: boolean): Promise<Response> => {
    const token = await user.getIdToken(forceRefresh);
    return fetch(path, {
      method: init.method ?? 'POST',
      headers: { ...init.headers, Authorization: `Bearer ${token}` },
      body: init.body,
    });
  };

  const first = await send(false);
  if (first.status !== 401) return first;

  // The server rejected the cached token. Mint a new one and ask once more.
  return send(true);
}
