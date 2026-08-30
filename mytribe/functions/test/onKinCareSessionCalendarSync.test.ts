import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * The lifecycle trigger (issue #397): a confirmed visit appears on the
 * operator's Google calendar, a rescheduled one moves, a cancelled one comes
 * off, without anyone pressing anything.
 *
 * The four gates are what this file is really about, because each one is a
 * hazard the feature spent a year refusing to be built over:
 *   1. nothing connected            → not a single Google call
 *   2. no calendar chosen yet       → not a single Google call (this is consent)
 *   3. nothing calendar-shaped moved → not a single Google call (cost control)
 *   4. the sync's own write-back     → not a single Google call (the loop guard)
 *
 * Gate 4 is the one that costs money if it is wrong, so it is asserted against
 * the real `SESSION_SYNC_FIELDS` list rather than a copy typed out here.
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
vi.mock('@googleapis/calendar', () => ({
  auth: { OAuth2: class { setCredentials() {} } },
  calendar: () => ({
    events: { insert: mocks.eventsInsert, update: mocks.eventsUpdate, delete: mocks.eventsDelete },
  }),
}));

import { onKinCareSessionCalendarSyncHandler } from '../src/triggers/onKinCareSessionCalendarSync';
import {
  CALENDAR_RELEVANT_FIELDS,
  SESSION_SYNC_FIELDS,
} from '../src/lib/googleCalendarVisitSync';

const ORIGINAL_ENV = { ...process.env };
const CONNECTION_PATH = 'integrations_config/googleCalendar';
const SESSION_PATH = 'kin_care_sessions/sess-1';

const CONNECTED = {
  connected: true,
  refreshToken: '1//refresh-token-value',
  googleAccountEmail: 'auntie@tribetails.com',
  writeCalendarId: 'work@group.calendar.google.com',
};

function futureIso(daysAhead: number, hour = 9): string {
  const d = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

const LIVE_VISIT: Record<string, unknown> = {
  startTime: futureIso(3),
  endTime: futureIso(3, 10),
  status: 'SCHEDULED',
  serviceType: 'Dog walk',
  kinfolkId: 'kin-7',
};

/**
 * Seeds Firestore. `stored` is what the trigger will READ back off the session
 * document, which is not always the same object as the event's `after`: the
 * real trigger re-reads the row rather than trusting the snapshot it was handed.
 */
function seed(
  stored: Record<string, unknown> | null,
  connection: Record<string, unknown> | null = CONNECTED,
  freeBusyCalendarId = '',
) {
  return buildDbMock({
    docs: { [CONNECTION_PATH]: connection, [SESSION_PATH]: stored },
    queryDocs: {
      business_settings: [{ id: 'singleton', data: { calendarSyncId: freeBusyCalendarId } }],
    },
  });
}

/** A `Change<DocumentSnapshot>` shaped just enough for the handler. */
function event(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
) {
  const snap = (data: Record<string, unknown> | undefined) =>
    data === undefined ? { exists: false, data: () => undefined } : { exists: true, data: () => data };
  return {
    params: { sessionId: 'sess-1' },
    data: { before: snap(before), after: snap(after) },
  } as never;
}

function connectionWrites(writes: Array<{ path: string; data: Record<string, unknown> }>) {
  return writes.filter((w) => w.path === CONNECTION_PATH).map((w) => w.data);
}

function noGoogleCall() {
  expect(mocks.eventsInsert).not.toHaveBeenCalled();
  expect(mocks.eventsUpdate).not.toHaveBeenCalled();
  expect(mocks.eventsDelete).not.toHaveBeenCalled();
}

describe('onKinCareSessionCalendarSync', () => {
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

  describe('the visit lifecycle produces the matching calendar operation', () => {
    it('CONFIRMING a visit creates the event', async () => {
      // What `manageBookingSeries` / `batchUpdateBookings` leave behind when an
      // operator approves a booking request: the mirrored row turns SCHEDULED.
      const { db, writes } = seed({ ...LIVE_VISIT });
      mocks.dbFn.mockReturnValue(db);

      await onKinCareSessionCalendarSyncHandler(
        event({ ...LIVE_VISIT, status: 'PENDING' }, { ...LIVE_VISIT }),
      );

      expect(mocks.eventsInsert).toHaveBeenCalledTimes(1);
      expect(mocks.eventsInsert.mock.calls[0][0].requestBody.summary).toBe('Dog walk for kin-7');
      expect(connectionWrites(writes)[0]).toMatchObject({
        calendarAutoSyncLastStatus: 'ok',
        calendarAutoSyncLastAction: 'created',
        calendarAutoSyncLastSessionId: 'sess-1',
      });
    });

    it('RESCHEDULING a visit moves the event rather than making a second one', async () => {
      const moved = { ...LIVE_VISIT, startTime: futureIso(5), endTime: futureIso(5, 10) };
      const { db } = seed({ ...moved, googleEventId: 'gcal-event-1' });
      mocks.dbFn.mockReturnValue(db);

      await onKinCareSessionCalendarSyncHandler(
        event({ ...LIVE_VISIT, googleEventId: 'gcal-event-1' }, { ...moved, googleEventId: 'gcal-event-1' }),
      );

      expect(mocks.eventsUpdate).toHaveBeenCalledTimes(1);
      expect(mocks.eventsUpdate.mock.calls[0][0].eventId).toBe('gcal-event-1');
      expect(mocks.eventsUpdate.mock.calls[0][0].requestBody.start.dateTime).toBe(moved.startTime);
      expect(mocks.eventsInsert).not.toHaveBeenCalled();
    });

    it('CANCELLING a visit deletes the event', async () => {
      const cancelled = { ...LIVE_VISIT, status: 'CANCELLED', googleEventId: 'gcal-event-1' };
      const { db, writes } = seed(cancelled);
      mocks.dbFn.mockReturnValue(db);

      await onKinCareSessionCalendarSyncHandler(
        event({ ...LIVE_VISIT, googleEventId: 'gcal-event-1' }, cancelled),
      );

      expect(mocks.eventsDelete).toHaveBeenCalledWith({
        calendarId: 'work@group.calendar.google.com',
        eventId: 'gcal-event-1',
      });
      expect(writes.find((w) => w.path === SESSION_PATH)?.data.googleEventId).toBe('');
    });

    it('HARD-DELETING the visit row deletes the event, using the id off the deleted snapshot', async () => {
      // There is no document left to read the event id from, and none to stamp.
      const { db } = seed(null);
      mocks.dbFn.mockReturnValue(db);

      await onKinCareSessionCalendarSyncHandler(
        event({ ...LIVE_VISIT, googleEventId: 'gcal-event-1' }, undefined),
      );

      expect(mocks.eventsDelete).toHaveBeenCalledWith({
        calendarId: 'work@group.calendar.google.com',
        eventId: 'gcal-event-1',
      });
    });

    it('does nothing for a hard-deleted visit that was never on the calendar', async () => {
      const { db } = seed(null);
      mocks.dbFn.mockReturnValue(db);

      await onKinCareSessionCalendarSyncHandler(event({ ...LIVE_VISIT }, undefined));

      noGoogleCall();
    });
  });

  describe('the gates', () => {
    it('gate 1: nothing connected means no Google call at all', async () => {
      const { db } = seed({ ...LIVE_VISIT }, null);
      mocks.dbFn.mockReturnValue(db);

      await onKinCareSessionCalendarSyncHandler(event({ ...LIVE_VISIT, status: 'PENDING' }, { ...LIVE_VISIT }));

      noGoogleCall();
    });

    it('gate 2: connected but NO CALENDAR CHOSEN writes nothing — picking one is the consent', async () => {
      const { db } = seed({ ...LIVE_VISIT }, { ...CONNECTED, writeCalendarId: '' });
      mocks.dbFn.mockReturnValue(db);

      await onKinCareSessionCalendarSyncHandler(event({ ...LIVE_VISIT, status: 'PENDING' }, { ...LIVE_VISIT }));

      noGoogleCall();
    });

    it('gate 3: a write that touches nothing calendar-shaped costs no Google call', async () => {
      const { db } = seed({ ...LIVE_VISIT });
      mocks.dbFn.mockReturnValue(db);

      await onKinCareSessionCalendarSyncHandler(
        event({ ...LIVE_VISIT }, { ...LIVE_VISIT, invoiceId: 'inv-9', doNotInvoice: true }),
      );

      noGoogleCall();
    });

    it('gate 4 THE LOOP GUARD: the sync\'s own write-back does not re-trigger a sync', async () => {
      // Every field this function writes back onto the row it watches. If any
      // one of them counted as a change, the write-back would trigger another
      // sync, which would write back again — an unbounded loop, billed per
      // invocation and discovered on the invoice rather than in a test.
      const after = { ...LIVE_VISIT };
      for (const field of SESSION_SYNC_FIELDS) {
        (after as Record<string, unknown>)[field] = 'written-by-the-sync';
      }
      const { db } = seed(after);
      mocks.dbFn.mockReturnValue(db);

      await onKinCareSessionCalendarSyncHandler(event({ ...LIVE_VISIT }, after));

      noGoogleCall();
    });

    it('no field is in both the relevant list and the write-back list', () => {
      // The structural half of gate 4: the loop guard holds only while these
      // two sets stay disjoint, and a future field added to one of them is
      // exactly the change that would break it silently.
      const overlap = CALENDAR_RELEVANT_FIELDS.filter((f) =>
        (SESSION_SYNC_FIELDS as readonly string[]).includes(f),
      );
      expect(overlap).toEqual([]);
    });

    it('every field an event is made of DOES trigger a sync', async () => {
      // A CHANGED-BUT-STILL-VALID value per field, deliberately. An earlier
      // version of this test set every field to the string 'changed', and
      // `startTime: 'changed'` is unparseable, so the visit was correctly
      // SKIPPED for having no honest length and the test read that as the
      // relevance gate blocking it. The gate and the decision table are two
      // different things; this asserts only the first, so the fixture must not
      // trip the second.
      const validChange: Record<string, unknown> = {
        // Still BEFORE the fixture's 10:00 end. Moving the start past the end
        // would leave no honest length, which is a skip, not a gate.
        startTime: futureIso(3, 8),
        endTime: futureIso(3, 14),
        serviceDurationMinutes: 45,
        status: 'CONFIRMED',
        serviceType: 'Overnight sit',
        notes: 'Gate at the side of the house.',
        kinfolkId: 'kin-99',
      };

      for (const field of CALENDAR_RELEVANT_FIELDS) {
        vi.clearAllMocks();
        mocks.eventsUpdate.mockResolvedValue({ data: { id: 'gcal-event-1' } });
        const after = {
          ...LIVE_VISIT,
          googleEventId: 'gcal-event-1',
          [field]: validChange[field],
        };
        const { db } = seed(after);
        mocks.dbFn.mockReturnValue(db);

        await onKinCareSessionCalendarSyncHandler(
          event({ ...LIVE_VISIT, googleEventId: 'gcal-event-1' }, after),
        );

        // Named in the assertion so a failure says WHICH field stopped moving
        // the calendar, rather than just "expected 1, got 0".
        const calls = mocks.eventsUpdate.mock.calls.length;
        expect(`${field}:${calls}`).toBe(`${field}:1`);
      }
    });
  });

  describe('failure is written down, never thrown', () => {
    it('CONSENT REVOKED is stamped where all three panels already look', async () => {
      const { db, writes } = seed({ ...LIVE_VISIT });
      mocks.dbFn.mockReturnValue(db);
      mocks.eventsInsert.mockRejectedValue({
        message: 'invalid_grant',
        response: { data: { error: 'invalid_grant' } },
      });

      // Must NOT reject: a rethrow makes Firestore retry, and a revoked grant
      // never comes back, so the retry would burn quota forever.
      await expect(
        onKinCareSessionCalendarSyncHandler(event({ ...LIVE_VISIT, status: 'PENDING' }, { ...LIVE_VISIT })),
      ).resolves.toBeUndefined();

      const stamp = connectionWrites(writes).at(-1);
      expect(stamp?.calendarAutoSyncLastStatus).toBe('error');
      expect(String(stamp?.calendarAutoSyncLastError)).toContain('Connect Google Calendar again');
    });

    it('a transient Google failure is stamped on BOTH the visit and the connection', async () => {
      const { db, writes } = seed({ ...LIVE_VISIT });
      mocks.dbFn.mockReturnValue(db);
      mocks.eventsInsert.mockRejectedValue(new Error('backendError'));

      await expect(
        onKinCareSessionCalendarSyncHandler(event({ ...LIVE_VISIT, status: 'PENDING' }, { ...LIVE_VISIT })),
      ).resolves.toBeUndefined();

      // The visit says which visit is wrong; the connection says the operator
      // has a problem at all. Neither alone is enough.
      expect(writes.find((w) => w.path === SESSION_PATH)?.data).toMatchObject({
        googleCalendarSyncStatus: 'error',
        googleCalendarSyncError: 'backendError',
      });
      expect(connectionWrites(writes).at(-1)).toMatchObject({
        calendarAutoSyncLastStatus: 'error',
        calendarAutoSyncLastSessionId: 'sess-1',
      });
    });

    it('a failed sync never rethrows, so Firestore cannot retry one visit into four events', async () => {
      const { db } = seed({ ...LIVE_VISIT });
      mocks.dbFn.mockReturnValue(db);
      mocks.eventsInsert.mockRejectedValue(new Error('timeout'));

      await expect(
        onKinCareSessionCalendarSyncHandler(event({ ...LIVE_VISIT, status: 'PENDING' }, { ...LIVE_VISIT })),
      ).resolves.toBeUndefined();
      expect(mocks.eventsInsert).toHaveBeenCalledTimes(1);
    });

    it('REFUSES the echo-loop calendar and says so, without calling Google', async () => {
      // The operator can point the free/busy sync at the write calendar AFTER
      // connecting, and this path has no human in it to notice.
      const { db, writes } = seed({ ...LIVE_VISIT }, CONNECTED, 'work@group.calendar.google.com');
      mocks.dbFn.mockReturnValue(db);

      await onKinCareSessionCalendarSyncHandler(event({ ...LIVE_VISIT, status: 'PENDING' }, { ...LIVE_VISIT }));

      noGoogleCall();
      expect(String(connectionWrites(writes).at(-1)?.calendarAutoSyncLastError)).toContain(
        'free/busy sync already imports from',
      );
    });
  });
});
