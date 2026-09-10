// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_BUSINESS_SETTINGS, type BusinessSettings } from '../../api/settings';
import type { Async } from '../../lib/async';

const api = vi.hoisted(() => ({ getIntegrationsHealth: vi.fn() }));
vi.mock('../../api/integrations', async (importOriginal) => {
  // The status label/tone maps are real: they are part of what this section
  // renders, and stubbing them would let a wrong label pass this file.
  const actual = await importOriginal<typeof import('../../api/integrations')>();
  return { ...actual, getIntegrationsHealth: api.getIntegrationsHealth };
});

// ISSUE #715: the Google Calendar row now opens `CalendarSection` inline,
// which mounts `GoogleCalendarSection`. Mocked at the api seam (the
// Settings.test.tsx / CalendarSection.test.tsx convention) so this file never
// reaches real Firebase Functions when a test opens the inline panel.
const googleCalendarApi = vi.hoisted(() => ({
  getGoogleCalendarConnection: vi.fn(),
  startGoogleCalendarConnect: vi.fn(),
  listGoogleCalendars: vi.fn(),
  setGoogleCalendarTargets: vi.fn(),
  pushVisitsToGoogleCalendar: vi.fn(),
  disconnectGoogleCalendar: vi.fn(),
}));
vi.mock('../../api/googleCalendar', () => googleCalendarApi);

const BLANK_GOOGLE_CONNECTION = {
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

import { IntegrationsSection } from './IntegrationsSection';
import type { IntegrationHealth, IntegrationsHealthResult } from '../../api/integrations';

const READY_SETTINGS: Async<BusinessSettings> = { status: 'ready', data: DEFAULT_BUSINESS_SETTINGS };
const onSaveCalendar = vi.fn();

/**
 * What this section must never do, stated as tests rather than as a comment:
 *
 *   - render a reassuring row when the read failed (AsyncRegion owns it, and it
 *     is asserted here because this is the screen where a false green means an
 *     operator stops looking for the reason invoices are not sending)
 *   - paraphrase the remediation, which carries the exact command to paste
 *   - show a secret VALUE, which the server never sends and this file never asks for
 *   - claim a secret is undeclared when the server said it could not find out
 */

function integration(over: Partial<IntegrationHealth> = {}): IntegrationHealth {
  return {
    key: 'twilio',
    name: 'Twilio',
    purpose: 'SMS to kinfolk.',
    status: 'configured',
    summary: 'Credentials are set. Not verified here.',
    secrets: [
      {
        name: 'TWILIO_AUTH_TOKEN',
        required: true,
        purpose: 'Signs sends.',
        declared: true,
        resolves: true,
        length: 32,
      },
    ],
    liveness: { outcome: 'none', detail: 'Not verified here.' },
    remediation: '',
    externalStep: '',
    ownedBySection: '',
    ...over,
  };
}

function result(over: Partial<IntegrationsHealthResult> = {}): IntegrationsHealthResult {
  return {
    checkedAt: '2026-07-31T12:00:00.000Z',
    declaredKnown: true,
    declaredError: '',
    integrations: [integration()],
    ...over,
  };
}

beforeEach(() => {
  api.getIntegrationsHealth.mockReset();
  api.getIntegrationsHealth.mockResolvedValue(result());
  onSaveCalendar.mockReset();
  for (const fn of Object.values(googleCalendarApi)) fn.mockReset();
  googleCalendarApi.getGoogleCalendarConnection.mockResolvedValue({
    connection: BLANK_GOOGLE_CONNECTION,
    freeBusyCalendarId: '',
    redirectUri: '',
  });
});

describe('IntegrationsSection renders each status class', () => {
  it('shows a working integration as working', async () => {
    api.getIntegrationsHealth.mockResolvedValue(
      result({
        integrations: [
          integration({
            key: 'cloudinary',
            name: 'Cloudinary',
            status: 'working',
            summary: 'A signed upload can be signed.',
          }),
        ],
      }),
    );
    render(<IntegrationsSection settings={READY_SETTINGS} onSaveCalendar={onSaveCalendar} />);
    expect(await screen.findByText('Working')).toBeInTheDocument();
    expect(screen.getByText('A signed upload can be signed.')).toBeInTheDocument();
  });

  it('shows set-but-unverified as its own class, not as working', async () => {
    render(<IntegrationsSection settings={READY_SETTINGS} onSaveCalendar={onSaveCalendar} />);
    expect(await screen.findByText('Set up, not verified')).toBeInTheDocument();
    expect(screen.queryByText('Working')).not.toBeInTheDocument();
  });

  it('names the missing secret rather than saying only that something is wrong', async () => {
    api.getIntegrationsHealth.mockResolvedValue(
      result({
        integrations: [
          integration({
            status: 'missing',
            summary: 'Not usable: TWILIO_AUTH_TOKEN is not set.',
            secrets: [
              {
                name: 'TWILIO_AUTH_TOKEN',
                required: true,
                purpose: 'Signs sends.',
                declared: true,
                resolves: false,
                length: 0,
              },
            ],
          }),
        ],
      }),
    );
    render(<IntegrationsSection settings={READY_SETTINGS} onSaveCalendar={onSaveCalendar} />);
    expect(await screen.findByText('Missing')).toBeInTheDocument();
    expect(screen.getByText(/TWILIO_AUTH_TOKEN is not set/)).toBeInTheDocument();
    expect(screen.getByText('not set')).toBeInTheDocument();
  });

  it('shows a check that could not be made as its own class, never as working', async () => {
    api.getIntegrationsHealth.mockResolvedValue(
      result({
        integrations: [
          integration({
            status: 'unknown',
            summary: 'Credentials are set, but the check could not be made: Firestore is unreachable',
          }),
        ],
      }),
    );
    render(<IntegrationsSection settings={READY_SETTINGS} onSaveCalendar={onSaveCalendar} />);
    expect(await screen.findByText('Could not check')).toBeInTheDocument();
    expect(screen.queryByText('Working')).not.toBeInTheDocument();
  });
});

describe('IntegrationsSection remediation', () => {
  it('prints the command verbatim, so it can be pasted', async () => {
    const command =
      'Twilio is missing TWILIO_AUTH_TOKEN. Set it from mytribe/, then redeploy the functions:\n' +
      'firebase functions:secrets:set TWILIO_AUTH_TOKEN --project auntieos-ttpc\n' +
      'firebase deploy --only functions:mytribe';
    api.getIntegrationsHealth.mockResolvedValue(
      result({ integrations: [integration({ status: 'missing', remediation: command })] }),
    );
    render(<IntegrationsSection settings={READY_SETTINGS} onSaveCalendar={onSaveCalendar} />);
    const block = await screen.findByText(/firebase functions:secrets:set TWILIO_AUTH_TOKEN/);
    expect(block.textContent).toBe(command);
  });

  it('shows no remediation block when nothing is owed', async () => {
    render(<IntegrationsSection settings={READY_SETTINGS} onSaveCalendar={onSaveCalendar} />);
    await screen.findByText('Twilio');
    expect(screen.queryByText('What to do')).not.toBeInTheDocument();
  });

  it('names an external console step even while the integration is otherwise fine', async () => {
    api.getIntegrationsHealth.mockResolvedValue(
      result({
        integrations: [
          integration({
            key: 'stripe',
            name: 'Stripe',
            externalStep: 'Stripe Connect onboarding is not built here. It needs a Connect client ID.',
          }),
        ],
      }),
    );
    render(<IntegrationsSection settings={READY_SETTINGS} onSaveCalendar={onSaveCalendar} />);
    expect(await screen.findByText(/Stripe Connect onboarding is not built here/)).toBeInTheDocument();
  });
});

describe('IntegrationsSection never leaks a credential', () => {
  it('reports a length, and offers no field that could carry a value', async () => {
    render(<IntegrationsSection settings={READY_SETTINGS} onSaveCalendar={onSaveCalendar} />);
    expect(await screen.findByText('set, 32 characters')).toBeInTheDocument();
  });
});

describe('IntegrationsSection failure state', () => {
  it('says the read failed, offers Retry, and renders no status pill at all', async () => {
    api.getIntegrationsHealth.mockRejectedValue(new Error('permission-denied'));
    render(<IntegrationsSection settings={READY_SETTINGS} onSaveCalendar={onSaveCalendar} />);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/Couldn’t load integrations|Couldn't load integrations/)).toBeInTheDocument();
    expect(screen.getByText('permission-denied')).toBeInTheDocument();
    expect(screen.getByText(/Integrations unavailable while the load is failing/)).toBeInTheDocument();
    // The whole point: a failed read must not show a row of reassuring pills.
    expect(screen.queryByText('Working')).not.toBeInTheDocument();
    expect(screen.queryByText('Set up, not verified')).not.toBeInTheDocument();
  });

  it('retries the callable rather than offering a button that does nothing', async () => {
    api.getIntegrationsHealth.mockRejectedValueOnce(new Error('permission-denied'));
    api.getIntegrationsHealth.mockResolvedValue(result());
    render(<IntegrationsSection settings={READY_SETTINGS} onSaveCalendar={onSaveCalendar} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Set up, not verified')).toBeInTheDocument();
  });

  it('withdraws every declared claim when the server could not read the declared set', async () => {
    api.getIntegrationsHealth.mockResolvedValue(
      result({
        declaredKnown: false,
        declaredError: 'the functions index would not load',
        integrations: [
          integration({
            secrets: [
              {
                name: 'TWILIO_AUTH_TOKEN',
                required: true,
                purpose: 'Signs sends.',
                // False only because the walk failed. Rendering it as a finding
                // would send the operator to edit a function that is correct.
                declared: false,
                resolves: true,
                length: 32,
              },
            ],
          }),
        ],
      }),
    );
    render(<IntegrationsSection settings={READY_SETTINGS} onSaveCalendar={onSaveCalendar} />);

    expect(await screen.findByText(/Part of this check could not run/)).toBeInTheDocument();
    expect(screen.getByText(/the functions index would not load/)).toBeInTheDocument();
    expect(screen.queryByText('no deployed function declares this')).not.toBeInTheDocument();
  });

  it('flags an undeclared secret when the server DID look', async () => {
    api.getIntegrationsHealth.mockResolvedValue(
      result({
        integrations: [
          integration({
            secrets: [
              {
                name: 'TWILIO_AUTH_TOKEN',
                required: true,
                purpose: 'Signs sends.',
                declared: false,
                resolves: true,
                length: 32,
              },
            ],
          }),
        ],
      }),
    );
    render(<IntegrationsSection settings={READY_SETTINGS} onSaveCalendar={onSaveCalendar} />);
    expect(await screen.findByText('no deployed function declares this')).toBeInTheDocument();
  });
});

// ISSUE #715: Calendar lives inside Integrations now, opened IN PLACE rather
// than by switching to a tab that no longer exists.
describe('IntegrationsSection opens Calendar in place rather than switching tabs', () => {
  const google = integration({
    key: 'googleCalendar',
    name: 'Google Calendar',
    ownedBySection: 'googleCalendar',
    summary: 'No Google account has been connected yet.',
  });

  it('expands the Calendar panels below the report when the row is opened', async () => {
    api.getIntegrationsHealth.mockResolvedValue(result({ integrations: [google] }));
    render(<IntegrationsSection settings={READY_SETTINGS} onSaveCalendar={onSaveCalendar} />);

    expect(screen.queryByText('Free/busy import')).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Open Google Calendar settings' }));

    expect(screen.getByText('Free/busy import')).toBeInTheDocument();
    expect(screen.getByText('Editable calendars')).toBeInTheDocument();
    expect(screen.getByLabelText('Calendar ID')).toBeInTheDocument();
  });

  it('collapses the panels again when the row is closed', async () => {
    api.getIntegrationsHealth.mockResolvedValue(result({ integrations: [google] }));
    render(<IntegrationsSection settings={READY_SETTINGS} onSaveCalendar={onSaveCalendar} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Open Google Calendar settings' }));
    expect(screen.getByText('Free/busy import')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Hide Google Calendar settings' }));
    expect(screen.queryByText('Free/busy import')).not.toBeInTheDocument();
  });

  // The check is generic (`ownedBySection !== ''`), never a specific string,
  // so it works whether the server sends the current 'calendar' id or the
  // retired 'googleCalendar' id an older deploy might still send (the `google`
  // fixture above already covers the retired id).
  it('still shows the toggle when the server sends the current calendar id', async () => {
    api.getIntegrationsHealth.mockResolvedValue(
      result({ integrations: [{ ...google, ownedBySection: 'calendar' }] }),
    );
    render(<IntegrationsSection settings={READY_SETTINGS} onSaveCalendar={onSaveCalendar} />);
    expect(await screen.findByRole('button', { name: 'Open Google Calendar settings' })).toBeInTheDocument();
  });
});

describe('IntegrationsSection re-checks on demand', () => {
  it('asks the server again rather than re-rendering a cached answer', async () => {
    render(<IntegrationsSection settings={READY_SETTINGS} onSaveCalendar={onSaveCalendar} />);
    await screen.findByText('Twilio');
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(api.getIntegrationsHealth).toHaveBeenCalledTimes(2));
  });
});

describe('IntegrationsSection, the pending state (issue #714)', () => {
  it('shows the spinner while getIntegrationsHealth cold-starts, not a bare hint', async () => {
    let resolveHealth: (value: IntegrationsHealthResult) => void = () => {};
    api.getIntegrationsHealth.mockReset();
    api.getIntegrationsHealth.mockImplementation(
      () => new Promise((resolve) => { resolveHealth = resolve; }),
    );

    render(<IntegrationsSection settings={READY_SETTINGS} onSaveCalendar={onSaveCalendar} />);

    expect(await screen.findByRole('img', { name: 'Checking integrations…' })).toBeInTheDocument();
    expect(screen.queryByText('Twilio')).not.toBeInTheDocument();

    resolveHealth(result());

    expect(await screen.findByText('Twilio')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Checking integrations…' })).not.toBeInTheDocument();
  });
});
