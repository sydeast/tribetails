import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/lib/firestoreAdmin', () => ({ db: vi.fn(), auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('@googleapis/calendar', () => ({
  auth: { OAuth2: class { setCredentials() {} } },
  calendar: () => ({}),
}));

import {
  GOOGLE_OAUTH_REDIRECT_URI,
  GOOGLE_OAUTH_SCOPES,
  GOOGLE_OAUTH_SECRETS,
  buildConsentUrl,
  isInvalidGrant,
  readGoogleOAuthConfig,
} from '../src/lib/googleOAuth';
import {
  calendarPushStamp,
  connectStamp,
  connectionFromDoc,
  publicConnection,
} from '../src/lib/googleCalendarConnection';
import {
  PRIMARY_CALENDAR_ID,
  resolveCalendarId,
  writeCalendarProblem,
} from '../src/lib/googleCalendarTargets';
import {
  startGoogleCalendarConnect,
  googleOAuthCallback,
} from '../src/admin/googleCalendar/googleCalendarConnect';
import {
  getGoogleCalendarConnection,
  disconnectGoogleCalendar,
} from '../src/admin/googleCalendar/googleCalendarAccount';
import {
  listGoogleCalendars,
  setGoogleCalendarTargets,
} from '../src/admin/googleCalendar/googleCalendarSelection';
import { pushVisitsToGoogleCalendar } from '../src/admin/googleCalendar/pushVisitsToGoogleCalendar';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

// ── The secrets are DECLARED, on every function that could need them ─────────

/**
 * The mistake this guards against is the one the retired GOOGLE_CALENDAR_SETUP.md
 * made: it told the operator to set a `GOOGLE_CALENDAR_ID` that no function ever
 * read. A secret that is set but not declared is never mounted into the
 * runtime's `process.env`, so the code reads undefined and the operator, who did
 * everything the instructions asked, sees a feature that does not work.
 */
function declaredSecrets(fn: unknown): string[] {
  const endpoint = (fn as { __endpoint?: { secretEnvironmentVariables?: Array<{ key: string }> } })
    .__endpoint;
  return (endpoint?.secretEnvironmentVariables ?? []).map((s) => s.key).sort();
}

describe('Google Calendar OAuth functions declare the operator-set secrets', () => {
  const needsOAuth: Array<[string, unknown]> = [
    ['startGoogleCalendarConnect', startGoogleCalendarConnect],
    ['googleOAuthCallback', googleOAuthCallback],
    ['disconnectGoogleCalendar', disconnectGoogleCalendar],
    ['listGoogleCalendars', listGoogleCalendars],
    ['pushVisitsToGoogleCalendar', pushVisitsToGoogleCalendar],
  ];

  for (const [name, fn] of needsOAuth) {
    it(`${name} declares both GOOGLE_OAUTH secrets`, () => {
      const declared = declaredSecrets(fn);
      expect(declared).toContain('GOOGLE_OAUTH_CLIENT_ID');
      expect(declared).toContain('GOOGLE_OAUTH_CLIENT_SECRET');
    });
  }

  it('the two names are exactly what the operator is told to set', () => {
    expect(GOOGLE_OAUTH_SECRETS).toEqual(['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET']);
  });

  it('the two functions that talk only to Firestore do NOT ask for them', () => {
    // Not a style point. Every declared secret is mounted on every cold start of
    // that function, so declaring one a function never reads widens the blast
    // radius of a leak for nothing.
    expect(declaredSecrets(getGoogleCalendarConnection)).not.toContain('GOOGLE_OAUTH_CLIENT_SECRET');
    expect(declaredSecrets(setGoogleCalendarTargets)).not.toContain('GOOGLE_OAUTH_CLIENT_SECRET');
  });
});

// ── The secrets are READ, and their absence is loud ──────────────────────────

describe('readGoogleOAuthConfig', () => {
  it('names BOTH missing secrets and the command that sets them', () => {
    try {
      readGoogleOAuthConfig();
      throw new Error('expected a rejection');
    } catch (err) {
      const e = err as { code?: string; message?: string; details?: { code?: string; missing?: string[] } };
      expect(e.code).toBe('failed-precondition');
      expect(e.details?.code).toBe('google_oauth_not_configured');
      expect(e.details?.missing).toEqual(['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET']);
      expect(e.message).toContain('firebase functions:secrets:set GOOGLE_OAUTH_CLIENT_ID');
      expect(e.message).toContain('firebase functions:secrets:set GOOGLE_OAUTH_CLIENT_SECRET');
      expect(e.message).toContain(GOOGLE_OAUTH_REDIRECT_URI);
    }
  });

  it('half a client is still a failure, and says WHICH half', () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-id-for-test';
    try {
      readGoogleOAuthConfig();
      throw new Error('expected a rejection');
    } catch (err) {
      const e = err as { message?: string; details?: { missing?: string[] } };
      expect(e.details?.missing).toEqual(['GOOGLE_OAUTH_CLIENT_SECRET']);
      expect(e.message).not.toContain('set GOOGLE_OAUTH_CLIENT_ID ');
    }
  });

  it('reads both from the environment the runtime mounts them into', () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = '  client-id-for-test  ';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'client-secret-for-test';
    expect(readGoogleOAuthConfig()).toEqual({
      clientId: 'client-id-for-test',
      clientSecret: 'client-secret-for-test',
    });
  });
});

describe('buildConsentUrl', () => {
  it('asks for offline access AND forces the consent screen', () => {
    // Without prompt=consent Google returns a refresh token only on the very
    // first authorization for a client + account pair, so a reconnect would come
    // back with an access token that dies in an hour and no way to renew it.
    const url = new URL(buildConsentUrl('client-id-for-test', 'state-abc'));
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe('state-abc');
    expect(url.searchParams.get('redirect_uri')).toBe(GOOGLE_OAUTH_REDIRECT_URI);
    expect(url.searchParams.get('scope')).toBe(GOOGLE_OAUTH_SCOPES.join(' '));
  });

  it('asks for calendar scopes only', () => {
    // The connected account's address is read off its own primary calendar
    // rather than through a profile scope, so the consent screen stays narrow.
    expect(GOOGLE_OAUTH_SCOPES).toEqual([
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.readonly',
    ]);
  });
});

describe('isInvalidGrant', () => {
  it('recognizes a revoked grant from either shape the Google client throws', () => {
    expect(isInvalidGrant({ response: { data: { error: 'invalid_grant' } } })).toBe(true);
    expect(isInvalidGrant(new Error('invalid_grant: Token has been expired or revoked.'))).toBe(true);
  });
  it('does not read an ordinary outage as a revoked grant', () => {
    expect(isInvalidGrant(new Error('backend error'))).toBe(false);
    expect(isInvalidGrant(null)).toBe(false);
  });
});

// ── The refresh token never leaves the server ────────────────────────────────

describe('publicConnection', () => {
  const stored = connectionFromDoc({
    connected: true,
    refreshToken: '1//super-secret-refresh-token',
    googleAccountEmail: 'auntie@tribetails.com',
    connectedAt: '2026-07-25T10:00:00.000Z',
    scopes: ['https://www.googleapis.com/auth/calendar.events'],
    writeCalendarId: 'work@group.calendar.google.com',
    enabledCalendarIds: ['work@group.calendar.google.com'],
    calendarPushLastRunAt: '2026-07-25T11:00:00.000Z',
    calendarPushLastStatus: 'ok',
    calendarPushLastImported: 4,
    calendarPushLastPushed: 4,
  });

  it('carries no token, under any key, at any depth', () => {
    const view = publicConnection(stored);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('super-secret-refresh-token');
    expect(Object.keys(view).some((k) => k.toLowerCase().includes('token'))).toBe(false);
  });

  it('still carries what the panel needs to describe the connection', () => {
    const view = publicConnection(stored);
    expect(view.connected).toBe(true);
    expect(view.googleAccountEmail).toBe('auntie@tribetails.com');
    expect(view.writeCalendarId).toBe('work@group.calendar.google.com');
    expect(view.calendarPushLastPushed).toBe(4);
  });
});

describe('connectionFromDoc', () => {
  it('refuses to report connected when no token is held', () => {
    // A doc claiming connected with no token is a disconnect that half-failed.
    // Reporting it as connected sends the operator hunting for a calendar fault.
    expect(connectionFromDoc({ connected: true, refreshToken: '' }).connected).toBe(false);
    expect(connectionFromDoc({ connected: true, refreshToken: '   ' }).connected).toBe(false);
    expect(connectionFromDoc({ connected: true, refreshToken: 'tok' }).connected).toBe(true);
  });

  it('reads a missing document as a clean disconnected state', () => {
    const doc = connectionFromDoc(undefined);
    expect(doc.connected).toBe(false);
    expect(doc.enabledCalendarIds).toEqual([]);
    expect(doc.calendarPushLastPushed).toBe(0);
  });
});

// ── Receipts, on success AND on failure ──────────────────────────────────────

describe('the stamps', () => {
  it('a failed connect is recorded with its cause, not left blank', () => {
    expect(connectStamp({ status: 'error', error: 'Access was declined.' }, 'now')).toEqual({
      connectLastAttemptAt: 'now',
      connectLastStatus: 'error',
      connectLastError: 'Access was declined.',
    });
  });

  it('a successful connect clears the previous cause', () => {
    expect(connectStamp({ status: 'ok' }, 'now').connectLastError).toBe('');
  });

  it('a failed push counts nothing pushed and keeps the reason', () => {
    expect(calendarPushStamp({ status: 'error', error: 'Google said no.' }, 'now')).toEqual({
      calendarPushLastRunAt: 'now',
      calendarPushLastStatus: 'error',
      calendarPushLastPushed: 0,
      calendarPushLastError: 'Google said no.',
    });
  });
});

// ── The write-target rule ────────────────────────────────────────────────────

describe('writeCalendarProblem', () => {
  const account = 'auntie@tribetails.com';

  it('allows primary, which the free/busy rule refuses', () => {
    // Under the service account `primary` is the robot's own empty calendar.
    // Under OAuth it is the operator's real one, so the two rules differ.
    expect(writeCalendarProblem(PRIMARY_CALENDAR_ID, '', account)).toBeNull();
    expect(writeCalendarProblem('work@group.calendar.google.com', '', account)).toBeNull();
  });

  it('refuses an empty pick and a string that is not a calendar id', () => {
    expect(writeCalendarProblem('', '', account)).not.toBeNull();
    expect(writeCalendarProblem('team-cal', '', account)).not.toBeNull();
  });

  it('refuses the calendar the free/busy sync imports from', () => {
    const problem = writeCalendarProblem(
      'shared@group.calendar.google.com',
      'shared@group.calendar.google.com',
      account,
    );
    expect(problem).not.toBeNull();
    expect(problem).toContain('blocked-out time');
  });

  it('catches the same calendar spelled two ways', () => {
    // The operator can share their OWN calendar with the free/busy service
    // account and then pick `primary` here. The strings differ, the calendar
    // does not, and the echo loop would be live.
    expect(writeCalendarProblem(PRIMARY_CALENDAR_ID, account, account)).not.toBeNull();
    expect(writeCalendarProblem('AUNTIE@Tribetails.com', account, account)).not.toBeNull();
  });

  it('resolves primary to the connected account, case-folded', () => {
    expect(resolveCalendarId('PRIMARY', 'Auntie@Tribetails.com')).toBe('auntie@tribetails.com');
    expect(resolveCalendarId(' Work@Group.Calendar.Google.com ', account)).toBe(
      'work@group.calendar.google.com',
    );
  });
});
