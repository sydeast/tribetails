import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  calendarListList: vi.fn(),
  revokeToken: vi.fn(),
  logEventFn: vi.fn(),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials() {}
        revokeToken = mocks.revokeToken;
      },
    },
    calendar: () => ({ calendarList: { list: mocks.calendarListList } }),
  },
}));

import {
  listGoogleCalendarsHandler,
  setGoogleCalendarTargetsHandler,
  toCalendarSummaries,
  canWriteToCalendar,
} from '../src/admin/googleCalendar/googleCalendarSelection';
import {
  getGoogleCalendarConnectionHandler,
  disconnectGoogleCalendarHandler,
  readFreeBusyCalendarId,
  MANUAL_REVOKE_HINT,
} from '../src/admin/googleCalendar/googleCalendarAccount';

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
  connectedAt: '2026-07-25T10:00:00.000Z',
  scopes: ['https://www.googleapis.com/auth/calendar.events'],
  writeCalendarId: '',
  enabledCalendarIds: [],
};

/** Settings docs as they really are: the doc id is not consistent across clients. */
function settingsDocs(calendarSyncId: string) {
  return {
    business_settings: [
      { id: 'feature_flags', data: { calendarSyncId: 'ignored@group.calendar.google.com' } },
      { id: 'singleton', data: { calendarSyncId } },
    ],
  };
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.calendarListList.mockReset();
  mocks.revokeToken.mockReset();
  mocks.logEventFn.mockReset();
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-id-for-test';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'client-secret-for-test';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('readFreeBusyCalendarId', () => {
  it('scans the collection and skips feature_flags, because the doc id varies by client', async () => {
    const { db } = buildDbMock({ queryDocs: settingsDocs('shared@group.calendar.google.com') });
    expect(await readFreeBusyCalendarId(db)).toBe('shared@group.calendar.google.com');
  });

  it('reads an unset free/busy calendar as empty rather than failing', async () => {
    const { db } = buildDbMock({ queryDocs: { business_settings: [{ id: 'singleton', data: {} }] } });
    expect(await readFreeBusyCalendarId(db)).toBe('');
  });
});

describe('getGoogleCalendarConnection', () => {
  it('answers with the projection that has no token in it', async () => {
    const { db } = buildDbMock({
      docs: { 'integrations_config/googleCalendar': CONNECTED },
      queryDocs: settingsDocs('shared@group.calendar.google.com'),
    });
    mocks.dbFn.mockReturnValue(db);

    const result = await getGoogleCalendarConnectionHandler(req());

    expect(JSON.stringify(result)).not.toContain('refresh-token-value');
    expect(result.connection.connected).toBe(true);
    expect(result.freeBusyCalendarId).toBe('shared@group.calendar.google.com');
  });

  it('reports a never-connected install without erroring', async () => {
    const { db } = buildDbMock({ queryDocs: settingsDocs('') });
    mocks.dbFn.mockReturnValue(db);
    const result = await getGoogleCalendarConnectionHandler(req());
    expect(result.connection.connected).toBe(false);
  });
});

describe('listGoogleCalendars', () => {
  it('keeps read-only calendars in the list and marks them', async () => {
    // Filtering them out leaves the operator unable to tell "not shown because
    // read-only" from "not shown because the connection is broken".
    const { db } = buildDbMock({
      docs: { 'integrations_config/googleCalendar': CONNECTED },
      queryDocs: settingsDocs(''),
    });
    mocks.dbFn.mockReturnValue(db);
    mocks.calendarListList.mockResolvedValue({
      data: {
        items: [
          { id: 'auntie@tribetails.com', summary: 'Auntie', accessRole: 'owner', primary: true },
          { id: 'read@group.calendar.google.com', summary: 'Shared', accessRole: 'reader' },
        ],
      },
    });

    const result = await listGoogleCalendarsHandler(req());
    expect(result.calendars).toHaveLength(2);
    expect(canWriteToCalendar(result.calendars[0].accessRole)).toBe(true);
    expect(canWriteToCalendar(result.calendars[1].accessRole)).toBe(false);
  });

  it('refuses with the not-connected code before calling Google', async () => {
    const { db } = buildDbMock({ queryDocs: settingsDocs('') });
    mocks.dbFn.mockReturnValue(db);
    await expect(listGoogleCalendarsHandler(req())).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: 'google_calendar_not_connected' },
    });
    expect(mocks.calendarListList).not.toHaveBeenCalled();
  });

  it('reports a revoked grant as its own state, not as an outage', async () => {
    // Retrying never fixes this one. Only reconnecting does, so it must not read
    // as "Google is having a moment".
    const { db } = buildDbMock({
      docs: { 'integrations_config/googleCalendar': CONNECTED },
      queryDocs: settingsDocs(''),
    });
    mocks.dbFn.mockReturnValue(db);
    mocks.calendarListList.mockRejectedValue(new Error('invalid_grant: Token has been expired or revoked.'));

    await expect(listGoogleCalendarsHandler(req())).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: 'google_oauth_revoked' },
    });
  });

  it('falls back to the id when a calendar has no name', async () => {
    expect(toCalendarSummaries([{ id: 'x@group.calendar.google.com' }])[0].summary).toBe(
      'x@group.calendar.google.com',
    );
    expect(toCalendarSummaries([{ summary: 'no id' }])).toHaveLength(0);
  });
});

describe('setGoogleCalendarTargets', () => {
  it('saves the pick and forces the write target into the enabled set', async () => {
    const { db, writes } = buildDbMock({
      docs: { 'integrations_config/googleCalendar': CONNECTED },
      queryDocs: settingsDocs(''),
    });
    mocks.dbFn.mockReturnValue(db);

    await setGoogleCalendarTargetsHandler(
      req({ writeCalendarId: 'work@group.calendar.google.com', enabledCalendarIds: [] }),
    );

    const write = writes.find((w) => w.path === 'integrations_config/googleCalendar');
    expect(write?.data).toMatchObject({
      writeCalendarId: 'work@group.calendar.google.com',
      enabledCalendarIds: ['work@group.calendar.google.com'],
    });
    expect(write?.merge).toBe(true);
  });

  it('refuses the free/busy calendar as the write target', async () => {
    const { db, writes } = buildDbMock({
      docs: { 'integrations_config/googleCalendar': CONNECTED },
      queryDocs: settingsDocs('shared@group.calendar.google.com'),
    });
    mocks.dbFn.mockReturnValue(db);

    await expect(
      setGoogleCalendarTargetsHandler(
        req({ writeCalendarId: 'shared@group.calendar.google.com', enabledCalendarIds: [] }),
      ),
    ).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: 'write_calendar_invalid' },
    });
    expect(writes).toHaveLength(0);
  });

  it('refuses primary when primary IS the free/busy calendar', async () => {
    const { db } = buildDbMock({
      docs: { 'integrations_config/googleCalendar': CONNECTED },
      queryDocs: settingsDocs('auntie@tribetails.com'),
    });
    mocks.dbFn.mockReturnValue(db);

    await expect(
      setGoogleCalendarTargetsHandler(req({ writeCalendarId: 'primary', enabledCalendarIds: [] })),
    ).rejects.toMatchObject({ details: { code: 'write_calendar_invalid' } });
  });

  it('refuses an unknown field rather than dropping it', async () => {
    const { db } = buildDbMock({
      docs: { 'integrations_config/googleCalendar': CONNECTED },
      queryDocs: settingsDocs(''),
    });
    mocks.dbFn.mockReturnValue(db);
    await expect(
      setGoogleCalendarTargetsHandler(
        req({ writeCalendarId: 'primary', enabledCalendarIds: [], refreshToken: 'mine' }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('disconnectGoogleCalendar', () => {
  it('revokes at Google FIRST, then clears our copy', async () => {
    const { db, writes } = buildDbMock({
      docs: { 'integrations_config/googleCalendar': CONNECTED },
      queryDocs: settingsDocs(''),
    });
    mocks.dbFn.mockReturnValue(db);
    mocks.revokeToken.mockResolvedValue({});

    const result = await disconnectGoogleCalendarHandler(req());

    expect(mocks.revokeToken).toHaveBeenCalledWith('1//refresh-token-value');
    expect(result.revoked).toBe(true);
    const write = writes.find((w) => w.path === 'integrations_config/googleCalendar');
    expect(write?.data).toMatchObject({ connected: false, refreshToken: '', writeCalendarId: '' });
    // Cleared, not deleted: a deleted doc and a connection that never happened
    // read identically, so the operator could not tell whether it worked.
    expect(String(write?.data.disconnectedAt)).not.toBe('');
  });

  it('still forgets the token when the revoke fails, and says the revoke failed', async () => {
    const { db, writes } = buildDbMock({
      docs: { 'integrations_config/googleCalendar': CONNECTED },
      queryDocs: settingsDocs(''),
    });
    mocks.dbFn.mockReturnValue(db);
    mocks.revokeToken.mockRejectedValue(new Error('network down'));

    const result = await disconnectGoogleCalendarHandler(req());

    expect(result.revoked).toBe(false);
    expect(result.revokeError).toContain('network down');
    const write = writes.find((w) => w.path === 'integrations_config/googleCalendar');
    expect(write?.data.refreshToken).toBe('');
    expect(String(write?.data.disconnectedError)).toContain(MANUAL_REVOKE_HINT);
  });

  it('is safe to press twice', async () => {
    const { db } = buildDbMock({ queryDocs: settingsDocs('') });
    mocks.dbFn.mockReturnValue(db);
    const result = await disconnectGoogleCalendarHandler(req());
    expect(result.revoked).toBe(true);
    expect(mocks.revokeToken).not.toHaveBeenCalled();
  });
});
