import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import {
  disconnectGoogleCalendar,
  getGoogleCalendarConnection,
  listGoogleCalendars,
  pushVisitsToGoogleCalendar,
  setGoogleCalendarTargets,
  startGoogleCalendarConnect,
} from './googleCalendar';

beforeEach(() => {
  call.mockReset();
  call.mockResolvedValue({});
});

describe('the callable names and payloads', () => {
  it('starts a connect with no arguments at all', async () => {
    call.mockResolvedValue({ authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1', expiresAt: '', redirectUri: '' });
    await startGoogleCalendarConnect();
    expect(call).toHaveBeenCalledWith('startGoogleCalendarConnect', {});
  });

  it('sends only the two target fields when saving a calendar', async () => {
    await setGoogleCalendarTargets('work@group.calendar.google.com', ['work@group.calendar.google.com']);
    const [name, payload] = call.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe('setGoogleCalendarTargets');
    expect(Object.keys(payload).sort()).toEqual(['enabledCalendarIds', 'writeCalendarId']);
  });

  it('NEVER sends a calendar id with the push', async () => {
    // The target is the one the operator saved server-side, so no client can aim
    // a household's visits at somebody else's calendar.
    await pushVisitsToGoogleCalendar(7);
    const [name, payload] = call.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe('pushVisitsToGoogleCalendar');
    expect(Object.keys(payload)).toEqual(['lookAheadDays']);
    expect(payload.lookAheadDays).toBe(7);
  });

  it('defaults the push window to the same 30 days as the free/busy sync', async () => {
    await pushVisitsToGoogleCalendar();
    expect(call.mock.calls[0]?.[1]).toEqual({ lookAheadDays: 30 });
  });

  it('reads and disconnects with no arguments', async () => {
    await getGoogleCalendarConnection();
    await listGoogleCalendars();
    await disconnectGoogleCalendar();
    expect(call.mock.calls.map((c) => c[0])).toEqual([
      'getGoogleCalendarConnection',
      'listGoogleCalendars',
      'disconnectGoogleCalendar',
    ]);
    expect(call.mock.calls.every((c) => Object.keys(c[1] as object).length === 0)).toBe(true);
  });
});

describe('errors', () => {
  it('lets the setup instruction through untouched', async () => {
    // The server names which secret is missing and the exact command to set it.
    // Rewriting that into "Could not connect" deletes the only actionable part.
    const serverMessage =
      'Google Calendar is not set up on the server yet: GOOGLE_OAUTH_CLIENT_SECRET is not set. ' +
      'firebase functions:secrets:set GOOGLE_OAUTH_CLIENT_SECRET --project auntieos-ttpc';
    call.mockRejectedValue(new Error(serverMessage));
    await expect(startGoogleCalendarConnect()).rejects.toThrow(serverMessage);
  });
});
