import { describe, it, expect } from 'vitest';
import {
  calendarAutoSyncRunLabel,
  retryableSessionId,
  storedCalendarAutoSyncRun,
  type AutoSyncConnectionFields,
} from './calendarAutoSync';

const BLANK: AutoSyncConnectionFields = {
  calendarAutoSyncLastRunAt: '',
  calendarAutoSyncLastStatus: '',
  calendarAutoSyncLastAction: '',
  calendarAutoSyncLastSessionId: '',
  calendarAutoSyncLastError: '',
};

describe('storedCalendarAutoSyncRun', () => {
  it('is null before automatic sync has ever run', () => {
    expect(storedCalendarAutoSyncRun(BLANK)).toBeNull();
    expect(calendarAutoSyncRunLabel(null)).toBeNull();
  });

  it('reads a successful run', () => {
    const run = storedCalendarAutoSyncRun({
      ...BLANK,
      calendarAutoSyncLastRunAt: '2026-08-23T09:00:00.000Z',
      calendarAutoSyncLastStatus: 'ok',
      calendarAutoSyncLastAction: 'created',
      calendarAutoSyncLastSessionId: 'sess-1',
    });
    expect(run).toMatchObject({ status: 'ok', action: 'created', sessionId: 'sess-1', error: '' });
  });

  it('treats an UNREADABLE status as an error, never as a success', () => {
    // A receipt we cannot parse is not evidence anything worked, and reporting
    // it as a success is how a broken integration goes unnoticed.
    const run = storedCalendarAutoSyncRun({
      ...BLANK,
      calendarAutoSyncLastRunAt: '2026-08-23T09:00:00.000Z',
      calendarAutoSyncLastStatus: 'weird',
      calendarAutoSyncLastError: 'Google said no',
    });
    expect(run?.status).toBe('error');
    expect(run?.error).toBe('Google said no');
  });

  it('does not carry an action or an error over from the other status', () => {
    const failed = storedCalendarAutoSyncRun({
      ...BLANK,
      calendarAutoSyncLastRunAt: '2026-08-23T09:00:00.000Z',
      calendarAutoSyncLastStatus: 'error',
      calendarAutoSyncLastAction: 'created',
      calendarAutoSyncLastError: 'boom',
    });
    // A failed run that still claimed it "created" something would be a lie.
    expect(failed?.action).toBe('');

    const ok = storedCalendarAutoSyncRun({
      ...BLANK,
      calendarAutoSyncLastRunAt: '2026-08-23T09:00:00.000Z',
      calendarAutoSyncLastStatus: 'ok',
      calendarAutoSyncLastAction: 'updated',
      calendarAutoSyncLastError: 'a stale error from last time',
    });
    expect(ok?.error).toBe('');
  });
});

describe('calendarAutoSyncRunLabel', () => {
  function label(status: string, action: string, ranAt = '2026-08-23T09:00:00.000Z') {
    return calendarAutoSyncRunLabel(
      storedCalendarAutoSyncRun({
        ...BLANK,
        calendarAutoSyncLastRunAt: ranAt,
        calendarAutoSyncLastStatus: status,
        calendarAutoSyncLastAction: action,
      }),
    );
  }

  it('says what each action actually did, in the operator\'s words', () => {
    expect(label('ok', 'created')).toContain('put a visit on the calendar');
    expect(label('ok', 'updated')).toContain('moved a visit already on the calendar');
    expect(label('ok', 'deleted')).toContain('took a cancelled visit off the calendar');
    expect(label('ok', 'skipped')).toContain('found nothing to change');
  });

  it('REPORTS an action it does not recognise rather than guessing', () => {
    // Rendering an unknown action as "nothing to change" would be inventing
    // reassurance about a state nobody has seen.
    expect(label('ok', 'teleported')).toContain('unrecognised result (teleported)');
    expect(label('ok', '')).toContain('unrecognised result (blank)');
  });

  it('says a failure failed, without pretending to know what it did', () => {
    const text = label('error', 'created');
    expect(text).toContain('it failed');
    expect(text).not.toContain('put a visit');
  });

  it('survives an unreadable timestamp instead of rendering "Invalid Date"', () => {
    expect(label('ok', 'created', 'not-a-date')).toContain('at an unreadable time');
  });
});

describe('retryableSessionId', () => {
  function run(status: string, sessionId: string) {
    return storedCalendarAutoSyncRun({
      ...BLANK,
      calendarAutoSyncLastRunAt: '2026-08-23T09:00:00.000Z',
      calendarAutoSyncLastStatus: status,
      calendarAutoSyncLastSessionId: sessionId,
    });
  }

  it('offers a retry for a failed run that names a visit', () => {
    expect(retryableSessionId(run('error', 'sess-1'))).toBe('sess-1');
  });

  it('offers NO retry for a successful run', () => {
    expect(retryableSessionId(run('ok', 'sess-1'))).toBeNull();
  });

  it('offers NO retry for a failure that names no visit', () => {
    // That failure was about the connection, not one visit. A Retry button
    // there would rerun the same refusal and waste the operator's time on the
    // wrong fix.
    expect(retryableSessionId(run('error', ''))).toBeNull();
    expect(retryableSessionId(run('error', '   '))).toBeNull();
  });

  it('offers no retry before anything has run', () => {
    expect(retryableSessionId(null)).toBeNull();
  });
});
