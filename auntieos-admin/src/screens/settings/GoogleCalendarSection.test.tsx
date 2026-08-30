// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({
  getGoogleCalendarConnection: vi.fn(),
  startGoogleCalendarConnect: vi.fn(),
  listGoogleCalendars: vi.fn(),
  setGoogleCalendarTargets: vi.fn(),
  pushVisitsToGoogleCalendar: vi.fn(),
  disconnectGoogleCalendar: vi.fn(),
}));
vi.mock('../../api/googleCalendar', () => api);

import { GoogleCalendarSection } from './GoogleCalendarSection';
import type { GoogleCalendarConnection } from '../../api/googleCalendar';

const BLANK: GoogleCalendarConnection = {
  connected: false,
  googleAccountEmail: '',
  connectedAt: '',
  scopes: [],
  writeCalendarId: '',
  enabledCalendarIds: [],
  disconnectedAt: '',
  disconnectedError: '',
  connectLastAttemptAt: '',
  connectLastStatus: '',
  connectLastError: '',
  calendarPushLastRunAt: '',
  calendarPushLastStatus: '',
  calendarPushLastPushed: 0,
  calendarPushLastError: '',
  calendarAutoSyncLastRunAt: '',
  calendarAutoSyncLastStatus: '',
  calendarAutoSyncLastAction: '',
  calendarAutoSyncLastSessionId: '',
  calendarAutoSyncLastError: '',
};

const CONNECTED = {
  ...BLANK,
  connected: true,
  googleAccountEmail: 'auntie@tribetails.com',
  connectedAt: '2026-07-25T09:00:00.000Z',
  writeCalendarId: 'work@group.calendar.google.com',
  enabledCalendarIds: ['work@group.calendar.google.com'],
};

function connectionResult(connection: GoogleCalendarConnection, freeBusyCalendarId = '') {
  return { connection, freeBusyCalendarId, redirectUri: 'https://example.invalid/callback' };
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.getGoogleCalendarConnection.mockResolvedValue(connectionResult(BLANK));
  vi.stubGlobal('open', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A callable rejection shaped the way `lib/fns.ts` rethrows one: message plus `details`. */
function callableError(message: string, details?: unknown): Error {
  const err = new Error(message);
  if (details !== undefined) Object.assign(err, { code: 'functions/failed-precondition', details });
  return err;
}

const NOT_CONFIGURED_DETAILS = {
  code: 'google_oauth_not_configured',
  missing: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'],
};

describe('GoogleCalendarSection, the setup checklist', () => {
  it('shows the three steps the operator owes, with the redirect URI and both commands verbatim', async () => {
    // All three are typed by a human into a console or a shell. Google refuses
    // the whole flow on a redirect URI that differs by a trailing slash, so this
    // text is copied, not paraphrased.
    render(<GoogleCalendarSection />);
    expect(await screen.findByText(/create the oauth client in google cloud console/i)).toBeInTheDocument();
    expect(screen.getByText(/set both secret values/i)).toBeInTheDocument();
    expect(screen.getByText(/redeploy, so the functions mount what you set/i)).toBeInTheDocument();
    expect(
      screen.getByText('https://us-central1-auntieos-ttpc.cloudfunctions.net/googleOAuthCallback'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/firebase functions:secrets:set GOOGLE_OAUTH_CLIENT_ID --project auntieos-ttpc/),
    ).toBeInTheDocument();
    expect(screen.getByText('firebase deploy --only functions:mytribe')).toBeInTheDocument();
  });

  it('claims nothing it has not observed: every step starts unknown, none says done', async () => {
    render(<GoogleCalendarSection />);
    expect(await screen.findByText(/no step has failed yet/i)).toBeInTheDocument();
    expect(screen.getAllByText('unknown')).toHaveLength(3);
    expect(screen.queryByText('done')).not.toBeInTheDocument();
  });

  it('names the failing step and the exact secret, and calls the deploy out as the twin of it', async () => {
    // THE REPORTED BUG. The operator ran functions:secrets:set several times and
    // the feature kept failing, because setting a secret binds nothing until a
    // deploy carries it. From a browser those two are one observation, so both
    // steps go red together and step 3 says which one is likely left.
    api.startGoogleCalendarConnect.mockRejectedValue(
      callableError('Google Calendar is not set up on the server yet.', NOT_CONFIGURED_DETAILS),
    );
    render(<GoogleCalendarSection />);
    await userEvent.click(await screen.findByRole('button', { name: /connect google calendar/i }));

    expect(await screen.findByText('Step 2: Set both secret values.')).toBeInTheDocument();
    expect(screen.getAllByText('not done')).toHaveLength(2);
    expect(
      screen.getByText(/server read GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET as empty/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/already run the command in step 2, this is the one that is outstanding/i)).toBeInTheDocument();
  });

  it('marks the values proven once the server hands back a consent URL', async () => {
    // The server refuses to build one unless both values are non-empty, so
    // holding one is the proof. It is NOT proof about Google's side.
    api.startGoogleCalendarConnect.mockResolvedValue({ authUrl: 'https://accounts.google.com/x', expiresAt: '', redirectUri: '' });
    render(<GoogleCalendarSection />);
    await userEvent.click(await screen.findByRole('button', { name: /connect google calendar/i }));
    expect(await screen.findByText(/only way it could have built a consent URL/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing here can check this one/i)).toBeInTheDocument();
  });

  it('blames the deploy, not the operator, when no callable answers at all', async () => {
    api.getGoogleCalendarConnection.mockRejectedValue(new Error('internal: function not found.'));
    render(<GoogleCalendarSection />);
    expect(await screen.findByText(/the functions this feature needs are not reachable/i)).toBeInTheDocument();
    // And it must not claim anything about values it never got to read.
    expect(screen.queryByText(/read GOOGLE_OAUTH_CLIENT_ID/i)).not.toBeInTheDocument();
  });

  it('does not read an unrelated failure as evidence about the secrets', async () => {
    // An offline blip says nothing about setup, and a checklist that treats it
    // as an answer sends the operator to fix the wrong thing.
    api.startGoogleCalendarConnect.mockRejectedValue(new Error('deadline-exceeded'));
    render(<GoogleCalendarSection />);
    await userEvent.click(await screen.findByRole('button', { name: /connect google calendar/i }));
    expect(await screen.findByText('deadline-exceeded')).toBeInTheDocument();
    expect(screen.getAllByText('unknown')).toHaveLength(3);
  });

  it('folds the checklist away once an account is connected, since the connection is the receipt', async () => {
    api.getGoogleCalendarConnection.mockResolvedValue(connectionResult(CONNECTED));
    render(<GoogleCalendarSection />);
    await screen.findByText('auntie@tribetails.com');
    expect(screen.queryByText(/set both secret values/i)).not.toBeInTheDocument();
  });
});

describe('GoogleCalendarSection, before anything is connected', () => {
  it('surfaces the setup instruction from the server VERBATIM instead of a friendly summary', async () => {
    // That text is the whole point: it says which secret is missing and the
    // command that sets it.
    const serverMessage =
      'Google Calendar is not set up on the server yet: GOOGLE_OAUTH_CLIENT_SECRET is not set. ' +
      'firebase functions:secrets:set GOOGLE_OAUTH_CLIENT_SECRET --project auntieos-ttpc';
    api.startGoogleCalendarConnect.mockRejectedValue(new Error(serverMessage));
    render(<GoogleCalendarSection />);
    await userEvent.click(await screen.findByRole('button', { name: /connect google calendar/i }));
    expect(await screen.findByText(serverMessage)).toBeInTheDocument();
  });

  it('opens the consent URL and then waits, rather than claiming it connected', async () => {
    api.startGoogleCalendarConnect.mockResolvedValue({
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=abc',
      expiresAt: '',
      redirectUri: '',
    });
    render(<GoogleCalendarSection />);
    await userEvent.click(await screen.findByRole('button', { name: /connect google calendar/i }));

    expect(window.open).toHaveBeenCalledWith(
      'https://accounts.google.com/o/oauth2/v2/auth?state=abc',
      '_blank',
      'noopener,noreferrer',
    );
    // The callback lands in a window this page cannot read, so nothing is
    // asserted about the outcome until the server says so.
    expect(await screen.findByText(/waiting for the google window/i)).toBeInTheDocument();
  });

  it('shows the failure the server stamped on the last attempt', async () => {
    // Without this, a declined consent and a callback that never ran look
    // identical: still not connected, no reason given.
    api.getGoogleCalendarConnection.mockResolvedValue(
      connectionResult({
        ...BLANK,
        connectLastAttemptAt: '2026-07-25T09:00:00.000Z',
        connectLastStatus: 'error',
        connectLastError: 'Google Calendar was not connected because access was declined.',
      }),
    );
    render(<GoogleCalendarSection />);
    expect(await screen.findByText(/access was declined/i)).toBeInTheDocument();
  });
});

describe('GoogleCalendarSection, connected', () => {
  beforeEach(() => {
    api.getGoogleCalendarConnection.mockResolvedValue(connectionResult(CONNECTED));
  });

  it('names the connected account and offers Disconnect', async () => {
    render(<GoogleCalendarSection />);
    expect(await screen.findByText('auntie@tribetails.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /disconnect/i })).toBeInTheDocument();
  });

  it('lists read-only calendars but will not let one be chosen', async () => {
    // Hiding them would leave a missing calendar reading as "the connection is
    // broken" rather than "you cannot write to that one".
    api.listGoogleCalendars.mockResolvedValue({
      calendars: [
        { id: 'work@group.calendar.google.com', summary: 'Work', accessRole: 'owner', primary: false },
        { id: 'read@group.calendar.google.com', summary: 'Shared', accessRole: 'reader', primary: false },
      ],
      connection: CONNECTED,
      freeBusyCalendarId: '',
    });
    render(<GoogleCalendarSection />);
    await userEvent.click(await screen.findByRole('button', { name: /load calendars/i }));
    const readOnly = await screen.findByRole('option', { name: /read only, cannot take events/i });
    expect(readOnly).toBeDisabled();
  });

  it('refuses the free/busy calendar as the write target BEFORE saving', async () => {
    api.getGoogleCalendarConnection.mockResolvedValue(
      connectionResult({ ...CONNECTED, writeCalendarId: '' }, 'shared@group.calendar.google.com'),
    );
    api.listGoogleCalendars.mockResolvedValue({
      calendars: [
        { id: 'shared@group.calendar.google.com', summary: 'Shared', accessRole: 'owner', primary: false },
      ],
      connection: { ...CONNECTED, writeCalendarId: '' },
      freeBusyCalendarId: 'shared@group.calendar.google.com',
    });
    render(<GoogleCalendarSection />);
    await userEvent.click(await screen.findByRole('button', { name: /load calendars/i }));
    await userEvent.selectOptions(
      screen.getByLabelText(/write visits to/i),
      'shared@group.calendar.google.com',
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/same hour twice/i);
    expect(screen.getByRole('button', { name: /save calendar/i })).toBeDisabled();
    expect(api.setGoogleCalendarTargets).not.toHaveBeenCalled();
  });

  it('says a push has never happened rather than showing a zero-visit success', async () => {
    render(<GoogleCalendarSection />);
    expect(await screen.findByText(/no visits have been sent to this calendar yet/i)).toBeInTheDocument();
  });

  it('renders the failed last push as a failure, with the server cause', async () => {
    api.getGoogleCalendarConnection.mockResolvedValue(
      connectionResult({
        ...CONNECTED,
        calendarPushLastRunAt: '2026-07-25T10:00:00.000Z',
        calendarPushLastStatus: 'error',
        calendarPushLastError: 'Google has rejected the saved connection.',
      }),
    );
    render(<GoogleCalendarSection />);
    expect(await screen.findByText(/the last push failed/i)).toBeInTheDocument();
    expect(screen.getByText(/Google has rejected the saved connection/)).toBeInTheDocument();
  });

  it('reports what the push actually did, including skipped visits', async () => {
    api.pushVisitsToGoogleCalendar.mockResolvedValue({
      pushed: 2,
      removed: 1,
      scanned: 4,
      skipped: [{ sessionId: 'sess-9', reason: 'No end time and no duration on the visit.' }],
      ranAt: '2026-07-25T11:00:00.000Z',
    });
    render(<GoogleCalendarSection />);
    await userEvent.click(await screen.findByRole('button', { name: /push next 30 days/i }));
    expect(await screen.findByText(/Sent 2 visits, removed 1 cancelled visit\./)).toBeInTheDocument();
    expect(screen.getByText(/sess-9/)).toBeInTheDocument();
  });

  it('re-reads the connection after a failed push, so the stamped receipt survives', async () => {
    api.pushVisitsToGoogleCalendar.mockRejectedValue(new Error('Google said no.'));
    render(<GoogleCalendarSection />);
    await screen.findByText('auntie@tribetails.com');
    api.getGoogleCalendarConnection.mockClear();
    await userEvent.click(screen.getByRole('button', { name: /push next 30 days/i }));
    expect(await screen.findByText('Google said no.')).toBeInTheDocument();
    await waitFor(() => expect(api.getGoogleCalendarConnection).toHaveBeenCalled());
  });

  it('says plainly that disconnecting does not delete events already written', async () => {
    api.disconnectGoogleCalendar.mockResolvedValue({ connection: BLANK, revoked: true, revokeError: '' });
    render(<GoogleCalendarSection />);
    await userEvent.click(await screen.findByRole('button', { name: /disconnect/i }));
    expect(await screen.findByText(/stay on that calendar/i)).toBeInTheDocument();
  });

  it('says so when Google did not confirm the revoke', async () => {
    // A half-done disconnect that reads as done leaves a live grant nobody
    // knows about.
    api.disconnectGoogleCalendar.mockResolvedValue({
      connection: BLANK,
      revoked: false,
      revokeError: 'network down',
    });
    render(<GoogleCalendarSection />);
    await userEvent.click(await screen.findByRole('button', { name: /disconnect/i }));
    expect(await screen.findByText(/Google did not confirm it: network down/)).toBeInTheDocument();
  });
});
