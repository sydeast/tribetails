// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BusinessSettings } from '../api/settings';

const getBusinessSettings = vi.fn();
vi.mock('../api/settings', async (orig) => ({
  ...(await orig<typeof import('../api/settings')>()),
  getBusinessSettings: () => getBusinessSettings(),
}));

const saveBusinessSettings = vi.fn();
vi.mock('../api/settingsWrite', () => ({ saveBusinessSettings: (patch: unknown) => saveBusinessSettings(patch) }));

import { SettingsEdit } from './SettingsEdit';

/** Local fixture (not imported from the mocked module), mirrors DEFAULT_BUSINESS_SETTINGS. */
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
  saveBusinessSettings.mockReset();
});

describe('SettingsEdit', () => {
  it('shows a loading state before the doc resolves', () => {
    getBusinessSettings.mockReturnValue(new Promise(() => {}));
    render(<SettingsEdit onDone={vi.fn()} />);
    expect(screen.getByText(/loading business settings/i)).toBeInTheDocument();
  });

  it('surfaces a load failure fail-loud with Retry', async () => {
    getBusinessSettings.mockRejectedValueOnce(new Error('permission-denied')).mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    render(<SettingsEdit onDone={vi.fn()} />);
    expect(await screen.findByText(/permission-denied/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('Business profile')).toBeInTheDocument();
  });

  it('names every deferred section in the on-screen banner', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    render(<SettingsEdit onDone={vi.fn()} />);
    await screen.findByText('Business profile');
    expect(screen.getByText(/business hours/i)).toBeInTheDocument();
    expect(screen.getByText(/kincare type rates/i)).toBeInTheDocument();
    expect(screen.getByText(/google calendar sync/i)).toBeInTheDocument();
    expect(screen.getByText(/mytribe home layout/i)).toBeInTheDocument();
  });

  it('calls onDone when "Back to overview" is clicked', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    const onDone = vi.fn();
    render(<SettingsEdit onDone={onDone} />);
    await screen.findByText('Business profile');
    await userEvent.click(screen.getByRole('button', { name: /back to overview/i }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  describe('Business profile', () => {
    it('disables Save until a field is edited, then saves the patch and shows Saved', async () => {
      getBusinessSettings.mockResolvedValue(withOverrides({ businessName: 'Tribe Tails Care' }));
      saveBusinessSettings.mockResolvedValue({ updatedAt: '2026-07-17T12:00:00.000Z', updatedBy: 'auntie@tribetails.com' });
      render(<SettingsEdit onDone={vi.fn()} />);
      const panel = (await screen.findByText('Business profile')).closest('section') as HTMLElement;
      const saveBtn = within(panel).getByRole('button', { name: /^save$/i });
      expect(saveBtn).toBeDisabled();

      const nameInput = within(panel).getByLabelText('Business name');
      await userEvent.clear(nameInput);
      await userEvent.type(nameInput, 'New Name');
      expect(saveBtn).toBeEnabled();

      await userEvent.click(saveBtn);
      expect(saveBusinessSettings).toHaveBeenCalledWith({
        businessName: 'New Name',
        businessEmail: '',
        businessPhone: '',
        businessAddress: '',
      });
      expect(await within(panel).findByText('Saved')).toBeInTheDocument();
      expect(within(panel).getByRole('button', { name: /^save$/i })).toBeDisabled();
    });

    it('shows a fail-loud error and keeps the field dirty when the save rejects', async () => {
      getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
      saveBusinessSettings.mockRejectedValue(new Error('permission-denied'));
      render(<SettingsEdit onDone={vi.fn()} />);
      const panel = (await screen.findByText('Business profile')).closest('section') as HTMLElement;
      const nameInput = within(panel).getByLabelText('Business name');
      await userEvent.type(nameInput, 'X');
      await userEvent.click(within(panel).getByRole('button', { name: /^save$/i }));
      expect(await within(panel).findByText(/permission-denied/i)).toBeInTheDocument();
      expect(within(panel).getByRole('button', { name: /^save$/i })).toBeEnabled();
      expect(within(panel).queryByText('Saved')).not.toBeInTheDocument();
    });

    it('trims saved values', async () => {
      getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
      saveBusinessSettings.mockResolvedValue({ updatedAt: 'x', updatedBy: 'y' });
      render(<SettingsEdit onDone={vi.fn()} />);
      const panel = (await screen.findByText('Business profile')).closest('section') as HTMLElement;
      await userEvent.type(within(panel).getByLabelText('Business name'), '  Padded  ');
      await userEvent.click(within(panel).getByRole('button', { name: /^save$/i }));
      expect(saveBusinessSettings).toHaveBeenCalledWith(expect.objectContaining({ businessName: 'Padded' }));
    });

    it('does not clobber an in-progress edit here when a sibling section saves', async () => {
      getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
      saveBusinessSettings.mockResolvedValue({ updatedAt: 'x', updatedBy: 'y' });
      render(<SettingsEdit onDone={vi.fn()} />);
      const profilePanel = (await screen.findByText('Business profile')).closest('section') as HTMLElement;
      const paymentsPanel = (await screen.findByText('Payment options')).closest('section') as HTMLElement;

      // Start an unsaved edit in Business profile.
      await userEvent.type(within(profilePanel).getByLabelText('Business name'), 'Half-typed');

      // Save a DIFFERENT section (Payments).
      await userEvent.type(within(paymentsPanel).getByLabelText('Venmo handle'), '@tribetails');
      await userEvent.click(within(paymentsPanel).getByRole('button', { name: /^save$/i }));
      await within(paymentsPanel).findByText('Saved');

      // Business profile's unsaved edit must survive.
      expect(within(profilePanel).getByLabelText('Business name')).toHaveValue('Half-typed');
    });
  });

  describe('Booking behavior', () => {
    it('saves a toggle immediately and reflects the new value once the write resolves', async () => {
      getBusinessSettings.mockResolvedValue(withOverrides({ autoConfirmRepeatKinfolk: false }));
      saveBusinessSettings.mockResolvedValue({ updatedAt: 'x', updatedBy: 'y' });
      render(<SettingsEdit onDone={vi.fn()} />);
      const panel = (await screen.findByText('Booking behavior')).closest('section') as HTMLElement;
      const sw = within(panel).getByRole('switch', { name: /auto-confirm repeat kinfolk/i });
      expect(sw).toHaveAttribute('aria-checked', 'false');
      await userEvent.click(sw);
      expect(saveBusinessSettings).toHaveBeenCalledWith({ autoConfirmRepeatKinfolk: true });
      expect(await within(panel).findByRole('switch', { name: /auto-confirm repeat kinfolk/i })).toHaveAttribute(
        'aria-checked',
        'true',
      );
    });

    it('surfaces a fail-loud error and leaves the switch unchanged on a failed toggle', async () => {
      getBusinessSettings.mockResolvedValue(withOverrides({ snapRescheduleTo15Min: false }));
      saveBusinessSettings.mockRejectedValue(new Error('offline'));
      render(<SettingsEdit onDone={vi.fn()} />);
      const panel = (await screen.findByText('Booking behavior')).closest('section') as HTMLElement;
      const sw = within(panel).getByRole('switch', { name: /snap drag-to-reschedule/i });
      await userEvent.click(sw);
      expect(await within(panel).findByText(/offline/i)).toBeInTheDocument();
      expect(within(panel).getByRole('switch', { name: /snap drag-to-reschedule/i })).toHaveAttribute(
        'aria-checked',
        'false',
      );
    });
  });

  describe('MyTribe portal', () => {
    it('disables the banner message field until the banner toggle is on', async () => {
      getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
      render(<SettingsEdit onDone={vi.fn()} />);
      const panel = (await screen.findByText('MyTribe portal')).closest('section') as HTMLElement;
      expect(within(panel).getByLabelText('Banner message')).toBeDisabled();
      await userEvent.click(within(panel).getByRole('switch', { name: /toggle the portal top banner/i }));
      expect(within(panel).getByLabelText('Banner message')).toBeEnabled();
    });

    it('saves the whole portal object on Save and clears dirty', async () => {
      getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
      saveBusinessSettings.mockResolvedValue({ updatedAt: 'x', updatedBy: 'y' });
      render(<SettingsEdit onDone={vi.fn()} />);
      const panel = (await screen.findByText('MyTribe portal')).closest('section') as HTMLElement;
      const themeInput = within(panel).getByLabelText('Theme id');
      await userEvent.clear(themeInput);
      await userEvent.type(themeInput, 'sunset');
      const saveBtn = within(panel).getByRole('button', { name: /^save$/i });
      expect(saveBtn).toBeEnabled();
      await userEvent.click(saveBtn);
      expect(saveBusinessSettings).toHaveBeenCalledWith({
        mytribePortal: expect.objectContaining({ themeId: 'sunset' }),
      });
      expect(await within(panel).findByText('Saved')).toBeInTheDocument();
    });

    it('Cancel reverts unsaved portal edits', async () => {
      getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
      render(<SettingsEdit onDone={vi.fn()} />);
      const panel = (await screen.findByText('MyTribe portal')).closest('section') as HTMLElement;
      const themeInput = within(panel).getByLabelText('Theme id');
      await userEvent.clear(themeInput);
      await userEvent.type(themeInput, 'sunset');
      await userEvent.click(within(panel).getByRole('button', { name: /cancel/i }));
      expect(within(panel).getByLabelText('Theme id')).toHaveValue('default');
      expect(within(panel).getByRole('button', { name: /^save$/i })).toBeDisabled();
    });
  });
});
