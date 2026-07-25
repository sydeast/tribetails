// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { runCalendarSync } = vi.hoisted(() => ({ runCalendarSync: vi.fn() }));
vi.mock('../../api/calendarSync', async (orig) => ({
  ...(await orig<typeof import('../../api/calendarSync')>()),
  runCalendarSync,
}));

import { CalendarSyncSection } from './CalendarSyncSection';

const NEVER_CONFIGURED = {
  calendarSyncId: '',
  calendarSyncLastRunAt: '',
  calendarSyncLastStatus: '',
  calendarSyncLastImported: 0,
  calendarSyncLastError: '',
};

const CONFIGURED = { ...NEVER_CONFIGURED, calendarSyncId: 'team@group.calendar.google.com' };

beforeEach(() => {
  runCalendarSync.mockReset();
});

describe('CalendarSyncSection — the calendar id', () => {
  it('names the exact service account and share level to set up', async () => {
    render(<CalendarSyncSection data={NEVER_CONFIGURED} onSave={vi.fn()} />);
    expect(
      screen.getByText('auntieos-admin-calendar-sync@auntieos-ttpc.iam.gserviceaccount.com'),
    ).toBeInTheDocument();
    expect(screen.getByText(/See only free\/busy/i)).toBeInTheDocument();
  });

  it('saves a well-formed id', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<CalendarSyncSection data={NEVER_CONFIGURED} onSave={onSave} />);
    await userEvent.type(screen.getByLabelText('Calendar ID'), '  team@group.calendar.google.com  ');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith({ calendarSyncId: 'team@group.calendar.google.com' });
  });

  it('refuses a mistyped id BEFORE saving, and says it would look like an empty calendar', async () => {
    const onSave = vi.fn();
    render(<CalendarSyncSection data={NEVER_CONFIGURED} onSave={onSave} />);
    await userEvent.type(screen.getByLabelText('Calendar ID'), 'team-cal');
    expect(screen.getByRole('alert')).toHaveTextContent(/import nothing/i);
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('refuses "primary", which would sync forever and import nothing', async () => {
    render(<CalendarSyncSection data={NEVER_CONFIGURED} onSave={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Calendar ID'), 'primary');
    expect(screen.getByRole('alert')).toHaveTextContent(/always empty/i);
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  it('does not scold an empty field on a never-configured install', () => {
    render(<CalendarSyncSection data={NEVER_CONFIGURED} onSave={vi.fn()} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('surfaces a save failure instead of leaving the field looking saved', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Missing or insufficient permissions.'));
    render(<CalendarSyncSection data={NEVER_CONFIGURED} onSave={onSave} />);
    await userEvent.type(screen.getByLabelText('Calendar ID'), 'team@group.calendar.google.com');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(await screen.findByText('Missing or insufficient permissions.')).toBeInTheDocument();
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });
});

describe('CalendarSyncSection — running a sync', () => {
  it('runs against the SAVED id and reports how many blocks landed', async () => {
    runCalendarSync.mockResolvedValue({ imported: 3, scanned: 3, ranAt: '2026-07-25T14:30:00.000Z' });
    render(<CalendarSyncSection data={CONFIGURED} onSave={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /run sync/i }));
    expect(runCalendarSync).toHaveBeenCalledWith(30);
    expect(await screen.findByText(/Imported 3 busy blocks\./)).toBeInTheDocument();
  });

  it('says a zero-import run finished and found nothing, not just "0"', async () => {
    runCalendarSync.mockResolvedValue({ imported: 0, scanned: 0, ranAt: '2026-07-25T14:30:00.000Z' });
    render(<CalendarSyncSection data={CONFIGURED} onSave={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /run sync/i }));
    expect(await screen.findByText(/nothing was blocked out/)).toBeInTheDocument();
  });

  it('reports through a live region, so a repeat run with the same count is still announced', async () => {
    runCalendarSync.mockResolvedValue({ imported: 3, scanned: 3, ranAt: '2026-07-25T14:30:00.000Z' });
    render(<CalendarSyncSection data={CONFIGURED} onSave={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /run sync/i }));
    expect(await screen.findByRole('status')).toHaveTextContent(/Imported 3 busy blocks\./);
  });

  it('shows the server failure verbatim, service account and all, never a generic message', async () => {
    const serverMessage =
      'calendar_not_shared: share calendar team@group.calendar.google.com with ' +
      'auntieos-admin-calendar-sync@auntieos-ttpc.iam.gserviceaccount.com at "See only free/busy (hide details)".';
    runCalendarSync.mockRejectedValue(new Error(serverMessage));
    render(<CalendarSyncSection data={CONFIGURED} onSave={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /run sync/i }));
    expect(await screen.findByText(serverMessage)).toBeInTheDocument();
  });

  it('a failed sync never reads as a success, and the button comes back', async () => {
    runCalendarSync.mockRejectedValue(new Error('gcal_500'));
    render(<CalendarSyncSection data={CONFIGURED} onSave={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /run sync/i }));
    expect(await screen.findByText('gcal_500')).toBeInTheDocument();
    expect(screen.queryByText(/Imported/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /run sync/i })).toBeEnabled();
  });

  it('will not run on an unsaved edit, and says the server reads the saved value', async () => {
    render(<CalendarSyncSection data={CONFIGURED} onSave={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Calendar ID'), 'x');
    expect(screen.getByRole('button', { name: /run sync/i })).toBeDisabled();
    expect(screen.getByText(/reads the saved value/i)).toBeInTheDocument();
  });

  it('will not run with no id configured, since there is nothing to sync', () => {
    render(<CalendarSyncSection data={NEVER_CONFIGURED} onSave={vi.fn()} />);
    expect(screen.getByRole('button', { name: /run sync/i })).toBeDisabled();
    expect(screen.getByText(/Nothing to sync yet/)).toBeInTheDocument();
  });

  it('will not run on a SAVED id that cannot work, and explains it once, not twice', () => {
    // A doc configured from another client, or before this rule existed. The
    // field already carries the full explanation; repeating all three lines
    // under the button would read as a second, separate fault.
    render(
      <CalendarSyncSection data={{ ...NEVER_CONFIGURED, calendarSyncId: 'team-cal' }} onSave={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: /run sync/i })).toBeDisabled();
    expect(screen.getByText(/Fix the calendar ID above/)).toBeInTheDocument();
    expect(screen.getAllByText(/import nothing/)).toHaveLength(1);
  });
});

describe('CalendarSyncSection — the last-run receipt', () => {
  it('says a calendar has never been synced, rather than implying a clean run', () => {
    render(<CalendarSyncSection data={CONFIGURED} onSave={vi.fn()} />);
    expect(screen.getByText(/never been synced/i)).toBeInTheDocument();
  });

  it('shows what the last stored run did, on a cold load with no click', () => {
    render(
      <CalendarSyncSection
        data={{
          ...CONFIGURED,
          calendarSyncLastRunAt: '2026-07-25T14:30:00.000Z',
          calendarSyncLastStatus: 'ok',
          calendarSyncLastImported: 6,
        }}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByText(/Imported 6 busy blocks\./)).toBeInTheDocument();
  });

  it('keeps a stored FAILURE loud after a reload, with its cause', () => {
    // The whole point of stamping failures: a sync that broke yesterday and a
    // sync that never ran look identical otherwise, and the operator finds out
    // by pressing the button again.
    render(
      <CalendarSyncSection
        data={{
          ...CONFIGURED,
          calendarSyncLastRunAt: '2026-07-25T14:30:00.000Z',
          calendarSyncLastStatus: 'error',
          calendarSyncLastError: 'calendar_not_shared: share it with the sync account.',
        }}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByText(/The last sync failed/i)).toBeInTheDocument();
    expect(screen.getByText(/share it with the sync account/)).toBeInTheDocument();
  });

  it('replaces a stored failure once a fresh run succeeds', async () => {
    runCalendarSync.mockResolvedValue({ imported: 2, scanned: 2, ranAt: '2026-07-25T15:00:00.000Z' });
    render(
      <CalendarSyncSection
        data={{
          ...CONFIGURED,
          calendarSyncLastRunAt: '2026-07-25T14:30:00.000Z',
          calendarSyncLastStatus: 'error',
          calendarSyncLastError: 'calendar_not_shared: old news.',
        }}
        onSave={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /run sync/i }));
    expect(await screen.findByText(/Imported 2 busy blocks\./)).toBeInTheDocument();
    expect(screen.queryByText(/old news/)).not.toBeInTheDocument();
  });
});
