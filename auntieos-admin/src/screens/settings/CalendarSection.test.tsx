// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BusinessSettings } from '../../api/settings';
import type { Async } from '../../lib/async';

const { runCalendarSync } = vi.hoisted(() => ({ runCalendarSync: vi.fn() }));
vi.mock('../../api/calendarSync', async (orig) => ({
  ...(await orig<typeof import('../../api/calendarSync')>()),
  runCalendarSync,
}));

const googleApi = vi.hoisted(() => ({
  getGoogleCalendarConnection: vi.fn(),
  startGoogleCalendarConnect: vi.fn(),
  listGoogleCalendars: vi.fn(),
  setGoogleCalendarTargets: vi.fn(),
  pushVisitsToGoogleCalendar: vi.fn(),
  disconnectGoogleCalendar: vi.fn(),
}));
vi.mock('../../api/googleCalendar', () => googleApi);

import { CalendarSection } from './CalendarSection';

const BLANK_CONNECTION = {
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

/** Only the fields this section reads. The shell hands down the whole doc. */
const SETTINGS = {
  calendarSyncId: 'team@group.calendar.google.com',
  calendarSyncLastRunAt: '',
  calendarSyncLastStatus: '',
  calendarSyncLastImported: 0,
  calendarSyncLastError: '',
} as unknown as BusinessSettings;

const READY: Async<BusinessSettings> = { status: 'ready', data: SETTINGS };

beforeEach(() => {
  runCalendarSync.mockReset();
  for (const fn of Object.values(googleApi)) fn.mockReset();
  googleApi.getGoogleCalendarConnection.mockResolvedValue({
    connection: BLANK_CONNECTION,
    freeBusyCalendarId: '',
    redirectUri: '',
  });
});

describe('CalendarSection, one section with two sub-headed capabilities', () => {
  it('renders the free/busy import and the editable calendars together, import first', async () => {
    render(<CalendarSection settings={READY} onSave={vi.fn()} />);
    const headings = await screen.findAllByText(/free\/busy import|editable calendars/i);
    expect(headings.map((h) => h.textContent)).toEqual(['Free/busy import', 'Editable calendars']);
  });

  it('keeps the controls of both halves, so nothing was lost in the merge', async () => {
    render(<CalendarSection settings={READY} onSave={vi.fn()} />);
    // The import: the id editor and its Run Sync action.
    expect(screen.getByLabelText('Calendar ID')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /run sync/i })).toBeEnabled();
    // The OAuth half: its Connect action.
    expect(await screen.findByRole('button', { name: /connect google calendar/i })).toBeInTheDocument();
  });

  it('still runs the free/busy sync and reports its own receipt', async () => {
    runCalendarSync.mockResolvedValue({ imported: 3, scanned: 3, ranAt: '2026-07-31T14:30:00.000Z' });
    render(<CalendarSection settings={READY} onSave={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /run sync/i }));
    expect(runCalendarSync).toHaveBeenCalledWith(30);
    expect(await screen.findByText(/Imported 3 busy blocks\./)).toBeInTheDocument();
  });
});

describe('CalendarSection, the two halves still fail separately', () => {
  it('shows the settings load failure on the import half only, and leaves the OAuth half working', async () => {
    // They read different documents: the id lives in `business_settings`, the
    // connection in one `firestore.rules` denies to every client. One being
    // unreadable is not a fault of the other, and merging the tabs must not
    // merge the blast radius.
    render(
      <CalendarSection
        settings={{ status: 'error', message: 'Could not read business settings.', retry: vi.fn() }}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByText(/could not read business settings/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Calendar ID')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /connect google calendar/i })).toBeInTheDocument();
  });

  it('shows the failure of the OAuth half without touching the import half', async () => {
    googleApi.getGoogleCalendarConnection.mockRejectedValue(new Error('internal: not deployed.'));
    render(<CalendarSection settings={READY} onSave={vi.fn()} />);
    expect(await screen.findByText('internal: not deployed.')).toBeInTheDocument();
    // The import is untouched and still runnable.
    expect(screen.getByLabelText('Calendar ID')).toHaveValue('team@group.calendar.google.com');
    expect(screen.getByRole('button', { name: /run sync/i })).toBeEnabled();
  });

  it('shows the import loading on its own while the OAuth half loads itself', () => {
    render(<CalendarSection settings={{ status: 'loading' }} onSave={vi.fn()} />);
    expect(screen.getByText(/loading business settings/i)).toBeInTheDocument();
    expect(screen.getByText('Editable calendars')).toBeInTheDocument();
  });
});
