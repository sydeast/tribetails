import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import { runCalendarSync, storedCalendarSyncRun, type CalendarSyncReceiptFields } from './calendarSync';

const NEVER_RUN: CalendarSyncReceiptFields = {
  calendarSyncLastRunAt: '',
  calendarSyncLastStatus: '',
  calendarSyncLastImported: 0,
  calendarSyncLastError: '',
};

beforeEach(() => {
  call.mockReset();
});

describe('runCalendarSync', () => {
  it('calls the deployed callable by name with only a look-ahead window', async () => {
    call.mockResolvedValue({ imported: 2, scanned: 2, ranAt: '2026-07-25T10:00:00.000Z' });
    const res = await runCalendarSync();
    expect(call).toHaveBeenCalledWith('syncGoogleCalendarBusyEvents', { lookAheadDays: 30 });
    expect(res.imported).toBe(2);
  });

  it('NEVER sends a calendar id, so a client cannot aim the sync at another calendar', async () => {
    call.mockResolvedValue({ imported: 0, scanned: 0, ranAt: 'x' });
    await runCalendarSync(7);
    const payload = call.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(['lookAheadDays']);
    expect(payload.lookAheadDays).toBe(7);
  });

  it('lets the server error through untouched, because its text is the instructions', async () => {
    // The server names the exact service account, calendar id and share level.
    // Rewriting it into "Sync failed" would delete the only actionable part.
    const serverMessage =
      'calendar_not_shared: share calendar team@group.calendar.google.com with ' +
      'auntieos-admin-calendar-sync@auntieos-ttpc.iam.gserviceaccount.com at "See only free/busy (hide details)"';
    call.mockRejectedValue(new Error(serverMessage));
    await expect(runCalendarSync()).rejects.toThrow(serverMessage);
  });
});

describe('storedCalendarSyncRun', () => {
  it('is null when no run was ever stamped, which is not the same as a zero-import run', () => {
    expect(storedCalendarSyncRun(NEVER_RUN)).toBeNull();
  });

  it('reads a successful run off the settings doc', () => {
    expect(
      storedCalendarSyncRun({
        calendarSyncLastRunAt: '2026-07-25T10:00:00.000Z',
        calendarSyncLastStatus: 'ok',
        calendarSyncLastImported: 4,
        calendarSyncLastError: '',
      }),
    ).toEqual({ ranAt: '2026-07-25T10:00:00.000Z', status: 'ok', imported: 4, error: '' });
  });

  it('reads a failed run with its stored cause', () => {
    expect(
      storedCalendarSyncRun({
        calendarSyncLastRunAt: '2026-07-25T10:00:00.000Z',
        calendarSyncLastStatus: 'error',
        calendarSyncLastImported: 0,
        calendarSyncLastError: 'calendar_not_shared: ...',
      }),
    ).toEqual({
      ranAt: '2026-07-25T10:00:00.000Z',
      status: 'error',
      imported: 0,
      error: 'calendar_not_shared: ...',
    });
  });

  it('treats an unrecognized status as an error, never as a quiet success', () => {
    const run = storedCalendarSyncRun({
      calendarSyncLastRunAt: '2026-07-25T10:00:00.000Z',
      calendarSyncLastStatus: 'weird',
      calendarSyncLastImported: 9,
      calendarSyncLastError: '',
    });
    expect(run?.status).toBe('error');
  });
});
