// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({
  syncVisitToGoogleCalendar: vi.fn(),
}));
vi.mock('../../api/googleCalendar', () => api);

import { AutomaticCalendarSyncPanel } from './AutomaticCalendarSyncPanel';
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

const ARMED: GoogleCalendarConnection = {
  ...BLANK,
  connected: true,
  googleAccountEmail: 'auntie@tribetails.com',
  writeCalendarId: 'work@group.calendar.google.com',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AutomaticCalendarSyncPanel', () => {
  it('explains what will happen before a calendar has been chosen', () => {
    render(<AutomaticCalendarSyncPanel connection={BLANK} onSynced={vi.fn()} />);

    expect(screen.getByText(/Once a calendar is chosen/i)).toBeInTheDocument();
    // Nothing to retry, because nothing has run.
    expect(screen.queryByRole('button', { name: /Retry/i })).not.toBeInTheDocument();
  });

  it('says automatic sync is live once a calendar is chosen, with no toggle to get wrong', () => {
    render(<AutomaticCalendarSyncPanel connection={ARMED} onSynced={vi.fn()} />);

    expect(screen.getByText(/Confirming a visit puts it on this calendar/i)).toBeInTheDocument();
    expect(screen.getByText(/has not needed to run yet/i)).toBeInTheDocument();
    // There is deliberately no on/off switch: choosing the calendar IS the
    // switch, so there is no state where a calendar is set and visits silently
    // do not reach it.
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('reports a successful run', () => {
    render(
      <AutomaticCalendarSyncPanel
        connection={{
          ...ARMED,
          calendarAutoSyncLastRunAt: '2026-08-23T09:00:00.000Z',
          calendarAutoSyncLastStatus: 'ok',
          calendarAutoSyncLastAction: 'created',
          calendarAutoSyncLastSessionId: 'sess-1',
        }}
        onSynced={vi.fn()}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent(/put a visit on the calendar/i);
    expect(screen.queryByRole('button', { name: /Retry/i })).not.toBeInTheDocument();
  });

  it('SURFACES a failed run with the server\'s own words, and offers a retry', async () => {
    const user = userEvent.setup();
    const onSynced = vi.fn();
    api.syncVisitToGoogleCalendar.mockResolvedValue({
      sessionId: 'sess-1',
      action: 'created',
      eventId: 'gcal-1',
      reason: '',
      syncedAt: '2026-08-23T10:00:00.000Z',
    });

    render(
      <AutomaticCalendarSyncPanel
        connection={{
          ...ARMED,
          calendarAutoSyncLastRunAt: '2026-08-23T09:00:00.000Z',
          calendarAutoSyncLastStatus: 'error',
          calendarAutoSyncLastSessionId: 'sess-1',
          calendarAutoSyncLastError: 'Google has rejected the saved connection.',
        }}
        onSynced={onSynced}
      />,
    );

    expect(screen.getByText(/The last automatic sync failed/i)).toBeInTheDocument();
    expect(screen.getByText(/Google has rejected the saved connection/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Retry that visit/i }));

    // The retry is aimed at the visit the stamp named, not at a bulk sweep.
    expect(api.syncVisitToGoogleCalendar).toHaveBeenCalledWith('sess-1');
    await waitFor(() => {
      expect(screen.getByText(/on the calendar now \(created\)/i)).toBeInTheDocument();
    });
    // The panel re-reads from the server rather than trusting its own result.
    expect(onSynced).toHaveBeenCalled();
  });

  it('FAILS LOUD when the retry itself fails, keeping the server\'s remedy', async () => {
    const user = userEvent.setup();
    api.syncVisitToGoogleCalendar.mockRejectedValue(
      new Error('Connect Google Calendar again to restore it.'),
    );

    render(
      <AutomaticCalendarSyncPanel
        connection={{
          ...ARMED,
          calendarAutoSyncLastRunAt: '2026-08-23T09:00:00.000Z',
          calendarAutoSyncLastStatus: 'error',
          calendarAutoSyncLastSessionId: 'sess-1',
          calendarAutoSyncLastError: 'It broke.',
        }}
        onSynced={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Retry that visit/i }));

    await waitFor(() => {
      expect(screen.getByText(/Retry failed/i)).toBeInTheDocument();
    });
    // A friendly "Could not sync" would delete the only text saying what to do.
    expect(screen.getByText(/Connect Google Calendar again to restore it/i)).toBeInTheDocument();
  });

  it('reports a skipped retry honestly instead of claiming success', async () => {
    const user = userEvent.setup();
    api.syncVisitToGoogleCalendar.mockResolvedValue({
      sessionId: 'sess-1',
      action: 'skipped',
      eventId: '',
      reason: 'This visit has no end time and no duration.',
      syncedAt: '2026-08-23T10:00:00.000Z',
    });

    render(
      <AutomaticCalendarSyncPanel
        connection={{
          ...ARMED,
          calendarAutoSyncLastRunAt: '2026-08-23T09:00:00.000Z',
          calendarAutoSyncLastStatus: 'error',
          calendarAutoSyncLastSessionId: 'sess-1',
          calendarAutoSyncLastError: 'It broke.',
        }}
        onSynced={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Retry that visit/i }));

    await waitFor(() => {
      expect(screen.getByText(/Nothing was written for that visit/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/no end time and no duration/i)).toBeInTheDocument();
  });

  it('offers no retry for a failure that was about the connection, not one visit', () => {
    render(
      <AutomaticCalendarSyncPanel
        connection={{
          ...ARMED,
          calendarAutoSyncLastRunAt: '2026-08-23T09:00:00.000Z',
          calendarAutoSyncLastStatus: 'error',
          calendarAutoSyncLastSessionId: '',
          calendarAutoSyncLastError: 'That is the calendar the free/busy sync already imports from.',
        }}
        onSynced={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: /Retry/i })).not.toBeInTheDocument();
    expect(screen.getByText(/nothing to retry on its own/i)).toBeInTheDocument();
  });
});
