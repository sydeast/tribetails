// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const getBusinessSettings = vi.fn();
vi.mock('../api/settings', () => ({ getBusinessSettings: () => getBusinessSettings() }));

// SettingsEdit is exercised by its own SettingsEdit.test.tsx; here it is a
// stand-in so this file only asserts Settings.tsx's OWN wiring (does clicking
// "Edit settings" swap the overview for the editor, and does returning from it
// reload the overview) without re-testing the editor's field-level behavior.
const settingsEditOnDone = vi.fn();
vi.mock('./SettingsEdit', () => ({
  SettingsEdit: ({ onDone }: { onDone: () => void }) => {
    settingsEditOnDone.mockImplementation(onDone);
    return (
      <div data-testid="settings-edit-stub">
        <button type="button" onClick={onDone}>
          stub: back to overview
        </button>
      </div>
    );
  },
}));

// Stubbed the same way as SettingsEdit: this file asserts Settings.tsx's own
// wiring (does "Open notification gate" swap to the gate, and does its onBack
// return to the overview), not the gate's own behavior (NotificationGate.test.tsx).
vi.mock('./NotificationGate', () => ({
  NotificationGate: ({ onBack }: { onBack?: () => void }) => (
    <div data-testid="notification-gate-stub">
      <button type="button" onClick={onBack}>
        stub: back to settings
      </button>
    </div>
  ),
}));

// Stubbed like the others: this file asserts Settings.tsx's own wiring (does
// "Open tags" swap to the Tags editor, and does its onBack return to the
// overview), not the editor's CRUD (TagsEditor.test.tsx).
vi.mock('./TagsEditor', () => ({
  TagsEditor: ({ onBack }: { onBack?: () => void }) => (
    <div data-testid="tags-editor-stub">
      <button type="button" onClick={onBack}>
        stub: back to settings from tags
      </button>
    </div>
  ),
}));

import { Settings } from './Settings';
import type { BusinessSettings } from '../api/settings';

/**
 * A local fixture, not imported from the (mocked) api/settings module: mirrors
 * `DEFAULT_BUSINESS_SETTINGS` (FirestoreClient.kt's `BusinessSettings()`
 * defaults) field for field, so this file stays decoupled from the mock.
 */
const DEFAULT_BUSINESS_SETTINGS: BusinessSettings = {
  _id: '',
  businessName: '',
  businessEmail: '',
  businessPhone: '',
  businessAddress: '',
  timeZone: 'America/New_York',
  serviceRates: {},
  businessHours: {},
  venmoHandle: '',
  paypalHandle: '',
  cashappHandle: '',
  weatherLocation: '',
  notificationEmail: true,
  notificationSms: true,
  notificationPush: true,
  observedUsHolidays: [],
  companyHolidays: [],
  specialHours: [],
  observeUsHolidays: false,
  defaultBookingMode: 'SPECIFIC_TIME',
  defaultCalendarView: 'MONTH',
  allowTimeBlockBooking: true,
  allowSpecificTimeBooking: true,
  enableConflictDetection: true,
  enableAutoReminder24h: false,
  defaultTimeBlockDurationHours: 4,
  travelBufferMinutes: 30,
  timeBlocks: [{ id: 'midday', label: 'Midday', startTime: '11:00', endTime: '15:00', active: true }],
  enableGPSTrackingForAllVisits: true,
  enablePhotoLocationTagging: true,
  requireArrivalDepartureVerification: true,
  autoStartTrackingOnVisitStart: true,
  trackingAccuracy: 'HIGH',
  saveRoutesForDays: 90,
  allowClientLocationSharing: true,
  defaultEtaMinutes: 15,
  etaMinuteOptions: [5, 10, 15, 20, 30, 45, 60],
  draftRetentionDays: 30,
  draftRetentionOptions: [30, 60, 90],
  calendarSyncId: '',
  autoConfirmRepeatKinfolk: false,
  snapRescheduleTo15Min: false,
  logoUrl: '',
  brandWordmark: '',
  brandTagline: '',
  homeGreeting: '',
  homeAccentTail: '',
  householdTags: [],
  petTags: [],
  mytribePortal: {
    logoUrl: '',
    themeId: 'default',
    banner: { enabled: false, message: '', tone: 'info', dismissMode: 'none', id: '' },
    home: { sections: [] },
    chat: { enabled: true, awayMessage: '', hoursEnabled: false, hours: {}, maxMessageLength: 2000, rateLimitPerHour: 0 },
  },
  updatedAt: '',
  updatedBy: '',
};

function withOverrides(overrides: Partial<BusinessSettings>): BusinessSettings {
  return { ...DEFAULT_BUSINESS_SETTINGS, ...overrides };
}

beforeEach(() => {
  getBusinessSettings.mockReset();
  settingsEditOnDone.mockReset();
});

describe('Settings screen (read-only overview)', () => {
  it('shows a loading state before the doc resolves', () => {
    getBusinessSettings.mockReturnValue(new Promise(() => {})); // never resolves
    render(<Settings />);
    expect(screen.getByText(/loading business settings/i)).toBeInTheDocument();
  });

  it('surfaces a load failure fail-loud, never a false empty overview', async () => {
    getBusinessSettings.mockRejectedValue(new Error('permission-denied'));
    render(<Settings />);
    expect(await screen.findByText(/permission-denied/i)).toBeInTheDocument();
    expect(screen.queryByText(/business profile/i)).not.toBeInTheDocument();
  });

  it('offers Retry on a failed load and re-fetches on click', async () => {
    getBusinessSettings.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    render(<Settings />);
    const retry = await screen.findByRole('button', { name: /retry/i });
    await userEvent.click(retry);
    expect(await screen.findByText('Business profile')).toBeInTheDocument();
  });

  it('always shows the read-only banner, never an edit form, in the default (non-editing) view', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    render(<Settings />);
    await screen.findByText('Business profile');
    expect(screen.getByText(/this is an overview, not the editor/i)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('renders business profile fields, falling back to "Not set" for blanks', async () => {
    getBusinessSettings.mockResolvedValue(
      withOverrides({ businessName: 'Tribe Tails Care', businessEmail: '', businessPhone: '512-555-0100' }),
    );
    render(<Settings />);
    const panel = (await screen.findByText('Business profile')).closest('section') as HTMLElement;
    expect(within(panel).getByText('Tribe Tails Care')).toBeInTheDocument();
    expect(within(panel).getByText('512-555-0100')).toBeInTheDocument();
    expect(within(panel).getAllByText('Not set').length).toBeGreaterThan(0);
  });

  it('renders business hours with Closed for an unset day', async () => {
    getBusinessSettings.mockResolvedValue(withOverrides({ businessHours: { Monday: '09:00-17:00' } }));
    render(<Settings />);
    const panel = (await screen.findByText('Business hours')).closest('section') as HTMLElement;
    expect(within(panel).getByText('09:00-17:00')).toBeInTheDocument();
    expect(within(panel).getAllByText('Closed').length).toBe(6); // every other day of the week
  });

  it('renders payment handles, flagging an unset one', async () => {
    getBusinessSettings.mockResolvedValue(withOverrides({ venmoHandle: '@tribetails', paypalHandle: '', cashappHandle: '' }));
    render(<Settings />);
    const panel = (await screen.findByText('Payment options')).closest('section') as HTMLElement;
    expect(within(panel).getByText('@tribetails')).toBeInTheDocument();
    expect(within(panel).getAllByText('Not set (hidden on invoices)').length).toBe(2);
  });

  it('renders observed US holidays as chips in catalog order', async () => {
    getBusinessSettings.mockResolvedValue(withOverrides({ observedUsHolidays: ['christmas', 'new_years'] }));
    render(<Settings />);
    // Time Off ships collapsed by default (matches the wasm TimeOffPanel's
    // `initiallyExpanded = false`), so expand it before asserting on content.
    await userEvent.click(await screen.findByRole('button', { name: /time off/i }));
    const panel = (await screen.findByText('Time off')).closest('section') as HTMLElement;
    const chips = within(panel).getAllByText(/New Year's Day|Christmas Day/);
    expect(chips.map((c) => c.textContent)).toEqual(["New Year's Day", 'Christmas Day']);
  });

  it('renders company holidays sorted oldest first', async () => {
    getBusinessSettings.mockResolvedValue(
      withOverrides({ companyHolidays: ['2026-12-25|Christmas closure', '2026-01-01|New Year closure'] }),
    );
    render(<Settings />);
    await userEvent.click(await screen.findByRole('button', { name: /time off/i }));
    const panel = (await screen.findByText('Time off')).closest('section') as HTMLElement;
    // Scoped to the dated-row labels specifically: the panel subtitle itself
    // contains the substring "closures", which a loose text match would catch too.
    const labels = Array.from(panel.querySelectorAll('.settings__dated-label')).map((el) => el.textContent);
    expect(labels).toEqual(['New Year closure', 'Christmas closure']);
  });

  it('renders KinCare types with an unset rate flagged', async () => {
    getBusinessSettings.mockResolvedValue(withOverrides({ serviceRates: { 'Drop-in visit': '25.00', Overnight: '' } }));
    render(<Settings />);
    const panel = (await screen.findByText('KinCare types')).closest('section') as HTMLElement;
    expect(within(panel).getByText('25.00')).toBeInTheDocument();
    expect(within(panel).getByText('Not set')).toBeInTheDocument();
  });

  it('renders booking behavior toggles as On/Off text, not interactive controls', async () => {
    getBusinessSettings.mockResolvedValue(withOverrides({ autoConfirmRepeatKinfolk: true, snapRescheduleTo15Min: false }));
    render(<Settings />);
    const panel = (await screen.findByText('Booking behavior')).closest('section') as HTMLElement;
    expect(within(panel).getByText('On')).toBeInTheDocument();
    expect(within(panel).getByText('Off')).toBeInTheDocument();
    expect(within(panel).queryByRole('switch')).not.toBeInTheDocument();
  });

  it('renders branding defaults as hints, never a blank value', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    render(<Settings />);
    const panel = (await screen.findByText('Branding')).closest('section') as HTMLElement;
    expect(within(panel).getByText('Default: "AuntieOS"')).toBeInTheDocument();
  });

  it('renders the MyTribe portal summary', async () => {
    getBusinessSettings.mockResolvedValue(
      withOverrides({
        mytribePortal: {
          ...DEFAULT_BUSINESS_SETTINGS.mytribePortal,
          themeId: 'sunset',
          banner: { enabled: true, message: 'Closed for the holiday', tone: 'info', dismissMode: 'none', id: 'b1' },
        },
      }),
    );
    render(<Settings />);
    const panel = (await screen.findByText('MyTribe portal')).closest('section') as HTMLElement;
    expect(within(panel).getByText('sunset')).toBeInTheDocument();
    expect(within(panel).getByText('On: "Closed for the holiday"')).toBeInTheDocument();
  });

  it('shows "Never saved yet" when updatedAt is blank', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    render(<Settings />);
    expect(await screen.findByText('Never saved yet')).toBeInTheDocument();
  });

  it('renders "Edit settings" as a real, always-interactive button (the editor is now built)', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    render(<Settings />);
    await screen.findByText('Business profile');
    expect(screen.getByRole('button', { name: /edit settings/i })).toBeInTheDocument();
  });

  it('clicking "Edit settings" swaps the overview for the editor', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    render(<Settings />);
    await screen.findByText('Business profile');
    await userEvent.click(screen.getByRole('button', { name: /edit settings/i }));
    expect(screen.getByTestId('settings-edit-stub')).toBeInTheDocument();
    expect(screen.queryByText('Business profile')).not.toBeInTheDocument();
  });

  it('also calls an externally-supplied onEdit, if given, when "Edit settings" is clicked', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    const onEdit = vi.fn();
    render(<Settings onEdit={onEdit} />);
    await screen.findByText('Business profile');
    await userEvent.click(screen.getByRole('button', { name: /edit settings/i }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('settings-edit-stub')).toBeInTheDocument();
  });

  it('opens the notification gate in place, and its Back returns to the overview', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    render(<Settings />);
    await screen.findByText('Business profile');

    await userEvent.click(screen.getByRole('button', { name: /open notification gate/i }));
    expect(screen.getByTestId('notification-gate-stub')).toBeInTheDocument();
    expect(screen.queryByText('Business profile')).not.toBeInTheDocument();

    await userEvent.click(screen.getByText('stub: back to settings'));
    expect(await screen.findByText('Business profile')).toBeInTheDocument();
  });

  it('opens the Tags editor in place, and its Back returns to the overview', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    render(<Settings />);
    await screen.findByText('Business profile');

    await userEvent.click(screen.getByRole('button', { name: /open tags/i }));
    expect(screen.getByTestId('tags-editor-stub')).toBeInTheDocument();
    expect(screen.queryByText('Business profile')).not.toBeInTheDocument();

    await userEvent.click(screen.getByText('stub: back to settings from tags'));
    expect(await screen.findByText('Business profile')).toBeInTheDocument();
  });

  it('returning from the editor (onDone) reloads the overview', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    render(<Settings />);
    await screen.findByText('Business profile');
    await userEvent.click(screen.getByRole('button', { name: /edit settings/i }));
    getBusinessSettings.mockClear();
    await userEvent.click(screen.getByText('stub: back to overview'));
    expect(await screen.findByText('Business profile')).toBeInTheDocument();
    expect(getBusinessSettings).toHaveBeenCalledTimes(1);
  });
});
