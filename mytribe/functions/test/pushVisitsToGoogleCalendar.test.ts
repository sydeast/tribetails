import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  eventsInsert: vi.fn(),
  eventsUpdate: vi.fn(),
  eventsDelete: vi.fn(),
  logEventFn: vi.fn(),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('@googleapis/calendar', () => ({
  auth: { OAuth2: class { setCredentials() {} } },
  calendar: () => ({
    events: { insert: mocks.eventsInsert, update: mocks.eventsUpdate, delete: mocks.eventsDelete },
  }),
}));

import {
  pushVisitsToGoogleCalendarHandler,
  buildEventBody,
  clampLookAheadDays,
  isCancelled,
  resolveEndTime,
  sessionFromDoc,
} from '../src/admin/googleCalendar/pushVisitsToGoogleCalendar';

const ORIGINAL_ENV = { ...process.env };

function req(data: unknown = {}, uid: string | undefined = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } } as never) : undefined,
    rawRequest: {} as never,
  } as unknown as CallableRequest<unknown>;
}

const CONNECTED = {
  connected: true,
  refreshToken: '1//refresh-token-value',
  googleAccountEmail: 'auntie@tribetails.com',
  writeCalendarId: 'work@group.calendar.google.com',
  enabledCalendarIds: ['work@group.calendar.google.com'],
};

/** A visit far enough ahead to sit inside the default 30 day window. */
function futureIso(daysAhead: number, hour = 9): string {
  const d = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

function seed(
  sessions: Array<{ id: string; data: Record<string, unknown> }>,
  freeBusyCalendarId = '',
  connection: Record<string, unknown> = CONNECTED,
) {
  return buildDbMock({
    docs: { 'integrations_config/googleCalendar': connection },
    queryDocs: {
      kin_care_sessions: sessions,
      business_settings: [{ id: 'singleton', data: { calendarSyncId: freeBusyCalendarId } }],
    },
  });
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.eventsInsert.mockReset().mockResolvedValue({ data: { id: 'gcal-event-1' } });
  mocks.eventsUpdate.mockReset().mockResolvedValue({ data: { id: 'gcal-event-1' } });
  mocks.eventsDelete.mockReset().mockResolvedValue({});
  mocks.logEventFn.mockReset();
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-id-for-test';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'client-secret-for-test';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe('clampLookAheadDays', () => {
  it('matches the free/busy sync window rules exactly', () => {
    expect(clampLookAheadDays(undefined)).toBe(30);
    expect(clampLookAheadDays(0)).toBe(1);
    expect(clampLookAheadDays(1000)).toBe(90);
    expect(clampLookAheadDays(45.9)).toBe(45);
  });
});

describe('isCancelled', () => {
  it('does not care about casing, because no writer enforces it', () => {
    expect(isCancelled('CANCELLED')).toBe(true);
    expect(isCancelled(' cancelled ')).toBe(true);
    expect(isCancelled('Canceled')).toBe(true);
    expect(isCancelled('SCHEDULED')).toBe(false);
    expect(isCancelled(undefined)).toBe(false);
  });
});

describe('resolveEndTime', () => {
  const base = sessionFromDoc('s1', { startTime: '2026-08-01T09:00:00.000Z' });

  it('prefers a real end time', () => {
    expect(resolveEndTime({ ...base, endTime: '2026-08-01T10:30:00.000Z' })).toBe(
      '2026-08-01T10:30:00.000Z',
    );
  });

  it('falls back to the entered duration', () => {
    expect(resolveEndTime({ ...base, durationMinutes: 45 })).toBe('2026-08-01T09:45:00.000Z');
  });

  it('invents nothing when the visit says neither', () => {
    // An event claiming a length nobody entered blocks out time the operator
    // never agreed to.
    expect(resolveEndTime(base)).toBeNull();
    expect(resolveEndTime({ ...base, endTime: '2026-08-01T08:00:00.000Z' })).toBeNull();
  });
});

describe('buildEventBody', () => {
  it('carries the service, the visit id, and no household contact detail', () => {
    const session = sessionFromDoc('sess-9', {
      kinfolkId: 'kin-1',
      serviceType: 'Drop-in visit',
      startTime: '2026-08-01T09:00:00.000Z',
      notes: 'Back door key in lockbox',
    });
    const body = buildEventBody(session, '2026-08-01T10:00:00.000Z');
    expect(body.summary).toBe('Drop-in visit for kin-1');
    expect(body.description).toContain('Visit sess-9');
    expect(body.extendedProperties.private.tribetailsSessionId).toBe('sess-9');
    expect(body.end.dateTime).toBe('2026-08-01T10:00:00.000Z');
  });
});

// ── The callable ─────────────────────────────────────────────────────────────

describe('pushVisitsToGoogleCalendar', () => {
  it('creates an event for a visit that has none, and records the id back', async () => {
    const { db, writes } = seed([
      { id: 'sess-1', data: { startTime: futureIso(3), endTime: futureIso(3, 10), status: 'SCHEDULED', serviceType: 'Walk' } },
    ]);
    mocks.dbFn.mockReturnValue(db);

    const result = await pushVisitsToGoogleCalendarHandler(req());

    expect(result.pushed).toBe(1);
    expect(mocks.eventsInsert).toHaveBeenCalledTimes(1);
    const back = writes.find((w) => w.path === 'kin_care_sessions/sess-1');
    expect(back?.data).toMatchObject({
      googleEventId: 'gcal-event-1',
      googleCalendarSource: 'AUNTIEOS_PUSH',
    });
  });

  it('updates in place rather than duplicating a visit already on the calendar', async () => {
    const { db } = seed([
      {
        id: 'sess-1',
        data: {
          startTime: futureIso(3),
          endTime: futureIso(3, 10),
          status: 'SCHEDULED',
          googleEventId: 'gcal-event-1',
        },
      },
    ]);
    mocks.dbFn.mockReturnValue(db);

    const result = await pushVisitsToGoogleCalendarHandler(req());

    expect(result.pushed).toBe(1);
    expect(mocks.eventsInsert).not.toHaveBeenCalled();
    expect(mocks.eventsUpdate).toHaveBeenCalledTimes(1);
  });

  it('takes a cancelled visit OFF the calendar', async () => {
    // Leaving it there is worse than never having written it: the operator plans
    // their day from that calendar.
    const { db, writes } = seed([
      {
        id: 'sess-1',
        data: { startTime: futureIso(3), endTime: futureIso(3, 10), status: 'cancelled', googleEventId: 'gcal-event-1' },
      },
    ]);
    mocks.dbFn.mockReturnValue(db);

    const result = await pushVisitsToGoogleCalendarHandler(req());

    expect(result.removed).toBe(1);
    expect(result.pushed).toBe(0);
    expect(mocks.eventsDelete).toHaveBeenCalledTimes(1);
    expect(writes.find((w) => w.path === 'kin_care_sessions/sess-1')?.data.googleEventId).toBe('');
  });

  it('skips a visit with no honest length and NAMES it', async () => {
    const { db } = seed([{ id: 'sess-1', data: { startTime: futureIso(3), status: 'SCHEDULED' } }]);
    mocks.dbFn.mockReturnValue(db);

    const result = await pushVisitsToGoogleCalendarHandler(req());

    expect(result.pushed).toBe(0);
    expect(result.skipped).toEqual([
      { sessionId: 'sess-1', reason: expect.stringContaining('no duration') },
    ]);
    expect(mocks.eventsInsert).not.toHaveBeenCalled();
  });

  it('recovers from an event the operator deleted in Google', async () => {
    const { db, writes } = seed([
      {
        id: 'sess-1',
        data: { startTime: futureIso(3), endTime: futureIso(3, 10), status: 'SCHEDULED', googleEventId: 'gone' },
      },
    ]);
    mocks.dbFn.mockReturnValue(db);
    mocks.eventsUpdate.mockRejectedValue({ code: 404, message: 'Not Found' });

    const result = await pushVisitsToGoogleCalendarHandler(req());

    // Clearing the stale id lets the NEXT run recreate it, rather than failing
    // forever against an id Google has forgotten.
    expect(writes.find((w) => w.path === 'kin_care_sessions/sess-1')?.data.googleEventId).toBe('');
    expect(result.skipped[0].reason).toContain('recreated');
  });

  it('REFUSES to write into the calendar the free/busy sync imports from', async () => {
    // Every pushed visit would come back as a BLOCKED slot over its own hour.
    const { db } = seed(
      [{ id: 'sess-1', data: { startTime: futureIso(3), endTime: futureIso(3, 10), status: 'SCHEDULED' } }],
      'work@group.calendar.google.com',
    );
    mocks.dbFn.mockReturnValue(db);

    await expect(pushVisitsToGoogleCalendarHandler(req())).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: 'write_calendar_invalid' },
    });
    expect(mocks.eventsInsert).not.toHaveBeenCalled();
  });

  it('refuses with the not-connected code when nothing is connected', async () => {
    const { db } = seed([], '', { connected: false });
    mocks.dbFn.mockReturnValue(db);
    await expect(pushVisitsToGoogleCalendarHandler(req())).rejects.toMatchObject({
      details: { code: 'google_calendar_not_connected' },
    });
  });

  it('reports a revoked grant as its own state', async () => {
    const { db } = seed([
      { id: 'sess-1', data: { startTime: futureIso(3), endTime: futureIso(3, 10), status: 'SCHEDULED' } },
    ]);
    mocks.dbFn.mockReturnValue(db);
    mocks.eventsInsert.mockRejectedValue(new Error('invalid_grant: Token has been expired or revoked.'));

    await expect(pushVisitsToGoogleCalendarHandler(req())).rejects.toMatchObject({
      details: { code: 'google_oauth_revoked' },
    });
  });

  it('stamps a receipt on SUCCESS', async () => {
    const { db, writes } = seed([
      { id: 'sess-1', data: { startTime: futureIso(3), endTime: futureIso(3, 10), status: 'SCHEDULED' } },
    ]);
    mocks.dbFn.mockReturnValue(db);

    const result = await pushVisitsToGoogleCalendarHandler(req());

    const stamp = writes.filter((w) => w.path === 'integrations_config/googleCalendar').pop();
    expect(stamp?.data).toMatchObject({
      calendarPushLastStatus: 'ok',
      calendarPushLastPushed: 1,
      calendarPushLastError: '',
    });
    expect(result.ranAt).toBe(stamp?.data.calendarPushLastRunAt);
  });

  it('stamps a receipt on FAILURE, then rethrows the real error', async () => {
    // A run that broke and a run that never happened look identical after a
    // reload, and the operator presses the button again to find out which.
    const { db, writes } = seed([
      { id: 'sess-1', data: { startTime: futureIso(3), endTime: futureIso(3, 10), status: 'SCHEDULED' } },
    ]);
    mocks.dbFn.mockReturnValue(db);
    mocks.eventsInsert.mockRejectedValue(new Error('Google said no.'));

    await expect(pushVisitsToGoogleCalendarHandler(req())).rejects.toThrow('Google said no.');

    const stamp = writes.filter((w) => w.path === 'integrations_config/googleCalendar').pop();
    expect(stamp?.data).toMatchObject({
      calendarPushLastStatus: 'error',
      calendarPushLastPushed: 0,
      calendarPushLastError: 'Google said no.',
    });
  });

  it('refuses an unknown request field rather than ignoring it', async () => {
    const { db } = seed([]);
    mocks.dbFn.mockReturnValue(db);
    await expect(
      pushVisitsToGoogleCalendarHandler(req({ calendarId: 'someone-elses@group.calendar.google.com' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});
