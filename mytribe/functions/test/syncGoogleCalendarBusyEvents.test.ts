import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest, HttpsError } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  freebusyQuery: vi.fn(),
  calendarIdValue: vi.fn(() => 'team-cal@group.calendar.google.com'),
  logEventFn: vi.fn(),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));
vi.mock('../src/lib/writeAuditEntry', () => ({
  writeAuditEntry: vi.fn().mockResolvedValue('audit-1'),
}));
// `GOOGLE_CALENDAR_ID.value()` is wired to a controllable mock so tests can
// toggle the configured / not-configured branches.
vi.mock('firebase-functions/params', () => ({
  defineSecret: () => ({ value: mocks.calendarIdValue }),
}));
vi.mock('googleapis', () => ({
  google: {
    auth: { GoogleAuth: class { constructor() {} } },
    calendar: () => ({ freebusy: { query: mocks.freebusyQuery } }),
  },
}));

import {
  syncGoogleCalendarBusyEventsHandler,
  busyIntervalToSlot,
  calendarSyncStamp,
  clampLookAheadDays,
  pickCalendarIdFromDocs,
  calendarFreebusyErrorMessage,
  CALENDAR_SYNC_SA_EMAIL,
  SettingsDocLike,
} from '../src/admin/syncGoogleCalendarBusyEvents';
import { calendarIdProblem, CALENDAR_ID_INVALID_CODE } from '../src/lib/calendarSyncId';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

function req(data: unknown = {}, uid: string | undefined = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } as any } as any) : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.freebusyQuery.mockReset();
  mocks.calendarIdValue.mockReset().mockReturnValue('team-cal@group.calendar.google.com');
  mocks.logEventFn.mockReset();
  (writeAuditEntry as any).mockClear();
});

// ── Pure helpers (unit) ──────────────────────────────────────────────────────

describe('clampLookAheadDays', () => {
  it('defaults to 30 when undefined or non-finite', () => {
    expect(clampLookAheadDays(undefined)).toBe(30);
    expect(clampLookAheadDays(NaN)).toBe(30);
  });
  it('clamps to 1..90 and truncates', () => {
    expect(clampLookAheadDays(0)).toBe(1);
    expect(clampLookAheadDays(-5)).toBe(1);
    expect(clampLookAheadDays(1000)).toBe(90);
    expect(clampLookAheadDays(45.9)).toBe(45);
  });
});

describe('busyIntervalToSlot', () => {
  it('maps a busy interval to the BLOCKED slot schema', () => {
    const slot = busyIntervalToSlot(
      { start: '2026-06-10T14:00:00.000Z', end: '2026-06-10T15:30:00.000Z' },
      'cal-x',
      '2026-06-04T00:00:00.000Z',
    );
    expect(slot.date).toBe('2026-06-10');
    expect(slot.startTime).toBe('14:00');
    expect(slot.endTime).toBe('15:30');
    expect(slot.isAvailable).toBe(false);
    expect(slot.slotType).toBe('BLOCKED');
    expect(slot.source).toBe('GOOGLE_BUSY_IMPORT');
    expect(slot.hideDetailsFromKinfolk).toBe(true);
    expect(slot.syncState).toBe('SYNCED');
  });
  it('derives a stable externalEventId from calendar + epoch bounds', () => {
    const a = busyIntervalToSlot(
      { start: '2026-06-10T14:00:00.000Z', end: '2026-06-10T15:00:00.000Z' },
      'cal-x',
      'now',
    );
    const b = busyIntervalToSlot(
      { start: '2026-06-10T14:00:00.000Z', end: '2026-06-10T15:00:00.000Z' },
      'cal-x',
      'later',
    );
    expect(a.externalEventId).toBe(b.externalEventId);
    expect(a.externalEventId.startsWith('busy_cal-x_')).toBe(true);
  });
});

describe('calendarFreebusyErrorMessage', () => {
  it('notFound: names the SA + calId and flags the typo / wrong-address case', () => {
    const msg = calendarFreebusyErrorMessage('typo-cal@group.calendar.google.com', ['notFound']);
    expect(msg).toContain(CALENDAR_SYNC_SA_EMAIL);
    expect(msg).toContain('typo-cal@group.calendar.google.com');
    expect(msg).toContain('notFound');
  });
  it('other reason: still names the SA + calId with the reason surfaced', () => {
    const msg = calendarFreebusyErrorMessage('cal-x', ['rateLimitExceeded']);
    expect(msg).toContain('rateLimitExceeded');
    expect(msg).toContain(CALENDAR_SYNC_SA_EMAIL);
    expect(msg).toContain('cal-x');
  });
  it('empty reasons: falls back to unknown but still names the SA', () => {
    const msg = calendarFreebusyErrorMessage('cal-x', []);
    expect(msg).toContain('unknown');
    expect(msg).toContain(CALENDAR_SYNC_SA_EMAIL);
  });
});

// ── Calendar id resolution (pure unit) ───────────────────────────────────────

function settingsDoc(id: string, calendarSyncId?: unknown): SettingsDocLike {
  return { id, data: () => (calendarSyncId === undefined ? {} : { calendarSyncId }) };
}

describe('pickCalendarIdFromDocs', () => {
  it('picks calendarSyncId (trimmed) from a settings doc when present, with its doc id', () => {
    const docs = [settingsDoc('business_settings', '  ui-cal@group.calendar.google.com  ')];
    expect(pickCalendarIdFromDocs(docs)).toEqual({
      docId: 'business_settings',
      calendarId: 'ui-cal@group.calendar.google.com',
    });
  });

  it('returns undefined when no doc carries a value', () => {
    const docs = [settingsDoc('business_settings'), settingsDoc('admin_settings', '')];
    expect(pickCalendarIdFromDocs(docs)).toBeUndefined();
  });

  it('returns undefined when nothing is configured', () => {
    expect(pickCalendarIdFromDocs([settingsDoc('business_settings', '   ')])).toBeUndefined();
    expect(pickCalendarIdFromDocs([])).toBeUndefined();
  });

  it('ignores the feature_flags doc and empty/whitespace calendarSyncId', () => {
    const docs = [
      settingsDoc('feature_flags', 'flags-cal-should-be-ignored'),
      settingsDoc('admin_settings', '   '),
      settingsDoc('business_settings', 'real-cal'),
    ];
    expect(pickCalendarIdFromDocs(docs)).toEqual({
      docId: 'business_settings',
      calendarId: 'real-cal',
    });
  });

  it('ignores a non-string calendarSyncId', () => {
    const docs = [settingsDoc('business_settings', 12345)];
    expect(pickCalendarIdFromDocs(docs)).toBeUndefined();
  });
});

// ── Calendar id shape (pure unit) ────────────────────────────────────────────

describe('calendarIdProblem', () => {
  it('accepts the two shapes Google actually issues', () => {
    expect(calendarIdProblem('abc123@group.calendar.google.com')).toBeNull();
    expect(calendarIdProblem('  auntie@tribetails.com  ')).toBeNull();
  });

  it('refuses "primary", which is the SA\'s own permanently empty calendar', () => {
    const msg = calendarIdProblem('primary');
    expect(msg).toContain('always empty');
    // Case is not a way around it.
    expect(calendarIdProblem('PRIMARY')).not.toBeNull();
  });

  it('refuses anything not address-shaped, naming what a real one looks like', () => {
    for (const bad of ['team calendar', 'team-cal@group', 'group.calendar.google.com', 'a@b']) {
      const msg = calendarIdProblem(bad);
      expect(msg, `${bad} must be refused`).not.toBeNull();
      expect(msg).toContain('name@group.calendar.google.com');
    }
  });

  it('says a typo would look like an empty calendar, which is the whole point', () => {
    expect(calendarIdProblem('team-cal')).toContain('import nothing');
  });

  it('refuses blank without pretending it is a typo', () => {
    expect(calendarIdProblem('   ')).toContain('Enter the shared');
  });
});

describe('calendarSyncStamp', () => {
  it('records an ok run with its count and no error text', () => {
    expect(calendarSyncStamp({ status: 'ok', imported: 4 }, '2026-07-25T10:00:00.000Z')).toEqual({
      calendarSyncLastRunAt: '2026-07-25T10:00:00.000Z',
      calendarSyncLastStatus: 'ok',
      calendarSyncLastImported: 4,
      calendarSyncLastError: '',
    });
  });
  it('records a failed run with its cause and a zero count, never the last good count', () => {
    expect(
      calendarSyncStamp({ status: 'error', error: 'calendar_not_shared: ...' }, '2026-07-25T10:00:00.000Z'),
    ).toEqual({
      calendarSyncLastRunAt: '2026-07-25T10:00:00.000Z',
      calendarSyncLastStatus: 'error',
      calendarSyncLastImported: 0,
      calendarSyncLastError: 'calendar_not_shared: ...',
    });
  });
});

// ── Handler (integration) ────────────────────────────────────────────────────

describe('syncGoogleCalendarBusyEvents handler', () => {
  it('HAPPY: imports two busy intervals + writes one audit entry', async () => {
    const ctx = buildDbMock({
      queryDocs: {
        business_settings: [
          { id: 'business_settings', data: { calendarSyncId: 'team-cal@group.calendar.google.com' } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.freebusyQuery.mockResolvedValue({
      data: {
        calendars: {
          'team-cal@group.calendar.google.com': {
            busy: [
              { start: '2026-06-10T14:00:00.000Z', end: '2026-06-10T15:00:00.000Z' },
              { start: '2026-06-11T09:00:00.000Z', end: '2026-06-11T10:00:00.000Z' },
            ],
          },
        },
      },
    });

    const res = await syncGoogleCalendarBusyEventsHandler(req({ lookAheadDays: 14 }));
    expect(res).toMatchObject({ imported: 2, scanned: 2 });
    expect(Number.isNaN(Date.parse(res.ranAt))).toBe(false);

    const slotWrites = ctx.writes.filter((w) => w.path.startsWith('booking_time_slots/'));
    expect(slotWrites).toHaveLength(2);
    expect(slotWrites[0].data.source).toBe('GOOGLE_BUSY_IMPORT');
    expect(slotWrites[0].data.hideDetailsFromKinfolk).toBe(true);
    expect(slotWrites[0].merge).toBe(true);

    expect((writeAuditEntry as any).mock.calls).toHaveLength(1);
    const audit = (writeAuditEntry as any).mock.calls[0][0];
    expect(audit.event).toBe('INTEGRATION_CALENDAR_SYNC');
    expect(audit.payload.count).toBe(2);
  });

  it('NEGATIVE: empty busy array imports 0 and writes no slots', async () => {
    const ctx = buildDbMock({
      queryDocs: {
        business_settings: [
          { id: 'business_settings', data: { calendarSyncId: 'team-cal@group.calendar.google.com' } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.freebusyQuery.mockResolvedValue({
      data: { calendars: { 'team-cal@group.calendar.google.com': { busy: [] } } },
    });

    const res = await syncGoogleCalendarBusyEventsHandler(req());
    expect(res).toMatchObject({ imported: 0, scanned: 0 });
    expect(ctx.writes.filter((w) => w.path.startsWith('booking_time_slots/'))).toHaveLength(0);
  });

  it('DEDUP: existing externalEventId merges onto the same doc, not a new one', async () => {
    // The dedup lookup is `.where('externalEventId','==',slot.externalEventId)`,
    // and that id is derived from the calendar id plus the busy interval's
    // epoch bounds. The fixture has to carry that exact value or real Firestore
    // returns nothing and the handler mints a new doc.
    const existingEventId = `busy_team-cal@group.calendar.google.com_${Date.parse(
      '2026-06-10T14:00:00.000Z',
    )}_${Date.parse('2026-06-10T15:00:00.000Z')}`;
    const ctx = buildDbMock({
      queryDocs: {
        booking_time_slots: [
          { id: 'existing-slot-1', data: { externalEventId: existingEventId } },
        ],
        business_settings: [
          { id: 'business_settings', data: { calendarSyncId: 'team-cal@group.calendar.google.com' } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.freebusyQuery.mockResolvedValue({
      data: {
        calendars: {
          'team-cal@group.calendar.google.com': {
            busy: [{ start: '2026-06-10T14:00:00.000Z', end: '2026-06-10T15:00:00.000Z' }],
          },
        },
      },
    });

    const res = await syncGoogleCalendarBusyEventsHandler(req());
    expect(res.imported).toBe(1);
    const slotWrites = ctx.writes.filter((w) => w.path.startsWith('booking_time_slots/'));
    expect(slotWrites).toHaveLength(1);
    expect(slotWrites[0].path).toBe('booking_time_slots/existing-slot-1');
  });

  it('UI VALUE: queries the calendarSyncId from the business_settings doc', async () => {
    const ctx = buildDbMock({
      queryDocs: {
        business_settings: [
          { id: 'feature_flags', data: { calendarSyncId: 'flags-should-be-ignored' } },
          { id: 'business_settings', data: { calendarSyncId: '  ui-cal@group.calendar.google.com  ' } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.freebusyQuery.mockResolvedValue({
      data: {
        calendars: {
          'ui-cal@group.calendar.google.com': {
            busy: [{ start: '2026-06-10T14:00:00.000Z', end: '2026-06-10T15:00:00.000Z' }],
          },
        },
      },
    });

    const res = await syncGoogleCalendarBusyEventsHandler(req());
    expect(res).toMatchObject({ imported: 1, scanned: 1 });
    const queryArg = mocks.freebusyQuery.mock.calls[0][0];
    expect(queryArg.requestBody.items).toEqual([
      { id: 'ui-cal@group.calendar.google.com' },
    ]);
    const slotWrites = ctx.writes.filter((w) => w.path.startsWith('booking_time_slots/'));
    expect(slotWrites[0].data.externalCalendarId).toBe('ui-cal@group.calendar.google.com');
  });

  it('SAD: no UI calendarSyncId throws failed-precondition', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        queryDocs: {
          business_settings: [{ id: 'feature_flags', data: { calendarSyncId: 'ignored' } }],
        },
      }).db,
    );
    await expect(syncGoogleCalendarBusyEventsHandler(req())).rejects.toMatchObject({
      code: 'failed-precondition',
      message: 'calendar_id_not_configured',
    });
  });

  it('ERROR: freebusy 403 fails loud naming the sync service account', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        queryDocs: {
          business_settings: [
            { id: 'business_settings', data: { calendarSyncId: 'team-cal@group.calendar.google.com' } },
          ],
        },
      }).db,
    );
    mocks.freebusyQuery.mockRejectedValue({ code: 403, message: 'forbidden' });
    let thrown: unknown;
    try {
      await syncGoogleCalendarBusyEventsHandler(req());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(HttpsError);
    expect((thrown as HttpsError).code).toBe('permission-denied');
    expect((thrown as HttpsError).message).toContain(CALENDAR_SYNC_SA_EMAIL);
  });

  it('ERROR: per-calendar errors array (notFound) fails loud, names the SA + calId, calls out the typo, and logs the reason', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        queryDocs: {
          business_settings: [
            { id: 'business_settings', data: { calendarSyncId: 'team-cal@group.calendar.google.com' } },
          ],
        },
      }).db,
    );
    mocks.freebusyQuery.mockResolvedValue({
      data: {
        calendars: {
          'team-cal@group.calendar.google.com': {
            errors: [{ domain: 'global', reason: 'notFound' }],
            busy: [],
          },
        },
      },
    });
    let thrown: unknown;
    try {
      await syncGoogleCalendarBusyEventsHandler(req());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(HttpsError);
    expect((thrown as HttpsError).code).toBe('permission-denied');
    const msg = (thrown as HttpsError).message;
    expect(msg).toContain(CALENDAR_SYNC_SA_EMAIL);
    expect(msg).toContain('team-cal@group.calendar.google.com');
    expect(msg).toContain('notFound');
    // the raw per-calendar error + reason is logged for the operator.
    const errLog = mocks.logEventFn.mock.calls
      .map((c) => c[0])
      .find((a: any) => a?.event === 'gcal.freebusy.calendar_error');
    expect(errLog).toBeTruthy();
    expect(errLog.extra.calendarId).toBe('team-cal@group.calendar.google.com');
    expect(errLog.extra.reasons).toEqual(['notFound']);
  });

  it('RECEIPT: a successful run stamps when/ok/count onto the settings doc it read the id from', async () => {
    const ctx = buildDbMock({
      queryDocs: {
        business_settings: [
          { id: 'business_settings', data: { calendarSyncId: 'team-cal@group.calendar.google.com' } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.freebusyQuery.mockResolvedValue({
      data: {
        calendars: {
          'team-cal@group.calendar.google.com': {
            busy: [{ start: '2026-06-10T14:00:00.000Z', end: '2026-06-10T15:00:00.000Z' }],
          },
        },
      },
    });

    const res = await syncGoogleCalendarBusyEventsHandler(req());
    const stamped = ctx.writes.find((w) => w.path === 'business_settings/business_settings');
    expect(stamped).toBeTruthy();
    expect(stamped!.merge).toBe(true);
    expect(stamped!.data.calendarSyncLastStatus).toBe('ok');
    expect(stamped!.data.calendarSyncLastImported).toBe(1);
    expect(stamped!.data.calendarSyncLastError).toBe('');
    // The response carries the same timestamp, so a client renders the receipt
    // without a second read.
    expect(stamped!.data.calendarSyncLastRunAt).toBe(res.ranAt);
  });

  it('RECEIPT: a FAILED run is stamped with its cause, so the panel still says so after a reload', async () => {
    const ctx = buildDbMock({
      queryDocs: {
        business_settings: [
          { id: 'business_settings', data: { calendarSyncId: 'team-cal@group.calendar.google.com' } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.freebusyQuery.mockRejectedValue({ code: 403, message: 'forbidden' });

    await expect(syncGoogleCalendarBusyEventsHandler(req())).rejects.toBeInstanceOf(HttpsError);
    const stamped = ctx.writes.find((w) => w.path === 'business_settings/business_settings');
    expect(stamped).toBeTruthy();
    expect(stamped!.data.calendarSyncLastStatus).toBe('error');
    expect(stamped!.data.calendarSyncLastImported).toBe(0);
    expect(stamped!.data.calendarSyncLastError).toContain(CALENDAR_SYNC_SA_EMAIL);
  });

  it('BAD ID: a mistyped calendar id is refused BEFORE the Google call, not reported as an empty calendar', async () => {
    const ctx = buildDbMock({
      queryDocs: {
        business_settings: [{ id: 'business_settings', data: { calendarSyncId: 'team-cal' } }],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    let thrown: unknown;
    try {
      await syncGoogleCalendarBusyEventsHandler(req());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(HttpsError);
    expect((thrown as HttpsError).code).toBe('failed-precondition');
    expect((thrown as HttpsError).details).toEqual({ code: CALENDAR_ID_INVALID_CODE });
    // The whole point: Google was never asked, so there is no empty answer to
    // mistake for a clear calendar, and no busy slot was written.
    expect(mocks.freebusyQuery).not.toHaveBeenCalled();
    expect(ctx.writes.filter((w) => w.path.startsWith('booking_time_slots/'))).toHaveLength(0);
    const stamped = ctx.writes.find((w) => w.path === 'business_settings/business_settings');
    expect(stamped!.data.calendarSyncLastStatus).toBe('error');
  });

  it('BAD ID: "primary" is refused too, since it would sync forever and import nothing', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        queryDocs: {
          business_settings: [{ id: 'business_settings', data: { calendarSyncId: 'primary' } }],
        },
      }).db,
    );
    await expect(syncGoogleCalendarBusyEventsHandler(req())).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: CALENDAR_ID_INVALID_CODE },
    });
    expect(mocks.freebusyQuery).not.toHaveBeenCalled();
  });

  it('ERROR: other googleapis failure surfaces unavailable', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        queryDocs: {
          business_settings: [
            { id: 'business_settings', data: { calendarSyncId: 'team-cal@group.calendar.google.com' } },
          ],
        },
      }).db,
    );
    mocks.freebusyQuery.mockRejectedValue({ code: 500, message: 'boom' });
    await expect(syncGoogleCalendarBusyEventsHandler(req())).rejects.toMatchObject({
      code: 'unavailable',
    });
  });
});
