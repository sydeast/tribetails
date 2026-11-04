import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CALENDAR_ID_ENV,
  ENV_NAMES,
  GOOGLE_OAUTH_SCOPES,
  REFRESH_TOKEN_ENV,
  googleCalendarConnectionSeed,
  missingCalendarEnv,
} from '../../e2e/googleCalendarConnectionSeed.ts';
import { VENDOR_EXTRA_ENV, disconnectRisks } from './preflight.mjs';

/**
 * The connection document the calendar spec seeds (#1517). What matters: it
 * is the shape the functions read, it is built from the two variables the
 * preflight tracks and no others, it refuses to point at the account's own
 * calendar, and the spec that uses it cannot trip the preflight's refusal.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ADMIN_DIR = join(HERE, '..', '..');

const ENV = {
  [REFRESH_TOKEN_ENV]: '1//0e2e-refresh-token',
  [CALENDAR_ID_ENV]: 'abc123@group.calendar.google.com',
};
const INPUT = { env: ENV, connectedByUid: 'uid-1', googleAccountEmail: 'e2e-admin@tribetails.com', nowIso: '2026-11-04T16:00:00.000Z' };

describe('googleCalendarConnectionSeed', () => {
  it('builds the connected document the push reads: token, the test calendar as both targets, both scopes, every receipt empty', () => {
    const doc = googleCalendarConnectionSeed(INPUT);
    expect(doc.connected).toBe(true);
    expect(doc.refreshToken).toBe('1//0e2e-refresh-token');
    expect(doc.writeCalendarId).toBe('abc123@group.calendar.google.com');
    expect(doc.enabledCalendarIds).toEqual(['abc123@group.calendar.google.com']);
    expect(doc.scopes).toEqual([
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.readonly',
    ]);
    expect(doc.connectedAt).toBe('2026-11-04T16:00:00.000Z');
    expect(doc.connectedByUid).toBe('uid-1');
    expect(doc.googleAccountEmail).toBe('e2e-admin@tribetails.com');
    expect(doc.connectLastStatus).toBe('ok');
    // The panel reads "No visits have been sent to this calendar yet." off an
    // empty calendarPushLastRunAt; the spec asserts that line before it presses Push.
    expect(doc.calendarPushLastRunAt).toBe('');
    expect(doc.calendarPushLastStatus).toBe('');
    expect(doc.calendarPushLastPushed).toBe(0);
    expect(doc.calendarPushLastError).toBe('');
    expect(doc.calendarAutoSyncLastRunAt).toBe('');
    expect(doc.disconnectedAt).toBe('');
  });

  it('writes every field of the stored shape, as the functions declare it', () => {
    // Read off the functions' own interface so a field added there is caught here.
    const src = readFileSync(join(ADMIN_DIR, '..', 'mytribe', 'functions', 'src', 'lib', 'googleCalendarConnection.ts'), 'utf8');
    const block = src.match(/export interface GoogleCalendarConnectionDoc \{([\s\S]*?)\n\}/)?.[1];
    expect(block, 'GoogleCalendarConnectionDoc in googleCalendarConnection.ts').toBeTruthy();
    const declared = [...block.matchAll(/^\s+(\w+):/gm)].map((m) => m[1]).sort();
    expect(Object.keys(googleCalendarConnectionSeed(INPUT)).sort()).toEqual(declared);
  });

  it('asks for exactly the scopes the OAuth lib asks for', () => {
    const src = readFileSync(join(ADMIN_DIR, '..', 'mytribe', 'functions', 'src', 'lib', 'googleOAuth.ts'), 'utf8');
    const block = src.match(/export const GOOGLE_OAUTH_SCOPES = \[([\s\S]*?)\];/)?.[1];
    expect(block, 'GOOGLE_OAUTH_SCOPES in googleOAuth.ts').toBeTruthy();
    const declared = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect([...GOOGLE_OAUTH_SCOPES]).toEqual(declared);
  });

  it('reads the two variables the preflight tracks as the vendor extras, and no others', () => {
    expect([...ENV_NAMES]).toEqual(VENDOR_EXTRA_ENV.googleCalendar);
    expect(missingCalendarEnv({})).toEqual([REFRESH_TOKEN_ENV, CALENDAR_ID_ENV]);
    expect(missingCalendarEnv({ [REFRESH_TOKEN_ENV]: 'x', [CALENDAR_ID_ENV]: ' ' })).toEqual([CALENDAR_ID_ENV]);
    expect(missingCalendarEnv(ENV)).toEqual([]);
  });

  it('refuses, naming them, when either variable is unset', () => {
    expect(() => googleCalendarConnectionSeed({ ...INPUT, env: {} })).toThrow(
      /E2E_GOOGLE_CALENDAR_REFRESH_TOKEN and E2E_GOOGLE_CALENDAR_ID must be set/,
    );
    expect(() => googleCalendarConnectionSeed({ ...INPUT, env: { [REFRESH_TOKEN_ENV]: 'x' } })).toThrow(
      /E2E_GOOGLE_CALENDAR_ID must be set/,
    );
  });

  it("refuses primary, the account's own calendar, and anything that is not a calendar id", () => {
    expect(() => googleCalendarConnectionSeed({ ...INPUT, env: { ...ENV, [CALENDAR_ID_ENV]: 'primary' } })).toThrow(
      /E2E_GOOGLE_CALENDAR_ID is "primary"/,
    );
    expect(() => googleCalendarConnectionSeed({ ...INPUT, env: { ...ENV, [CALENDAR_ID_ENV]: 'Primary' } })).toThrow(/"primary"/);
    for (const bad of ['auntieos-test', 'no-at.calendar.google.com', 'two@at@signs.com', 'has space@group.calendar.google.com']) {
      expect(() => googleCalendarConnectionSeed({ ...INPUT, env: { ...ENV, [CALENDAR_ID_ENV]: bad } }), bad).toThrow(
        /is not a Google Calendar id/,
      );
    }
  });

  it('refuses a token that picked up whitespace', () => {
    expect(() => googleCalendarConnectionSeed({ ...INPUT, env: { ...ENV, [REFRESH_TOKEN_ENV]: '1//0e2e refresh' } })).toThrow(
      /contains whitespace/,
    );
  });
});

describe('the real-suite spec directory', () => {
  it('names neither the Google Calendar revoke callable nor its control, so the preflight does not refuse the run', () => {
    expect(disconnectRisks(join(ADMIN_DIR, 'cypress', 'e2e-real'))).toEqual([]);
  });
});
