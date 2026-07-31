import { GOOGLE_OAUTH_NOT_CONFIGURED_CODE, GOOGLE_OAUTH_REDIRECT_URI, GOOGLE_OAUTH_SECRET_NAMES } from './googleCalendarTargets';

/**
 * The three setup steps the operator owes for editable Google calendars, and
 * how much of each one this app can actually check.
 *
 * WHY THIS EXISTS. The steps were written down once, in the Task 7.2 commit
 * message and in `mytribe/functions/CALLABLE_CONTRACT.md`, and nowhere the
 * operator looks. The reported symptom is an operator who ran
 * `firebase functions:secrets:set` several times and still saw the feature fail,
 * which is precisely what steps 2 and 3 look like when only step 2 is done. A
 * panel that answers that with one red "could not connect" banner is the reason
 * it got run several times.
 *
 * WHAT IS KNOWABLE, AND FROM WHERE. This is the whole design, and the honesty
 * matters more than the coverage:
 *
 *   - THE DECLARATION IS KNOWABLE FROM CODE, and it is already true. Both names
 *     sit in the `secrets: [...]` of all five functions that read them
 *     (`GOOGLE_OAUTH_DECLARING_FUNCTIONS`), asserted per function in
 *     `mytribe/functions/test/googleCalendarOAuth.test.ts` and printable from the
 *     built artifact with `node scripts/declared-secrets.js --by-function`. So
 *     the panel states it as a fact rather than offering it as a step.
 *   - THE VALUES ARE NOT KNOWABLE FROM A BROWSER, ever. They live in Secret
 *     Manager and are mounted into a function's `process.env`. No callable
 *     returns them and none should. The only honest signal is what the server
 *     says when it tries to use them, so this module reads that signal off the
 *     callable rejection (`details.code = google_oauth_not_configured`, whose
 *     `missing` array names the ones it found empty) and says "only the server
 *     can answer this" the rest of the time. It never guesses.
 *   - THE DEPLOY IS NOT SEPARATELY KNOWABLE, and pretending otherwise would be
 *     the lie that matters. A value that was never set and a value that was set
 *     but never bound by a deploy produce the SAME empty `process.env` read, so
 *     they arrive here as one signal. Step 3 says that in as many words and
 *     names the deploy command, because the operator who has already run
 *     `functions:secrets:set` needs to be told which of the two is left.
 *   - GOOGLE'S SIDE IS KNOWABLE ONLY BY SUCCEEDING. A connected account proves
 *     the client exists and the redirect URI matches. Short of that, the one
 *     tell we do get is `invalid_client` on a token exchange, which the callback
 *     stamps on the connection document.
 */

/**
 * The five deployed functions that declare both secrets, because all five read
 * them. Mirrors the `secrets: [...]` arrays in
 * `mytribe/functions/src/admin/googleCalendar/`, which
 * `mytribe/functions/test/googleCalendarOAuth.test.ts` asserts per function, and
 * which `scripts/declared-secrets.js --by-function` prints from the built
 * artifact rather than from source.
 *
 * `getGoogleCalendarConnection` and `setGoogleCalendarTargets` are deliberately
 * NOT here: they only touch Firestore, and every declared secret is mounted on
 * every cold start of the function declaring it.
 */
export const GOOGLE_OAUTH_DECLARING_FUNCTIONS = [
  'startGoogleCalendarConnect',
  'googleOAuthCallback',
  'listGoogleCalendars',
  'pushVisitsToGoogleCalendar',
  'disconnectGoogleCalendar',
];

/** The deploy that binds a set secret. The codebase prefix is required; a bare name matches nothing. */
export const GOOGLE_OAUTH_DEPLOY_COMMAND = 'firebase deploy --only functions:mytribe';

export type SetupStepState = 'done' | 'failing' | 'unknown';

export interface GoogleOAuthSetupStep {
  id: 'oauthClient' | 'secretValues' | 'deploy';
  /** What the operator does, in one line. */
  title: string;
  /** The literal text to copy: a URI, or a command. Empty when the step has none. */
  literal: string;
  state: SetupStepState;
  /** Why we believe that state, or what to do. Never a generic sentence. */
  detail: string;
}

/**
 * Everything the panel has observed. Assembled by the section from what the
 * server has actually said, never from a guess about what it would say.
 */
export interface GoogleOAuthSetupSignals {
  /** False when a callable in this path did not answer at all: nothing is deployed to answer it. */
  serverAnswered: boolean;
  /** The verbatim failure when `serverAnswered` is false. */
  serverFailure: string;
  /** From `details.missing` on a `google_oauth_not_configured` rejection. */
  missingSecrets: string[];
  /** True once the server handed back a consent URL, which it can only build by reading BOTH values. */
  consentUrlIssued: boolean;
  /** True while a Google account is connected. */
  connected: boolean;
  /** The connected account, for the step that has no other proof it worked. */
  connectedAccount: string;
  /** The server's stamp from the last returning callback, whatever it said. */
  lastConnectError: string;
}

export const NO_SIGNALS: GoogleOAuthSetupSignals = {
  serverAnswered: true,
  serverFailure: '',
  missingSecrets: [],
  consentUrlIssued: false,
  connected: false,
  connectedAccount: '',
  lastConnectError: '',
};

/**
 * Pulls the two things worth branching on out of a callable rejection: our own
 * `details.code`, and the `missing` names that come with
 * `google_oauth_not_configured`. Reads the shape defensively rather than
 * importing `FirebaseError`, so this stays a pure function a test can call with
 * a plain object.
 */
export function readOAuthFailure(err: unknown): { code: string; missing: string[] } {
  if (typeof err !== 'object' || err === null) return { code: '', missing: [] };
  const details = (err as { details?: unknown }).details;
  if (typeof details !== 'object' || details === null) return { code: '', missing: [] };
  const code = (details as { code?: unknown }).code;
  const missing = (details as { missing?: unknown }).missing;
  return {
    code: typeof code === 'string' ? code : '',
    missing: Array.isArray(missing) ? missing.filter((m): m is string => typeof m === 'string') : [],
  };
}

/** True when the rejection is the one that means "setup is not finished on the server". */
export function isNotConfigured(err: unknown): boolean {
  return readOAuthFailure(err).code === GOOGLE_OAUTH_NOT_CONFIGURED_CODE;
}

function nameList(names: string[]): string {
  return names.join(' and ');
}

/**
 * The checklist, with each step's state derived from what the server has said.
 *
 * Steps 2 and 3 move together on the `missing` signal on purpose. From a browser
 * they are the same observation, and splitting them into a confident "value not
 * set" and a confident "not deployed" would mean inventing one of the two.
 */
export function googleOAuthSetupSteps(signals: GoogleOAuthSetupSignals): GoogleOAuthSetupStep[] {
  const proven = signals.consentUrlIssued || signals.connected;
  const missing = signals.missingSecrets;
  const invalidClient = signals.lastConnectError.toLowerCase().includes('invalid_client');

  const oauthClient: GoogleOAuthSetupStep = {
    id: 'oauthClient',
    title: 'Create the OAuth client in Google Cloud Console',
    literal: GOOGLE_OAUTH_REDIRECT_URI,
    state: signals.connected ? 'done' : invalidClient ? 'failing' : 'unknown',
    detail: signals.connected
      ? `Done. Google accepted this client when ${
          signals.connectedAccount === '' ? 'the account' : signals.connectedAccount
        } connected, which is the only proof there is.`
      : invalidClient
        ? 'Google answered invalid_client on the last attempt. The id and secret the server holds do ' +
          'not belong to a live OAuth client on this project, so either the client was deleted or the ' +
          'values were pasted from a different one.'
        : 'Nothing here can check this one: it lives in a Google project this app cannot read. ' +
          'Project auntieos-ttpc, APIs and Services, Credentials, Create credentials, OAuth client ID, ' +
          'type Web application. If the Google window says redirect_uri_mismatch, this is the step ' +
          'that is wrong, and the URI has to match below character for character.',
  };

  const secretValues: GoogleOAuthSetupStep = {
    id: 'secretValues',
    title: 'Set both secret values',
    literal: GOOGLE_OAUTH_SECRET_NAMES.map(
      (n) => `firebase functions:secrets:set ${n} --project auntieos-ttpc`,
    ).join('\n'),
    state: missing.length > 0 ? 'failing' : proven ? 'done' : 'unknown',
    detail:
      missing.length > 0
        ? `The server read ${nameList(missing)} as empty. Run the command below from mytribe/ for ` +
          `${missing.length === 1 ? 'that name' : 'each name'}, then step 3.`
        : proven
          ? 'Done. The server read both values, which is the only way it could have built a consent URL.'
          : 'Only the server can answer this. The values live in Secret Manager and no browser can ' +
            'read them, so nothing on this page is going to tell you whether they are there. Press ' +
            'Connect and the server names any it finds empty.',
  };

  const deploy: GoogleOAuthSetupStep = {
    id: 'deploy',
    title: 'Redeploy, so the functions mount what you set',
    literal: GOOGLE_OAUTH_DEPLOY_COMMAND,
    state: !signals.serverAnswered || missing.length > 0 ? 'failing' : proven ? 'done' : 'unknown',
    detail: !signals.serverAnswered
      ? `Nothing answered: ${signals.serverFailure} The functions this feature needs are not ` +
        'reachable, so the deploy is the step to run first.'
      : missing.length > 0
        ? 'From here this looks exactly like step 2, and that is the trap. A value that was never set ' +
          'and a value that was set but never carried into the runtime by a deploy both read as empty. ' +
          'If you have already run the command in step 2, this is the one that is outstanding: setting ' +
          'a secret mints a new version, and these functions keep the version they were deployed with ' +
          'until a deploy resolves it again.'
        : proven
          ? 'Done. A running function read the values, which only happens after a deploy carried them.'
          : 'Run this after any change to either value. Setting a secret mints a new version and ' +
            'changes nothing on its own.',
  };

  return [oauthClient, secretValues, deploy];
}

/** The one-line summary above the list: which step to look at, or that there is none. */
export function googleOAuthSetupSummary(steps: GoogleOAuthSetupStep[]): string {
  const failing = steps.find((s) => s.state === 'failing');
  if (failing !== undefined) return `Step ${String(steps.indexOf(failing) + 1)}: ${failing.title}.`;
  if (steps.every((s) => s.state === 'done')) return 'All three steps are done.';
  return 'No step has failed yet. The ones marked unknown can only be answered by trying.';
}
