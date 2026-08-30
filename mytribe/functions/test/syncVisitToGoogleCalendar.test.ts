import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

/**
 * The per-visit sync callable (issue #397): the retry path for a visit the
 * lifecycle trigger could not write, and the manual path for one the operator
 * wants on the calendar now.
 *
 * NOTHING HERE TALKS TO GOOGLE. `@googleapis/calendar` is mocked at the module
 * level, which works only because `lib/googleOAuth.ts` reaches the SDK through
 * `await import()` rather than a bare in-function `require()` — a require
 * escapes Vitest's module graph and silently loads the real client. That is
 * documented at the import site and is the reason this file can assert what was
 * sent to `events.insert` without a network.
 */

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

import { syncVisitToGoogleCalendarHandler } from '../src/admin/googleCalendar/syncVisitToGoogleCalendar';

const ORIGINAL_ENV = { ...process.env };

function req(data: unknown = { sessionId: 'sess-1' }) {
  return {
    data,
    auth: { uid: 'admin1', token: { admin: true } } as never,
    rawRequest: {} as never,
  } as unknown as CallableRequest<unknown>;
}

/** A caller with no `auth` at all. Kept separate from `req` because a default
 * parameter cannot express "explicitly signed out": passing `undefined` for the
 * uid re-applies the default and silently produces a SIGNED-IN request, which
 * is how a sign-in test passes while asserting nothing. */
function anonReq(data: unknown = { sessionId: 'sess-1' }) {
  return { data, auth: undefined, rawRequest: {} as never } as unknown as CallableRequest<unknown>;
}

const CONNECTED = {
  connected: true,
  refreshToken: '1//refresh-token-value',
  googleAccountEmail: 'auntie@tribetails.com',
  writeCalendarId: 'work@group.calendar.google.com',
  enabledCalendarIds: ['work@group.calendar.google.com'],
};

function futureIso(daysAhead: number, hour = 9): string {
  const d = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

function seed(
  session: Record<string, unknown> | null,
  connection: Record<string, unknown> | null = CONNECTED,
  freeBusyCalendarId = '',
) {
  return buildDbMock({
    docs: {
      'integrations_config/googleCalendar': connection,
      'kin_care_sessions/sess-1': session,
    },
    queryDocs: {
      business_settings: [{ id: 'singleton', data: { calendarSyncId: freeBusyCalendarId } }],
    },
  });
}

const LIVE_VISIT = {
  startTime: futureIso(3),
  endTime: futureIso(3, 10),
  status: 'SCHEDULED',
  serviceType: 'Dog walk',
  kinfolkId: 'kin-7',
};

describe('syncVisitToGoogleCalendar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GOOGLE_OAUTH_CLIENT_ID = '1234567890-test.apps.googleusercontent.com';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'client-secret-for-test';
    mocks.eventsInsert.mockResolvedValue({ data: { id: 'gcal-event-1' } });
    mocks.eventsUpdate.mockResolvedValue({ data: { id: 'gcal-event-1' } });
    mocks.eventsDelete.mockResolvedValue({});
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('CREATES an event for a visit that has never been on the calendar', async () => {
    const { db, writes } = seed({ ...LIVE_VISIT });
    mocks.dbFn.mockReturnValue(db);

    const result = await syncVisitToGoogleCalendarHandler(req());

    expect(result.action).toBe('created');
    expect(result.eventId).toBe('gcal-event-1');
    expect(mocks.eventsInsert).toHaveBeenCalledTimes(1);
    const body = mocks.eventsInsert.mock.calls[0][0];
    expect(body.calendarId).toBe('work@group.calendar.google.com');
    expect(body.requestBody.summary).toBe('Dog walk for kin-7');
    // The belt to the stored id's braces: an event with no stored id can still
    // be recognised as ours instead of being duplicated.
    expect(body.requestBody.extendedProperties.private.tribetailsSessionId).toBe('sess-1');
    const write = writes.find((w) => w.path === 'kin_care_sessions/sess-1');
    expect(write?.data.googleEventId).toBe('gcal-event-1');
    expect(write?.data.googleCalendarSyncStatus).toBe('ok');
  });

  it('UPDATES in place when the visit already has an event, never creating a second one', async () => {
    const { db } = seed({ ...LIVE_VISIT, googleEventId: 'gcal-event-1' });
    mocks.dbFn.mockReturnValue(db);

    const result = await syncVisitToGoogleCalendarHandler(req());

    expect(result.action).toBe('updated');
    expect(mocks.eventsUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.eventsUpdate.mock.calls[0][0].eventId).toBe('gcal-event-1');
    // The whole point of an idempotent retry: pressing it twice must not leave
    // the household with two calendar entries for one visit.
    expect(mocks.eventsInsert).not.toHaveBeenCalled();
  });

  it('DELETES the event when the visit is cancelled, and forgets the id', async () => {
    const { db, writes } = seed({
      ...LIVE_VISIT,
      status: 'CANCELLED',
      googleEventId: 'gcal-event-1',
    });
    mocks.dbFn.mockReturnValue(db);

    const result = await syncVisitToGoogleCalendarHandler(req());

    expect(result.action).toBe('deleted');
    expect(mocks.eventsDelete).toHaveBeenCalledWith({
      calendarId: 'work@group.calendar.google.com',
      eventId: 'gcal-event-1',
    });
    expect(writes.find((w) => w.path === 'kin_care_sessions/sess-1')?.data.googleEventId).toBe('');
  });

  it('treats a lowercase cancellation as a cancellation (status casing is unenforced)', async () => {
    const { db } = seed({ ...LIVE_VISIT, status: 'canceled', googleEventId: 'gcal-event-1' });
    mocks.dbFn.mockReturnValue(db);

    const result = await syncVisitToGoogleCalendarHandler(req());

    expect(result.action).toBe('deleted');
  });

  it('SKIPS a visit with no honest length rather than inventing an hour', async () => {
    const { db } = seed({ startTime: futureIso(3), status: 'SCHEDULED' });
    mocks.dbFn.mockReturnValue(db);

    const result = await syncVisitToGoogleCalendarHandler(req());

    expect(result.action).toBe('skipped');
    expect(result.reason).toContain('no duration');
    expect(mocks.eventsInsert).not.toHaveBeenCalled();
  });

  it('reports CONSENT REVOKED with the code both panels branch on, and does not retry', async () => {
    const { db } = seed({ ...LIVE_VISIT });
    mocks.dbFn.mockReturnValue(db);
    mocks.eventsInsert.mockRejectedValue({
      message: 'invalid_grant',
      response: { data: { error: 'invalid_grant' } },
    });

    await expect(syncVisitToGoogleCalendarHandler(req())).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: 'google_oauth_revoked' },
    });
    // Retrying a revoked grant never succeeds; only reconnecting does.
    expect(mocks.eventsInsert).toHaveBeenCalledTimes(1);
  });

  it('STAMPS the failure onto the visit before rethrowing, so it outlives the request', async () => {
    const { db, writes } = seed({ ...LIVE_VISIT });
    mocks.dbFn.mockReturnValue(db);
    mocks.eventsInsert.mockRejectedValue(new Error('Google said no'));

    await expect(syncVisitToGoogleCalendarHandler(req())).rejects.toThrow('Google said no');

    const write = writes.find((w) => w.path === 'kin_care_sessions/sess-1');
    expect(write?.data.googleCalendarSyncStatus).toBe('error');
    expect(write?.data.googleCalendarSyncError).toBe('Google said no');
    // A failure must NOT disturb the stored event id: clearing it would make
    // the next retry create a duplicate.
    expect(write?.data).not.toHaveProperty('googleEventId');
  });

  it('recreates an event the operator deleted in Google instead of failing on a dead id', async () => {
    const { db, writes } = seed({ ...LIVE_VISIT, googleEventId: 'gone' });
    mocks.dbFn.mockReturnValue(db);
    mocks.eventsUpdate.mockRejectedValue({ code: 404, message: 'Not Found' });

    const result = await syncVisitToGoogleCalendarHandler(req());

    expect(result.action).toBe('created');
    expect(writes.find((w) => w.path === 'kin_care_sessions/sess-1')?.data.googleEventId).toBe(
      'gcal-event-1',
    );
  });

  it('treats an already-deleted event as success, because that is the state we wanted', async () => {
    const { db } = seed({ ...LIVE_VISIT, status: 'CANCELLED', googleEventId: 'gone' });
    mocks.dbFn.mockReturnValue(db);
    mocks.eventsDelete.mockRejectedValue({ code: 410, message: 'Gone' });

    const result = await syncVisitToGoogleCalendarHandler(req());

    expect(result.action).toBe('deleted');
  });

  it('refuses when nothing is connected, with the code the panels branch on', async () => {
    const { db } = seed({ ...LIVE_VISIT }, null);
    mocks.dbFn.mockReturnValue(db);

    await expect(syncVisitToGoogleCalendarHandler(req())).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: 'google_calendar_not_connected' },
    });
    expect(mocks.eventsInsert).not.toHaveBeenCalled();
  });

  it('REFUSES to write into the calendar the free/busy sync imports from', async () => {
    // Every visit written there would come straight back as a BLOCKED slot over
    // its own hour, and freebusy.query carries nothing that could break the loop.
    const { db } = seed({ ...LIVE_VISIT }, CONNECTED, 'work@group.calendar.google.com');
    mocks.dbFn.mockReturnValue(db);

    await expect(syncVisitToGoogleCalendarHandler(req())).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: 'write_calendar_invalid' },
    });
  });

  it('rejects a missing, blank or non-string sessionId before touching Firestore', async () => {
    const { db } = seed({ ...LIVE_VISIT });
    mocks.dbFn.mockReturnValue(db);

    for (const bad of [{}, { sessionId: '' }, { sessionId: '   ' }, { sessionId: 7 }, { sessionId: 'a', extra: 1 }]) {
      await expect(syncVisitToGoogleCalendarHandler(req(bad))).rejects.toMatchObject({
        code: 'invalid-argument',
      });
    }
    expect(mocks.eventsInsert).not.toHaveBeenCalled();
  });

  it('requires sign-in', async () => {
    const { db } = seed({ ...LIVE_VISIT });
    mocks.dbFn.mockReturnValue(db);

    await expect(syncVisitToGoogleCalendarHandler(anonReq())).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('is a no-op, not an error, for a visit that no longer exists', async () => {
    const { db } = seed(null);
    mocks.dbFn.mockReturnValue(db);

    const result = await syncVisitToGoogleCalendarHandler(req());

    expect(result.action).toBe('skipped');
    expect(result.reason).toContain('no longer exists');
  });
});
