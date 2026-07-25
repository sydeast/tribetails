import { onCall, onRequest, CallableRequest, HttpsError, Request } from 'firebase-functions/v2/https';
import type { Response } from 'express';
import { randomBytes } from 'node:crypto';
import { db } from '../../lib/firestoreAdmin';
import { initSentry } from '../../lib/sentry';
import { logEvent } from '../../lib/logger';
import { wrapAdminCallable } from '../../lib/wrapAdminCallable';
import { wrapHttp } from '../../lib/wrapHttp';
import { TRIBETAILS_CORS } from '../../lib/cors';
import { writeAuditEntry } from '../../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../../lib/auditEvents';
import {
  GOOGLE_OAUTH_SECRETS,
  GOOGLE_OAUTH_REDIRECT_URI,
  buildConsentUrl,
  calendarClientForRefreshToken,
  exchangeCodeForRefreshToken,
  readGoogleOAuthConfig,
} from '../../lib/googleOAuth';
import {
  GOOGLE_CALENDAR_DOC_PATH,
  OAUTH_STATE_COLLECTION,
  OAUTH_STATE_TTL_MS,
  connectStamp,
} from '../../lib/googleCalendarConnection';

/**
 * Connecting a Google account that AuntieOS may WRITE visits to (Task 7.2).
 *
 * Two halves of one flow, in one file because they are meaningless apart: the
 * admin-gated callable that STARTS a flow, and the public HTTP endpoint Google
 * REDIRECTS back to.
 *
 * THE START IS A CALLABLE, NOT AN HTTP ENDPOINT, which is a deliberate
 * departure from the plan's sketch. An HTTP start endpoint is reached by a
 * browser navigation, which carries no ID token, so it could not tell an Auntie
 * from a stranger and would let anyone open a consent screen against our OAuth
 * client. A callable is authenticated by `wrapAdminCallable` before it mints
 * anything, and both clients want the same thing from it anyway: a URL to open,
 * in a popup on web and in a Custom Tab on android.
 *
 * THE CALLBACK CANNOT BE AUTHENTICATED, because Google performs it. What stands
 * in for authentication is the one-time `state` nonce: minted here against the
 * admin's uid, stored server-side in a collection no client can read, valid for
 * fifteen minutes, and DELETED the moment it is spent. A callback carrying an
 * unknown, expired or already-spent state is refused before any code is
 * exchanged, which is what stops a stranger who guesses the callback URL from
 * attaching THEIR Google account to this business.
 */

export interface StartConnectResult {
  /** The Google consent URL the client opens. */
  authUrl: string;
  /** When the minted state stops being accepted, ISO-8601. */
  expiresAt: string;
  /** Echoed so the setup copy can name the exact URI the OAuth client must register. */
  redirectUri: string;
}

export async function startGoogleCalendarConnectHandler(
  req: CallableRequest<unknown>,
): Promise<StartConnectResult> {
  initSentry();
  const uid = req.auth?.uid;
  // defense-in-depth; wrapAdminCallable already enforces admin.
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  // Reads GOOGLE_OAUTH_CLIENT_ID. Rejects with `google_oauth_not_configured`
  // and the exact `firebase functions:secrets:set` command when it is unset, so
  // an operator who has not finished setup is told what is missing rather than
  // being handed a Google page that fails with "invalid_client".
  const { clientId } = readGoogleOAuthConfig();

  // 32 random bytes. A nonce is only useful to an attacker inside its 15 minute
  // life, and this length prices guessing one out of reach.
  //
  // An ABANDONED flow leaves its nonce behind: nothing sweeps expired states,
  // because a redeemed one is deleted on the spot and an abandoned one is a
  // single tiny document per abandoned attempt. `redeemOAuthState` checks the
  // expiry itself, so a stale nonce is inert, not dangerous. If that litter ever
  // matters, a Firestore TTL policy on `expiresAt` is the fix, not a sweep query
  // on every connect.
  const state = randomBytes(32).toString('hex');
  const now = Date.now();
  const expiresAt = new Date(now + OAUTH_STATE_TTL_MS).toISOString();
  await db().collection(OAUTH_STATE_COLLECTION).doc(state).set({
    uid,
    createdAt: new Date(now).toISOString(),
    expiresAt,
  });

  logEvent({
    severity: 'info',
    function: 'startGoogleCalendarConnect',
    event: 'gcal.oauth.start',
    uid,
  });

  return { authUrl: buildConsentUrl(clientId, state), expiresAt, redirectUri: GOOGLE_OAUTH_REDIRECT_URI };
}

/** What a spent, expired or unknown state produces. Same words for all three, on purpose: */
const BAD_STATE_MESSAGE =
  'This connection link is no longer valid. It may have already been used, or more than 15 ' +
  'minutes passed since you pressed Connect. Start again from Settings.';

/**
 * Redeems the one-time state. Returns the uid that started the flow, or null.
 * The state doc is DELETED inside the same transaction that reads it, so two
 * callbacks racing on one nonce cannot both succeed.
 */
export async function redeemOAuthState(
  database: FirebaseFirestore.Firestore,
  state: string,
  nowMs: number,
): Promise<string | null> {
  const ref = database.collection(OAUTH_STATE_COLLECTION).doc(state);
  return database.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const data = snap.data() as { uid?: unknown; expiresAt?: unknown } | undefined;
    tx.delete(ref);
    const expiresAt = typeof data?.expiresAt === 'string' ? Date.parse(data.expiresAt) : NaN;
    if (!Number.isFinite(expiresAt) || expiresAt < nowMs) return null;
    return typeof data?.uid === 'string' && data.uid !== '' ? data.uid : null;
  });
}

/**
 * The page the operator lands on. Self-contained, no external asset, and it
 * NEVER echoes the code, the state or any token: this URL sits in browser
 * history and in the referrer of anything the page might load.
 */
export function callbackPage(title: string, detail: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${esc(title)}</title>` +
    '<style>body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:48px 24px;' +
    'background:#f7f5f2;color:#1a1c28;line-height:1.55}main{max-width:32rem;margin:0 auto}' +
    'h1{font-size:1.35rem;margin:0 0 .75rem}p{margin:0 0 .75rem}</style></head><body><main>' +
    `<h1>${esc(title)}</h1><p>${esc(detail)}</p>` +
    '<p>You can close this window and go back to AuntieOS.</p></main></body></html>'
  );
}

/**
 * Records the outcome on the connection doc so the panel that started the flow
 * can say what happened. Merged, never a whole-doc write: a failed attempt must
 * not blank an existing working connection.
 */
async function stampConnect(
  outcome: { status: 'ok' } | { status: 'error'; error: string },
  uid: string,
): Promise<void> {
  try {
    await db()
      .doc(GOOGLE_CALENDAR_DOC_PATH)
      .set(connectStamp(outcome, new Date().toISOString()), { merge: true });
  } catch (err) {
    // Best-effort by design, exactly as the 7.1 stamp is: losing the receipt
    // must not replace the real reason with "could not write settings". Logged,
    // never swallowed.
    logEvent({
      severity: 'warn',
      function: 'googleOAuthCallback',
      event: 'gcal.oauth.stamp_failed',
      uid,
      extra: { reason: err instanceof Error ? err.message : 'unknown' },
    });
  }
}

export async function googleOAuthCallbackHandler(req: Request, res: Response): Promise<void> {
  initSentry();
  if (req.method !== 'GET') {
    res.status(405).send(callbackPage('That did not work', 'This address only answers browser redirects from Google.'));
    return;
  }

  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const googleError = typeof req.query.error === 'string' ? req.query.error : '';

  // Google reports a declined consent by redirecting back with `error`, not by
  // failing. Redeem the state first anyway, so a declined attempt cannot leave a
  // live nonce behind, and so the receipt names the admin who tried.
  const uid = state === '' ? null : await redeemOAuthState(db(), state, Date.now());

  if (state === '' || uid === null) {
    logEvent({
      severity: 'warn',
      function: 'googleOAuthCallback',
      event: 'gcal.oauth.state_rejected',
      extra: { hadState: state !== '', hadCode: code !== '' },
    });
    // No uid, so there is nobody to stamp this against and no way to know the
    // attempt was ours at all. The page is the whole report.
    res.status(400).send(callbackPage('That link has expired', BAD_STATE_MESSAGE));
    return;
  }

  if (googleError !== '') {
    const detail =
      googleError === 'access_denied'
        ? 'Google Calendar was not connected because access was declined on the Google screen.'
        : `Google refused the connection: ${googleError}.`;
    await stampConnect({ status: 'error', error: detail }, uid);
    logEvent({
      severity: 'warn',
      function: 'googleOAuthCallback',
      event: 'gcal.oauth.denied',
      uid,
      extra: { googleError },
    });
    res.status(400).send(callbackPage('Not connected', detail));
    return;
  }

  if (code === '') {
    const detail = 'Google sent us back without an authorization code, so nothing was connected.';
    await stampConnect({ status: 'error', error: detail }, uid);
    res.status(400).send(callbackPage('Not connected', detail));
    return;
  }

  try {
    // Reads BOTH secrets: the exchange is signed with the client secret.
    const { refreshToken, scopes } = await exchangeCodeForRefreshToken(code);

    // The connected account's address, read off its own primary calendar entry.
    // Doing it this way keeps the grant to calendar scopes alone: asking for a
    // profile scope purely to render one line of text would widen the consent
    // screen for no functional gain.
    const calendar = calendarClientForRefreshToken(refreshToken);
    const primary = await calendar.calendarList.get({ calendarId: 'primary' });
    const googleAccountEmail = typeof primary.data.id === 'string' ? primary.data.id : '';

    await db()
      .doc(GOOGLE_CALENDAR_DOC_PATH)
      .set(
        {
          connected: true,
          refreshToken,
          scopes,
          googleAccountEmail,
          connectedAt: new Date().toISOString(),
          connectedByUid: uid,
          // A fresh connection clears the last disconnect, so the panel cannot
          // show "connected" and "disconnected at 4pm" at the same time.
          disconnectedAt: '',
          disconnectedError: '',
          ...connectStamp({ status: 'ok' }, new Date().toISOString()),
        },
        { merge: true },
      );

    await writeAuditEntry({
      event: AUDIT_EVENTS.INTEGRATION_CALENDAR_CONNECTED,
      severity: 'info',
      actorRole: 'AUNTIE',
      actorUid: uid,
      targetCollection: 'integrations_config',
      description: `Connected Google Calendar account ${googleAccountEmail}`,
      // The token is deliberately absent from the payload: an audit entry is
      // readable by any Auntie, which is exactly who must not see it.
      payload: { googleAccountEmail, scopes },
    });

    logEvent({
      severity: 'info',
      function: 'googleOAuthCallback',
      event: 'gcal.oauth.connected',
      uid,
      extra: { scopes },
    });

    res.status(200).send(
      callbackPage(
        'Google Calendar connected',
        googleAccountEmail === ''
          ? 'AuntieOS can now write visits to this account.'
          : `AuntieOS can now write visits to ${googleAccountEmail}. Pick which calendar in Settings.`,
      ),
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'The connection could not be completed.';
    await stampConnect({ status: 'error', error: detail }, uid);
    logEvent({
      severity: 'error',
      function: 'googleOAuthCallback',
      event: 'gcal.oauth.exchange_failed',
      uid,
      errorMessage: detail,
    });
    res.status(400).send(callbackPage('Not connected', detail));
  }
}

export const startGoogleCalendarConnect = onCall(
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    secrets: [...GOOGLE_OAUTH_SECRETS, 'SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'],
  },
  wrapAdminCallable('startGoogleCalendarConnect', startGoogleCalendarConnectHandler),
);

export const googleOAuthCallback = onRequest(
  { region: 'us-central1', secrets: [...GOOGLE_OAUTH_SECRETS, 'SENTRY_DSN'] },
  wrapHttp('googleOAuthCallback', googleOAuthCallbackHandler),
);
