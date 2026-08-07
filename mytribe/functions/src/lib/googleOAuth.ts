import { HttpsError } from 'firebase-functions/v2/https';
import type { calendar_v3 } from '@googleapis/calendar';
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

/**
 * Fresh OAuth2 client. Not cached: `setCredentials` mutates it per connection.
 *
 * THE SDK IS LOADED HERE, NOT AT FILE SCOPE, AND IT IS THE NARROW PACKAGE.
 * Two separate savings, in that order, and both were measured:
 *
 *   1. At file scope, `googleapis` cost 109MiB of resident memory charged to
 *      the cold start of all 227 functions, because the Functions runtime loads
 *      the whole of `index.js` whatever the target is. `getMyHome` was carrying
 *      a Calendar client it will never call. Moving the load in here charged it
 *      to the five functions that reach this line: googleOAuthCallback,
 *      listGoogleCalendars, disconnectGoogleCalendar, pushVisitsToGoogleCalendar
 *      and (through its own copy of this import) syncGoogleCalendarBusyEvents.
 *   2. That only moved the cost, it did not remove it. `require('googleapis')`
 *      eagerly instantiates every Google API the bundle ships, and measured on
 *      the built lib/ it took the process from 193 MiB to 290 MiB: +97 MiB,
 *      over the 256MiB limit, at the moment an operator pressed a Calendar
 *      button. `@googleapis/calendar` is the same generated client for the one
 *      API we use, published by the same team, and costs +0.9 MiB to a 193.5
 *      MiB peak. Same code path, same `calendar_v3` types, 99% less of it.
 *
 * So do not "simplify" this back to `googleapis`: that one import is the
 * difference between 256MiB and 512MiB on every Calendar function. If a second
 * Google API is ever needed, add its own `@googleapis/<api>` package rather
 * than the bundle.
 *
 * `await import()` rather than an in-function `require()`, and the reason is
 * test integrity rather than emit shape. Under `module: nodenext` (2026-08-07,
 * moving off deprecated node10 resolution) tsc no longer downlevels this: it
 * emits a real `await import('@googleapis/calendar')`. Still a deferred single
 * load, now memoised in the ESM module registry rather than the require cache,
 * and this package resolves to the same `build/index.js` either way.
 *
 * The load-bearing half is unchanged: a bare in-function `require()` escapes
 * Vitest's module graph and silently loads the real SDK straight past the
 * `vi.mock('@googleapis/calendar')` in four suites. Measured with a probe, not
 * assumed. That is why the six deferred SDKs stay on `await import()` even
 * where a `require` would match the old runtime build more closely.
 *
 * ONE CONSTRAINT THIS ADDS: a dynamic `import()` of a RELATIVE path is now a
 * real ESM import at runtime, and Node's ESM resolver has no extensionless
 * lookup, so it throws ERR_MODULE_NOT_FOUND from the compiled `lib/`. Bare
 * package specifiers like this one are fine. See `admin/getIntegrationsHealth`,
 * which had to become a deferred `require` for exactly that reason.
 */
async function oauthClient() {
  const { clientId, clientSecret } = readGoogleOAuthConfig();
  const { auth } = await import('@googleapis/calendar');
  return new auth.OAuth2(clientId, clientSecret, GOOGLE_OAUTH_REDIRECT_URI);
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
  const client = await oauthClient();
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
 * A Calendar API client acting as the connected account. The client refreshes
 * the access token itself from the refresh token, so no access token is ever
 * stored by us.
 */
export async function calendarClientForRefreshToken(
  refreshToken: string,
): Promise<calendar_v3.Calendar> {
  const client = await oauthClient();
  client.setCredentials({ refresh_token: refreshToken });
  const { calendar } = await import('@googleapis/calendar');
  return calendar({ version: 'v3', auth: client });
}

/**
 * Revokes the grant at Google. Separate from deleting our copy of the token on
 * purpose: deleting only our copy would leave a live grant on the operator's
 * Google account that nothing in this app can see or remove.
 */
export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  const client = await oauthClient();
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
