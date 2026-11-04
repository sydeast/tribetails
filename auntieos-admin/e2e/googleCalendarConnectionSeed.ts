/**
 * The Google Calendar connection document for the real-services run (#1517).
 *
 * The functions read the OAuth connection from ONE Firestore document,
 * `integrations_config/googleCalendar` (`GOOGLE_CALENDAR_DOC_PATH` in
 * `mytribe/functions/src/lib/googleCalendarConnection.ts`). In production that
 * document is written by the OAuth callback after the operator consents. The
 * real-services run has no consent window, so the calendar spec writes it from
 * two environment variables instead: the refresh token the operator minted for
 * the "AuntieOS test" calendar and that calendar's id.
 *
 * WHY THE TOKEN GOES IN A DOCUMENT AND NOT IN `.secret.local`. The preflight
 * keeps `E2E_GOOGLE_CALENDAR_REFRESH_TOKEN` and `E2E_GOOGLE_CALENDAR_ID` out of
 * the secrets file on purpose (`VENDOR_EXTRA_ENV` in
 * `scripts/e2e-real/preflight.mjs`): no function declares either as a secret,
 * so a line in that file would do nothing. The document is the only path the
 * push reads, which is also why `calendarClientForRefreshToken` works the
 * moment it exists: the OAuth client id and secret already reach the emulator
 * through the Secret Manager allowlist.
 *
 * WRITTEN BY THE CALENDAR SPEC'S OWN `before`, REMOVED IN ITS `after`, never
 * by the run-wide seed. `settings-integrations.cy.ts` asserts the
 * not-connected state ("Connect Google Calendar") and has to keep passing
 * whichever spec runs first.
 *
 * NOTHING HERE TOUCHES GOOGLE. This builds the document; the Cypress task in
 * `cypress.real.config.ts` writes it to the emulator over REST. The token is
 * read from `process.env` on the node side and never crosses into the
 * browser or the Cypress command log.
 */

export const INTEGRATIONS_COLLECTION = 'integrations_config';
export const GOOGLE_CALENDAR_DOC_ID = 'googleCalendar';

/** The two variables the run reads. Same names as `VENDOR_EXTRA_ENV.googleCalendar` in preflight.mjs. */
export const REFRESH_TOKEN_ENV = 'E2E_GOOGLE_CALENDAR_REFRESH_TOKEN';
export const CALENDAR_ID_ENV = 'E2E_GOOGLE_CALENDAR_ID';
export const ENV_NAMES = [REFRESH_TOKEN_ENV, CALENDAR_ID_ENV] as const;

/**
 * The scopes the OAuth lib asks for, copied from `GOOGLE_OAUTH_SCOPES` in
 * `mytribe/functions/src/lib/googleOAuth.ts`. Copied rather than imported:
 * that module pulls in `firebase-functions`, which has no business in a
 * Cypress config. `scripts/e2e-real/google-calendar-seed.test.mjs` reads the
 * functions source and fails if the two lists drift.
 */
export const GOOGLE_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
] as const;

/**
 * Same address shape the server enforces (`CALENDAR_ID_PATTERN` in
 * `mytribe/functions/src/lib/googleCalendarTargets.ts`): a local part, an
 * `@`, and a dotted domain. A secondary calendar's id looks like
 * `<hash>@group.calendar.google.com`.
 */
const CALENDAR_ID_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The stored shape, field for field, so a stamp the panel reads is never
 * `undefined`. Mirrors `GoogleCalendarConnectionDoc` in
 * `googleCalendarConnection.ts`; the functions' `connectionFromDoc` would
 * default a missing field anyway, but writing each one keeps the document
 * readable in the emulator UI and makes the receipts' starting state explicit.
 *
 * A type alias rather than an interface so the value is assignable to the
 * `Record<string, unknown>` that `e2e/seed.ts`'s `upsert` takes.
 */
export type SeededGoogleCalendarConnection = {
  connected: true;
  googleAccountEmail: string;
  connectedAt: string;
  connectedByUid: string;
  scopes: string[];
  refreshToken: string;
  writeCalendarId: string;
  enabledCalendarIds: string[];
  disconnectedAt: '';
  disconnectedError: '';
  connectLastAttemptAt: string;
  connectLastStatus: 'ok';
  connectLastError: '';
  calendarPushLastRunAt: '';
  calendarPushLastStatus: '';
  calendarPushLastPushed: 0;
  calendarPushLastError: '';
  calendarAutoSyncLastRunAt: '';
  calendarAutoSyncLastStatus: '';
  calendarAutoSyncLastAction: '';
  calendarAutoSyncLastSessionId: '';
  calendarAutoSyncLastError: '';
};

export interface SeedInput {
  /** `process.env`, or a test's stand-in. Only the two names above are read. */
  env: Record<string, string | undefined>;
  /** The admin the connection is recorded against. Informational; the push does not read it. */
  connectedByUid: string;
  /** What the panel prints after "Connected as". The push does not read it for a named calendar. */
  googleAccountEmail: string;
  /** `connectedAt` and the connect stamp. */
  nowIso: string;
}

/**
 * The names among the two that are unset or empty, in declaration order. Empty
 * means the seed may proceed.
 */
export function missingCalendarEnv(env: Record<string, string | undefined>): string[] {
  return ENV_NAMES.filter((name) => (env[name] ?? '').trim() === '');
}

/**
 * The document the calendar spec seeds, or a thrown refusal naming what is
 * wrong. Pure: reads nothing but [input].
 *
 * REFUSES `primary`. The push and the run's cleanup both write to the id in
 * `E2E_GOOGLE_CALENDAR_ID`, and `primary` is the connected account's own
 * calendar, which is the one calendar the suite must never touch. The test
 * calendar is a separate calendar on that account (D3-d), so its id is a
 * named one.
 *
 * REFUSES A VALUE THAT IS NOT A CALENDAR ID, with the same rule the push
 * applies in `requireWritableConnection`. Caught here, the message names the
 * variable; caught there, the spec fails on a banner about a calendar picker
 * the operator never used.
 *
 * EVERY RECEIPT STARTS EMPTY. The spec asserts the panel's "No visits have
 * been sent to this calendar yet." line before it presses Push, and that
 * assertion is only meaningful if nothing left over from an earlier run can
 * pre-fill the stamp. `upsert` merges, so the empty values are written, not
 * left to chance.
 */
export function googleCalendarConnectionSeed(input: SeedInput): SeededGoogleCalendarConnection {
  const missing = missingCalendarEnv(input.env);
  if (missing.length > 0) {
    throw new Error(
      `${missing.join(' and ')} must be set to seed the Google Calendar connection; refusing to write a half-formed one`,
    );
  }
  const refreshToken = (input.env[REFRESH_TOKEN_ENV] ?? '').trim();
  const calendarId = (input.env[CALENDAR_ID_ENV] ?? '').trim();
  if (calendarId.toLowerCase() === 'primary') {
    throw new Error(
      `${CALENDAR_ID_ENV} is "primary", the connected account's own calendar. The run writes to and cleans ` +
        'up a separate test calendar; set the variable to that calendar\'s id',
    );
  }
  if (!CALENDAR_ID_PATTERN.test(calendarId)) {
    throw new Error(
      `${CALENDAR_ID_ENV} is not a Google Calendar id (expected something like ` +
        '<id>@group.calendar.google.com); the push would refuse it as write_calendar_invalid',
    );
  }
  if (/\s/.test(refreshToken)) {
    throw new Error(`${REFRESH_TOKEN_ENV} contains whitespace, which no refresh token does; check the paste`);
  }
  return {
    connected: true,
    googleAccountEmail: input.googleAccountEmail,
    connectedAt: input.nowIso,
    connectedByUid: input.connectedByUid,
    scopes: [...GOOGLE_OAUTH_SCOPES],
    refreshToken,
    writeCalendarId: calendarId,
    enabledCalendarIds: [calendarId],
    disconnectedAt: '',
    disconnectedError: '',
    connectLastAttemptAt: input.nowIso,
    connectLastStatus: 'ok',
    connectLastError: '',
    calendarPushLastRunAt: '',
    calendarPushLastStatus: '',
    calendarPushLastPushed: 0,
    calendarPushLastError: '',
    calendarAutoSyncLastRunAt: '',
    calendarAutoSyncLastStatus: '',
    calendarAutoSyncLastAction: '',
    calendarAutoSyncLastSessionId: '',
    calendarAutoSyncLastError: '',
  };
}
