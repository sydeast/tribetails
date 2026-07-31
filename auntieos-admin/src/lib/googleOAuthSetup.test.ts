import { describe, it, expect } from 'vitest';
import {
  GOOGLE_OAUTH_DECLARING_FUNCTIONS,
  GOOGLE_OAUTH_DEPLOY_COMMAND,
  NO_SIGNALS,
  googleOAuthSetupSteps,
  googleOAuthSetupSummary,
  isNotConfigured,
  readOAuthFailure,
} from './googleOAuthSetup';
import { GOOGLE_OAUTH_REDIRECT_URI } from './googleCalendarTargets';

function steps(overrides: Partial<typeof NO_SIGNALS> = {}) {
  return googleOAuthSetupSteps({ ...NO_SIGNALS, ...overrides });
}

describe('googleOAuthSetup, what the server said, read off the rejection', () => {
  it('pulls the code and the missing names out of details', () => {
    expect(
      readOAuthFailure({
        code: 'functions/failed-precondition',
        details: { code: 'google_oauth_not_configured', missing: ['GOOGLE_OAUTH_CLIENT_SECRET'] },
      }),
    ).toEqual({ code: 'google_oauth_not_configured', missing: ['GOOGLE_OAUTH_CLIENT_SECRET'] });
  });

  it('reports nothing rather than throwing on an error with no details at all', () => {
    // A network failure and a timeout both land here. Neither says anything
    // about setup, and neither may be read as if it did.
    expect(readOAuthFailure(new Error('offline'))).toEqual({ code: '', missing: [] });
    expect(readOAuthFailure(null)).toEqual({ code: '', missing: [] });
    expect(readOAuthFailure({ details: 'nonsense' })).toEqual({ code: '', missing: [] });
    expect(isNotConfigured(new Error('offline'))).toBe(false);
  });

  it('drops non-string entries from missing instead of rendering them', () => {
    expect(readOAuthFailure({ details: { code: 'x', missing: ['A', 7, null] } }).missing).toEqual(['A']);
  });
});

describe('googleOAuthSetup, the three steps', () => {
  it('starts with nothing failed and nothing claimed, since only trying can answer them', () => {
    const s = steps();
    expect(s.map((x) => x.state)).toEqual(['unknown', 'unknown', 'unknown']);
    expect(googleOAuthSetupSummary(s)).toMatch(/no step has failed yet/i);
  });

  it('names the exact secret the server found empty, not "a secret"', () => {
    const s = steps({ missingSecrets: ['GOOGLE_OAUTH_CLIENT_SECRET'] });
    expect(s[1]?.state).toBe('failing');
    expect(s[1]?.detail).toContain('GOOGLE_OAUTH_CLIENT_SECRET');
    expect(s[1]?.detail).not.toContain('GOOGLE_OAUTH_CLIENT_ID');
  });

  it('fails step 3 alongside step 2, because from a browser they are one observation', () => {
    // This is the reported bug: the operator ran functions:secrets:set several
    // times. Marking step 2 as the only failure would send them back to do it
    // again, which is exactly what happened.
    const s = steps({ missingSecrets: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'] });
    expect(s[2]?.state).toBe('failing');
    expect(s[2]?.detail).toMatch(/already run the command in step 2/i);
    expect(s[2]?.literal).toBe(GOOGLE_OAUTH_DEPLOY_COMMAND);
  });

  it('points at the FIRST failing step by number rather than summarising', () => {
    expect(googleOAuthSetupSummary(steps({ missingSecrets: ['GOOGLE_OAUTH_CLIENT_ID'] }))).toBe(
      'Step 2: Set both secret values.',
    );
  });

  it('calls a consent URL proof that both values were read, without a connection', () => {
    // The server cannot build a consent URL without reading BOTH: it refuses on
    // either one being empty. So the URL is the proof, and the connect flow
    // failing later is a different step's problem.
    const s = steps({ consentUrlIssued: true });
    expect(s[1]?.state).toBe('done');
    expect(s[2]?.state).toBe('done');
    // Google's half stays unknown: a consent URL is something we built, not
    // something Google accepted.
    expect(s[0]?.state).toBe('unknown');
  });

  it('only calls the Google step done once an account is actually connected', () => {
    const s = steps({ connected: true, connectedAccount: 'auntie@tribetails.com' });
    expect(s[0]?.state).toBe('done');
    expect(s[0]?.detail).toContain('auntie@tribetails.com');
    expect(googleOAuthSetupSummary(s)).toMatch(/all three steps are done/i);
  });

  it('blames the Google client when the exchange came back invalid_client', () => {
    const s = steps({ lastConnectError: 'Google refused: invalid_client' });
    expect(s[0]?.state).toBe('failing');
    expect(s[0]?.detail).toMatch(/invalid_client/);
  });

  it('blames the deploy, not the values, when nothing answered at all', () => {
    const s = steps({ serverAnswered: false, serverFailure: 'internal: NOT_FOUND.' });
    expect(s[2]?.state).toBe('failing');
    expect(s[2]?.detail).toContain('internal: NOT_FOUND.');
    // Nothing answered, so nothing is known about the values.
    expect(s[1]?.state).toBe('unknown');
  });

  it('prints the redirect URI verbatim, since Google refuses on a trailing slash', () => {
    expect(steps()[0]?.literal).toBe(GOOGLE_OAUTH_REDIRECT_URI);
    expect(steps()[0]?.literal).toBe(
      'https://us-central1-auntieos-ttpc.cloudfunctions.net/googleOAuthCallback',
    );
  });

  it('names both set commands with the project pinned', () => {
    const literal = steps()[1]?.literal ?? '';
    expect(literal).toContain('firebase functions:secrets:set GOOGLE_OAUTH_CLIENT_ID --project auntieos-ttpc');
    expect(literal).toContain(
      'firebase functions:secrets:set GOOGLE_OAUTH_CLIENT_SECRET --project auntieos-ttpc',
    );
  });
});

describe('googleOAuthSetup, the half that is knowable from code', () => {
  it('lists exactly the five functions that declare both secrets', () => {
    // The mirror. The enforcing copies are the `secrets: [...]` arrays in
    // mytribe/functions/src/admin/googleCalendar/, asserted per function in
    // mytribe/functions/test/googleCalendarOAuth.test.ts and printable with
    // `node scripts/declared-secrets.js --by-function`. The two Firestore-only
    // callables are absent on purpose: every declared secret is mounted on every
    // cold start of the function declaring it.
    expect(GOOGLE_OAUTH_DECLARING_FUNCTIONS).toEqual([
      'startGoogleCalendarConnect',
      'googleOAuthCallback',
      'listGoogleCalendars',
      'pushVisitsToGoogleCalendar',
      'disconnectGoogleCalendar',
    ]);
    expect(GOOGLE_OAUTH_DECLARING_FUNCTIONS).not.toContain('getGoogleCalendarConnection');
    expect(GOOGLE_OAUTH_DECLARING_FUNCTIONS).not.toContain('setGoogleCalendarTargets');
  });

  it('names the codebase prefix in the deploy command, since a bare name matches nothing', () => {
    expect(GOOGLE_OAUTH_DEPLOY_COMMAND).toContain('functions:mytribe');
  });
});
