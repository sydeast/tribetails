import { HttpsError } from 'firebase-functions/v2/https';
import { google } from 'googleapis';
import { GOOGLE_OAUTH_NOT_CONFIGURED_CODE, GOOGLE_OAUTH_REVOKED_CODE } from './googleCalendarTargets';

/**
 * The Google OAuth client AuntieOS uses to WRITE to a calendar (Task 7.2), and
 * the one place the two operator-set secrets are read.
 *
 * WHY OAUTH AND NOT THE SERVICE ACCOUNT. Task 7.1's free/busy sync authenticates
 * as `auntieos-admin-calendar-sync@…` through Application Default Credentials
 * and can only READ availability off a calendar the operator shared with it.
 * A service account cannot create events on a human's calendar without
 * domain-wide delegation, which is a Workspace-admin feature this account does
 * not have. Writing therefore needs the operator's own consent, which is what
 * the OAuth flow collects, and a refresh token, which is what it leaves behind.
 *
 * BOTH SECRETS ARE READ HERE AND NOWHERE ELSE. Every function that needs them
 * declares `secrets: GOOGLE_OAUTH_SECRETS` so the Functions runtime mounts them
 * into `process.env`. A secret that is set but not declared is not mounted, and
 * a secret that is declared but never read does nothing at all: the retired
 * `GOOGLE_CALENDAR_SETUP.md` told the operator to set a `GOOGLE_CALENDAR_ID`
 * that no function ever read, which is the exact failure this arrangement is
 * shaped to avoid. `test/googleOAuth.test.ts` asserts every one of these
 * functions declares both names.
 */

/**
 * The two secrets, as one list, so a function cannot declare half of them. Set
 * by the operator with `firebase functions:secrets:set <NAME> --project
 * auntieos-ttpc` from `mytribe/`, then a redeploy.
 */
export const GOOGLE_OAUTH_SECRETS = ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'];

/**
 * Least privilege for what this feature does. `calendar.events` writes the
 * visit events; `calendar.readonly` lists the account's calendars so the
 * operator picks one from a list instead of pasting an id. Neither grants
 * access to Gmail, Drive, contacts or the account's profile: the connected
 * account's address is read back from its own primary calendar entry rather
 * than by asking for a profile scope we would otherwise never use.
 */
export const GOOGLE_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
];

/**
 * The deployed callback URL, which the operator must register on the OAuth
 * client in Google Cloud Console EXACTLY as written. Google refuses the whole
 * flow with `redirect_uri_mismatch` on any difference, including a trailing
 * slash, so this is a constant rather than something reassembled per request
 * from a header a caller controls.
 */
export const GOOGLE_OAUTH_REDIRECT_URI =
  'https://us-central1-auntieos-ttpc.cloudfunctions.net/googleOAuthCallback';

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
}

/**
 * The client id + secret, or a fail-loud rejection naming both secrets and the
 * command that sets them. Never returns a partial config: half a client cannot
 * complete a flow, and "invalid_client" from Google is not a message that tells
 * an operator which of the two is missing.
 */
export function readGoogleOAuthConfig(): GoogleOAuthConfig {
  const clientId = (process.env.GOOGLE_OAUTH_CLIENT_ID ?? '').trim();
  const clientSecret = (process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '').trim();
  const missing = [
    clientId === '' ? 'GOOGLE_OAUTH_CLIENT_ID' : '',
    clientSecret === '' ? 'GOOGLE_OAUTH_CLIENT_SECRET' : '',
  ].filter((n) => n !== '');
  if (missing.length > 0) {
    throw new HttpsError('failed-precondition', googleOAuthNotConfiguredMessage(missing), {
      code: GOOGLE_OAUTH_NOT_CONFIGURED_CODE,
      missing,
    });
  }
  return { clientId, clientSecret };
}

/** The operator-facing setup instruction, in one place so every caller says the same thing. */
export function googleOAuthNotConfiguredMessage(missing: string[]): string {
  const names = missing.join(' and ');
  return (
    `Google Calendar is not set up on the server yet: ${names} ` +
    `${missing.length === 1 ? 'is' : 'are'} not set. In Google Cloud Console for project ` +
    'auntieos-ttpc, under APIs and Services, Credentials, create an OAuth client ID of type Web ' +
    `application with the redirect URI ${GOOGLE_OAUTH_REDIRECT_URI}, then from mytribe/ run ` +
    `${missing.map((n) => `firebase functions:secrets:set ${n} --project auntieos-ttpc`).join(' and ')} ` +
    'and redeploy the functions.'
  );
}

/**
 * The Google consent URL, built by hand rather than through
 * `oauth2Client.generateAuthUrl` so the exact query it sends is visible in a
 * unit test without a live client.
 *
 * `access_type=offline` plus `prompt=consent` is what makes Google return a
 * REFRESH token. Without `prompt=consent` Google returns one only on the very
 * first authorization for that client + account pair, so a re-connect after a
 * disconnect would silently come back with an access token that dies in an hour
 * and no way to renew it.
 */
export function buildConsentUrl(clientId: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: GOOGLE_OAUTH_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/** Fresh OAuth2 client. Not cached: `setCredentials` mutates it per connection. */
function oauthClient() {
  const { clientId, clientSecret } = readGoogleOAuthConfig();
  return new google.auth.OAuth2(clientId, clientSecret, GOOGLE_OAUTH_REDIRECT_URI);
}

export interface ExchangedTokens {
  refreshToken: string;
  scopes: string[];
}

/**
 * Trades the one-time `code` for a refresh token.
 *
 * A response with no `refresh_token` is a FAILURE here, not a partial success.
 * It means the grant already existed and Google saw no reason to mint another,
 * and storing only the access token would leave a connection that works for an
 * hour and then breaks with no way to renew. The operator's fix is to remove
 * AuntieOS at myaccount.google.com/permissions and connect again, so the
 * message says that.
 */
export async function exchangeCodeForRefreshToken(code: string): Promise<ExchangedTokens> {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  const refreshToken = typeof tokens.refresh_token === 'string' ? tokens.refresh_token.trim() : '';
  if (refreshToken === '') {
    throw new HttpsError(
      'failed-precondition',
      'Google did not return a refresh token, which means this account had already granted ' +
        'access. Remove Tribe Tails at myaccount.google.com/permissions, then connect again.',
    );
  }
  const scopes = typeof tokens.scope === 'string' ? tokens.scope.split(' ').filter((s) => s !== '') : [];
  return { refreshToken, scopes };
}

/**
 * A Calendar API client acting as the connected account. The googleapis client
 * refreshes the access token itself from the refresh token, so no access token
 * is ever stored by us.
 */
export function calendarClientForRefreshToken(refreshToken: string) {
  const client = oauthClient();
  client.setCredentials({ refresh_token: refreshToken });
  return google.calendar({ version: 'v3', auth: client });
}

/**
 * Revokes the grant at Google. Separate from deleting our copy of the token on
 * purpose: deleting only our copy would leave a live grant on the operator's
 * Google account that nothing in this app can see or remove.
 */
export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  const client = oauthClient();
  await client.revokeToken(refreshToken);
}

/**
 * True when Google is saying the refresh token is dead: the operator removed
 * the grant at myaccount.google.com, the password changed, or the token expired
 * from disuse. This is the one Google failure that must not be reported as a
 * transient outage, because retrying never fixes it and only reconnecting does.
 */
export function isInvalidGrant(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { message?: unknown; response?: { data?: { error?: unknown } } };
  const fromBody = e.response?.data?.error;
  if (typeof fromBody === 'string' && fromBody === 'invalid_grant') return true;
  return typeof e.message === 'string' && e.message.includes('invalid_grant');
}

/** The rejection every caller throws once `isInvalidGrant` is true, so the code is one string. */
export function revokedError(): HttpsError {
  return new HttpsError(
    'failed-precondition',
    'Google has rejected the saved connection. Access was removed on the Google account, or the ' +
      'token expired from disuse. Connect Google Calendar again to restore it.',
    { code: GOOGLE_OAUTH_REVOKED_CODE },
  );
}
