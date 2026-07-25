import { describe, it, expect } from 'vitest';
import {
  GOOGLE_OAUTH_REDIRECT_URI,
  GOOGLE_OAUTH_SECRET_NAMES,
  PRIMARY_CALENDAR_ID,
  calendarPushRunLabel,
  canWriteToCalendar,
  resolveCalendarId,
  storedCalendarPushRun,
  writeCalendarProblem,
} from './googleCalendarTargets';

/**
 * These are the SAME six cases `mytribe/functions/test/callableContract.test.ts`
 * freezes and `GoogleCalendarTargetsTest.kt` asserts. A rule that drifts looser
 * than the server blocks a legal calendar in the picker; drifting tighter lets
 * one through to a server rejection the operator was not warned about.
 */
describe('writeCalendarProblem', () => {
  const account = 'auntie@tribetails.com';

  it('allows primary, which the free/busy rule refuses', () => {
    // Under the free/busy service account `primary` is the robot's own empty
    // calendar. Under OAuth it is the operator's real one.
    expect(writeCalendarProblem(PRIMARY_CALENDAR_ID, '', account)).toBeNull();
  });

  it('allows a shared calendar id', () => {
    expect(writeCalendarProblem('work@group.calendar.google.com', '', account)).toBeNull();
  });

  it('refuses an empty pick', () => {
    expect(writeCalendarProblem('', '', account)).not.toBeNull();
  });

  it('refuses a string that is not a calendar id', () => {
    expect(writeCalendarProblem('team-cal', '', account)).not.toBeNull();
  });

  it('refuses the calendar the free/busy sync imports from', () => {
    const problem = writeCalendarProblem(
      'shared@group.calendar.google.com',
      'shared@group.calendar.google.com',
      account,
    );
    expect(problem).toContain('same hour');
  });

  it('refuses primary when primary IS the free/busy calendar', () => {
    // One calendar, two spellings. The strings differ, the echo loop does not.
    expect(writeCalendarProblem(PRIMARY_CALENDAR_ID, account, account)).not.toBeNull();
  });
});

describe('resolveCalendarId', () => {
  it('folds case, because Google treats calendar ids as addresses', () => {
    expect(resolveCalendarId('PRIMARY', 'Auntie@Tribetails.com')).toBe('auntie@tribetails.com');
    expect(resolveCalendarId(' Work@Group.Calendar.Google.com ', 'a@b.com')).toBe(
      'work@group.calendar.google.com',
    );
  });
});

describe('canWriteToCalendar', () => {
  it('is true only for the two roles Google lets take an event', () => {
    expect(canWriteToCalendar('owner')).toBe(true);
    expect(canWriteToCalendar('writer')).toBe(true);
    expect(canWriteToCalendar('reader')).toBe(false);
    expect(canWriteToCalendar('freeBusyReader')).toBe(false);
  });
});

describe('storedCalendarPushRun', () => {
  const NEVER = {
    calendarPushLastRunAt: '',
    calendarPushLastStatus: '',
    calendarPushLastPushed: 0,
    calendarPushLastError: '',
  };

  it('is null when nothing was ever pushed, which is not a zero-push run', () => {
    expect(storedCalendarPushRun(NEVER)).toBeNull();
  });

  it('reads an unrecognized status as a failure, not a success', () => {
    // A receipt we cannot parse is not evidence a push worked.
    const run = storedCalendarPushRun({
      ...NEVER,
      calendarPushLastRunAt: '2026-07-25T10:00:00.000Z',
      calendarPushLastStatus: 'weird',
      calendarPushLastPushed: 9,
      calendarPushLastError: 'something',
    });
    expect(run?.status).toBe('error');
    expect(run?.pushed).toBe(0);
  });
});

describe('calendarPushRunLabel', () => {
  it('says nothing at all when nothing has ever run', () => {
    expect(calendarPushRunLabel(null)).toBeNull();
  });

  it('separates a push that sent nothing from a push that failed', () => {
    const zero = calendarPushRunLabel({ ranAt: '2026-07-25T10:00:00.000Z', status: 'ok', pushed: 0, error: '' });
    const failed = calendarPushRunLabel({ ranAt: '2026-07-25T10:00:00.000Z', status: 'error', pushed: 0, error: 'x' });
    expect(zero).toContain('Nothing needed sending');
    expect(failed).toContain('failed');
  });

  it('counts one visit in the singular', () => {
    expect(
      calendarPushRunLabel({ ranAt: '2026-07-25T10:00:00.000Z', status: 'ok', pushed: 1, error: '' }),
    ).toContain('1 visit.');
  });

  it('survives a stamp it cannot parse without losing the fact that a push happened', () => {
    expect(calendarPushRunLabel({ ranAt: 'not-a-date', status: 'ok', pushed: 2, error: '' })).toContain(
      'unreadable time',
    );
  });
});

describe('the operator-typed setup strings', () => {
  it('match what the server freezes, character for character', () => {
    // Google refuses the whole flow on a redirect URI that differs by a slash,
    // and a secret set under a name nothing reads does nothing at all.
    expect(GOOGLE_OAUTH_SECRET_NAMES).toEqual([
      'GOOGLE_OAUTH_CLIENT_ID',
      'GOOGLE_OAUTH_CLIENT_SECRET',
    ]);
    expect(GOOGLE_OAUTH_REDIRECT_URI).toBe(
      'https://us-central1-auntieos-ttpc.cloudfunctions.net/googleOAuthCallback',
    );
  });
});
