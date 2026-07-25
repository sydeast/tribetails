import { describe, it, expect } from 'vitest';
import { CALENDAR_SYNC_SA_EMAIL, calendarIdProblem, calendarSyncRunLabel } from './calendarSyncId';

/**
 * The five `calendarIdProblem` cases below are asserted verbatim by the two
 * other copies of this rule: `mytribe/functions/test/callableContract.test.ts`
 * (which is the enforcing copy) and android's `CalendarSyncIdTest.kt`. If this
 * file is edited, those two go with it in the same change.
 */

describe('calendarIdProblem', () => {
  it('accepts the two shapes Google actually issues', () => {
    expect(calendarIdProblem('abc123@group.calendar.google.com')).toBeNull();
    expect(calendarIdProblem('auntie@tribetails.com')).toBeNull();
  });

  it('trims before judging, so a pasted id with stray spaces is not rejected', () => {
    expect(calendarIdProblem('  abc@group.calendar.google.com  ')).toBeNull();
  });

  it('refuses "primary", the one wrong value that is a legal calendar id', () => {
    // It names the service account's OWN calendar, which is permanently empty,
    // so it would sync successfully forever and import nothing.
    expect(calendarIdProblem('primary')).toContain('always empty');
    expect(calendarIdProblem('PRIMARY')).not.toBeNull();
  });

  it('refuses anything not address-shaped and shows what a real one looks like', () => {
    for (const bad of ['team calendar', 'team-cal@group', 'group.calendar.google.com', 'a@b']) {
      const msg = calendarIdProblem(bad);
      expect(msg, `${bad} must be refused`).not.toBeNull();
      expect(msg).toContain('name@group.calendar.google.com');
    }
  });

  it('says WHY a typo matters: it would read as an empty calendar', () => {
    expect(calendarIdProblem('team-cal')).toContain('import nothing');
  });

  it('refuses blank as "not entered yet", not as a typo', () => {
    expect(calendarIdProblem('')).toContain('Enter the shared');
    expect(calendarIdProblem('   ')).toContain('Enter the shared');
  });

  it('quotes the offending value back, so the operator can see the typo', () => {
    expect(calendarIdProblem('team-cal')).toContain('"team-cal"');
  });

  it('does NOT try to be a spell checker: an address-shaped id it cannot verify passes', () => {
    // Whether the service account can actually SEE this calendar is Google's
    // answer to give, and the sync reports it as `notFound`. A text field
    // guessing at domains would refuse legitimate ids.
    expect(calendarIdProblem('teem@group.calendar.googl')).toBeNull();
  });
});

describe('CALENDAR_SYNC_SA_EMAIL', () => {
  it('matches the account the callable names in its own error messages', () => {
    // Frozen server-side in callableContract.test.ts. An operator told to share
    // with a different address than the one the server checks shares it with
    // nobody, and the sync fails with a message naming the right one.
    expect(CALENDAR_SYNC_SA_EMAIL).toBe(
      'auntieos-admin-calendar-sync@auntieos-ttpc.iam.gserviceaccount.com',
    );
  });
});

describe('calendarSyncRunLabel', () => {
  it('is null when nothing has ever run, so the panel can say so in its own words', () => {
    expect(calendarSyncRunLabel(null)).toBeNull();
  });

  it('reports the count of a successful run', () => {
    const label = calendarSyncRunLabel({
      ranAt: '2026-07-25T14:30:00.000Z',
      status: 'ok',
      imported: 3,
      error: '',
    });
    expect(label).toContain('Imported 3 busy blocks.');
    expect(label).toContain('Last run');
  });

  it('says an empty window blocked nothing out, rather than "Imported 0"', () => {
    // "Imported 0 busy blocks" reads as a shrug. Naming the outcome is what
    // tells the operator the run worked and the calendar was simply clear.
    expect(
      calendarSyncRunLabel({ ranAt: '2026-07-25T14:30:00.000Z', status: 'ok', imported: 0, error: '' }),
    ).toContain('nothing was blocked out');
  });

  it('singularizes one block', () => {
    expect(
      calendarSyncRunLabel({ ranAt: '2026-07-25T14:30:00.000Z', status: 'ok', imported: 1, error: '' }),
    ).toContain('Imported 1 busy block.');
  });

  it('says a failed run failed, and never quotes a count for it', () => {
    const label = calendarSyncRunLabel({
      ranAt: '2026-07-25T14:30:00.000Z',
      status: 'error',
      imported: 0,
      error: 'calendar_not_shared: ...',
    });
    expect(label).toContain('it failed');
    expect(label).not.toContain('Imported');
  });

  it('still reports the outcome when the timestamp is unreadable', () => {
    // A hand-edited or legacy stamp must not delete the fact that a run failed.
    const label = calendarSyncRunLabel({
      ranAt: 'not-a-date',
      status: 'error',
      imported: 0,
      error: 'x',
    });
    expect(label).toContain('unreadable time');
    expect(label).toContain('it failed');
  });
});

