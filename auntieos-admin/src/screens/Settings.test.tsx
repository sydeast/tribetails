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

// The Calendar section's OAuth half loads itself from callables. Mocked at the
// api seam rather than stubbed as a component, so the merge is asserted on the
// real panel: the whole complaint was that these two lived on separate tabs, and
// a stub would let them "merge" without either one rendering.
const googleCalendarApi = vi.hoisted(() => ({
  getGoogleCalendarConnection: vi.fn(),
  startGoogleCalendarConnect: vi.fn(),
  listGoogleCalendars: vi.fn(),
  setGoogleCalendarTargets: vi.fn(),
  pushVisitsToGoogleCalendar: vi.fn(),
  disconnectGoogleCalendar: vi.fn(),
}));
vi.mock('../api/googleCalendar', () => googleCalendarApi);

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
};

// Notifications and Tags are their own self-loading editors, exercised by
// NotificationGate.test.tsx / TagsEditor.test.tsx. Here they are stubs so this
// file asserts only Settings.tsx's OWN wiring: that a section mounts on its
// first visit (not before), and that no `onBack` is handed to an inline section
// (there is nowhere to go back to behind the always-present nav).
vi.mock('./NotificationGate', () => ({
  NotificationGate: ({ onBack }: { onBack?: () => void }) => (
    <div data-testid="notification-gate-stub" data-hasback={onBack ? 'yes' : 'no'}>
      notification gate
    </div>
  ),
}));
vi.mock('./TagsEditor', () => ({
  TagsEditor: ({ onBack }: { onBack?: () => void }) => (
    <div data-testid="tags-editor-stub" data-hasback={onBack ? 'yes' : 'no'}>
      tags editor
    </div>
  ),
}));

// The two callable-backed, self-loading sections. Their own behaviour lives in
// IntegrationsSection.test.tsx / GoogleCalendarSection.test.tsx; the callables
// are stubbed here so this file asserts only Settings.tsx's own wiring, and so
// opening a section never reaches for Firebase.
const getIntegrationsHealth = vi.fn();
vi.mock('../api/integrations', async (orig) => ({
  ...(await orig<typeof import('../api/integrations')>()),
  getIntegrationsHealth: () => getIntegrationsHealth(),
}));
// NOTE: ../api/googleCalendar is mocked ONCE, above (the hoisted
// googleCalendarApi). A second vi.mock of the same module here would clobber
// that one and take the merged Calendar panel's connect flow down with it,
// which is exactly what happened during the #158-era rebase of this file.

import { Settings } from './Settings';
/**
 * The Business profile TAB holds three panels since #519 (the text fields, the
 * time-zone picker, and the instant-save booking toggles), so a bare
 * `getByRole('button', { name: /save/i })` inside the tabpanel is ambiguous.
 * This narrows to the one `DenPanel` that owns a given control, which is what
 * these cases were always asserting about.
 */
function panelOwning(el: HTMLElement): HTMLElement {
  const owner = el.closest('.den-panel');
  if (!(owner instanceof HTMLElement)) throw new Error('control is not inside a DenPanel');
  return owner;
}

/**
 * A local fixture, not imported from the (partially mocked) api/settings module:
 * mirrors `DEFAULT_BUSINESS_SETTINGS` (FirestoreClient.kt's `BusinessSettings()`
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
  serviceDurations: {},
  businessHours: {},
  venmoHandle: '',
  paypalHandle: '',
  cashappHandle: '',
  paymentOptions: {},
  weatherLocation: '',
  observedUsHolidays: [],
  companyHolidays: [],
  specialHours: [],
  observeUsHolidays: false,
  defaultBookingMode: 'SPECIFIC_TIME',
  defaultCalendarView: 'MONTH',
  allowTimeBlockBooking: true,
  allowSpecificTimeBooking: true,
  enableConflictDetection: true,
  enableAutoReminder24h: true,
  defaultTimeBlockDurationHours: 4,
  travelBufferMinutes: 30,
  timeBlocks: [{ id: 'midday', label: 'Midday', startTime: '11:00', endTime: '15:00', active: true }],
  enableGPSTrackingForAllVisits: true,
  enablePhotoLocationTagging: true,
  requireArrivalDepartureVerification: true,
  arrivalRadiusMeters: 150,
  autoStartTrackingOnVisitStart: true,
  trackingAccuracy: 'HIGH',
  saveRoutesForDays: 90,
  allowClientLocationSharing: true,
  defaultEtaMinutes: 15,
  etaMinuteOptions: [5, 10, 15, 20, 30, 45, 60],
  draftRetentionDays: 30,
  draftRetentionOptions: [30, 60, 90],
  calendarSyncId: '',
  calendarSyncLastRunAt: '',
  calendarSyncLastStatus: '',
  calendarSyncLastImported: 0,
  calendarSyncLastError: '',
  autoConfirmRepeatKinfolk: false,
  snapRescheduleTo15Min: false,
  logoUrl: '',
  logoRemovedAt: '',
  brandWordmark: '',
  brandTagline: '',
  homeGreeting: '',
  homeAccentTail: '',
  householdTags: [],
  petTags: [],
  mytribePortal: {
    logoUrl: '',
    logoRemovedAt: '',
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

/** Click a section's nav tab and return the one panel that is now visible. */
async function openSection(tabName: string | RegExp): Promise<HTMLElement> {
  await userEvent.click(screen.getByRole('tab', { name: tabName }));
  return screen.getByRole('tabpanel');
}

beforeEach(() => {
  getIntegrationsHealth.mockReset();
  getBusinessSettings.mockReset();
  saveBusinessSettings.mockReset();
  for (const fn of Object.values(googleCalendarApi)) fn.mockReset();
  googleCalendarApi.getGoogleCalendarConnection.mockResolvedValue({
    connection: BLANK_GOOGLE_CONNECTION,
    freeBusyCalendarId: '',
    redirectUri: '',
  });
});

describe('Settings — section nav shell', () => {
  it('shows a loading state before the doc resolves', () => {
    getBusinessSettings.mockReturnValue(new Promise(() => {})); // never resolves
    render(<Settings />);
    expect(screen.getByText(/loading business settings/i)).toBeInTheDocument();
  });

  it('surfaces a load failure fail-loud, never a fabricated blank editor', async () => {
    getBusinessSettings.mockRejectedValue(new Error('permission-denied'));
    render(<Settings />);
    expect(await screen.findByText(/permission-denied/i)).toBeInTheDocument();
    // The nav tab labelled "Business profile" is always present; the FIELD is the
    // real tell that content rendered, and it must not on a failed load.
    expect(screen.queryByLabelText('Business name')).not.toBeInTheDocument();
  });

  it('offers Retry on a failed load and re-fetches on click', async () => {
    getBusinessSettings.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    render(<Settings />);
    await userEvent.click(await screen.findByRole('button', { name: /retry/i }));
    expect(await screen.findByLabelText('Business name')).toBeInTheDocument();
  });

  it('renders a vertical tablist with one tab per section, Business profile selected first', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    render(<Settings />);
    await screen.findByLabelText('Business name');

    const tablist = screen.getByRole('tablist', { name: /settings sections/i });
    expect(tablist).toHaveAttribute('aria-orientation', 'vertical');

    const tabs = within(tablist).getAllByRole('tab');
    // 13. It was 11: the 2026-07-31 calendar-tab merge took two calendar
    // features down to one tab, then mark 16 of the 2026-08-17 walk folded
    // Weather area and Booking behavior into Business profile ("it does not
    // need to be its own page with so little fields"). Issue #519 then added
    // the two sections for the twenty fields the clients decoded and none of
    // them edited: Booking rules and Visits and tracking. Integrations still
    // sits last, because it reports on outside services rather than editing
    // anything.
    expect(tabs).toHaveLength(13);
    expect(within(tablist).getByRole('tab', { name: 'Booking rules' })).toBeInTheDocument();
    expect(within(tablist).getByRole('tab', { name: 'Visits and tracking' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /weather area/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /booking behavior/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /google calendar/i })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Business profile' })).toHaveAttribute('aria-selected', 'true');
  });

  it('clicking a section tab swaps which single panel is shown', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    render(<Settings />);
    await screen.findByLabelText('Business name'); // Business profile is the default panel

    const panel = await openSection('Payments');
    expect(within(panel).getByLabelText('Venmo handle')).toBeInTheDocument();
    // The previous panel's field is no longer in the visible tabpanel.
    expect(within(panel).queryByLabelText('Business name')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Payments' })).toHaveAttribute('aria-selected', 'true');
  });

  /**
   * PR30: the fee schedule is a caption on this admin-only panel — it never
   * reaches the portal (see `payMethods` on `getMyHome`, and `PayOptions`,
   * neither of which carries `feeBps`/`feeFixedCents`). This also pins that
   * the caption stays a DESCRIPTION, not part of the field's accessible NAME:
   * `getByLabelText('Venmo handle')` above only keeps working because the
   * hint sits outside the wrapping <label>.
   */
  it('shows each processor’s fee schedule as a caption, exact figures', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    render(<Settings />);
    await screen.findByLabelText('Business name');

    const panel = await openSection('Payments');
    expect(within(panel).getByText('Venmo charges about 1.9% + $0.10 per payment.')).toBeInTheDocument();
    expect(within(panel).getByText('PayPal charges about 3.49% + $0.49 per payment.')).toBeInTheDocument();
    expect(within(panel).getByText('Cash App charges about 2.6% + $0.15 per payment.')).toBeInTheDocument();
    // The Venmo input's accessible name is still exactly its label, not the
    // label plus the hint text that follows it in the DOM.
    expect(within(panel).getByLabelText('Venmo handle')).toHaveAccessibleName('Venmo handle');
  });
});

describe('Settings, Calendar is one section holding both capabilities', () => {
  // INVERTED on 2026-07-25. This case used to assert the opposite ("shows the id
  // read-only with a reason, no editable control"), which pinned a wrong belief
  // rather than a behaviour: the free/busy sync runs as a service account inside
  // the Cloud Function and never needed the Google sign-in the old hint blamed.
  it('edits the calendar id and saves it through the shell, from the shell-mounted section', async () => {
    getBusinessSettings.mockResolvedValue(withOverrides({ calendarSyncId: '' }));
    saveBusinessSettings.mockResolvedValue({ updatedAt: '2026-07-25T10:00:00.000Z', updatedBy: 'a@b.c' });
    render(<Settings />);
    await screen.findByLabelText('Business name');

    const panel = await openSection('Calendar');
    const field = within(panel).getByLabelText('Calendar ID');
    await userEvent.type(field, 'team@group.calendar.google.com');
    await userEvent.click(within(panel).getByRole('button', { name: /^save$/i }));

    // Through the shell's shared `persist`, so it merges onto the same doc every
    // other section writes, and only this section's field is sent.
    expect(saveBusinessSettings).toHaveBeenCalledWith({
      calendarSyncId: 'team@group.calendar.google.com',
    });
  });

  it('carries BOTH capabilities in the one panel, each under its own sub-heading', async () => {
    // The operator complaint this merge answers: two tabs for one question.
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    render(<Settings />);
    await screen.findByLabelText('Business name');

    const panel = await openSection('Calendar');
    expect(within(panel).getByText('Free/busy import')).toBeInTheDocument();
    expect(within(panel).getByText('Editable calendars')).toBeInTheDocument();
    // The import's editor and the OAuth half's action, in the same tabpanel.
    expect(within(panel).getByLabelText('Calendar ID')).toBeInTheDocument();
    expect(
      await within(panel).findByRole('button', { name: /connect google calendar/i }),
    ).toBeInTheDocument();
  });

  it('keeps the OAuth half alive when business_settings cannot be read', async () => {
    // The two halves read different documents, so one being unreadable must not
    // black out the other. Merging the tabs must not merge the failure modes.
    getBusinessSettings.mockRejectedValue(new Error('permission-denied'));
    render(<Settings />);
    await screen.findByText(/permission-denied/i);

    const panel = await openSection('Calendar');
    expect(within(panel).queryByLabelText('Calendar ID')).not.toBeInTheDocument();
    expect(
      await within(panel).findByRole('button', { name: /connect google calendar/i }),
    ).toBeInTheDocument();
  });

  it('MyTribe portal shows the Home layout summary alongside its other editable fields', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    render(<Settings />);
    await screen.findByLabelText('Business name');

    const panel = await openSection('MyTribe portal');
    expect(within(panel).getByText('Home layout')).toBeInTheDocument();
    expect(within(panel).getByText('Default layout (no custom sections configured)')).toBeInTheDocument();
    expect(within(panel).getByLabelText('Theme id')).toBeEnabled();
  });
});

describe('Settings — self-loading sections mount lazily and inline', () => {
  it('does not mount the Notifications editor until its tab is opened, and passes no onBack', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    render(<Settings />);
    await screen.findByLabelText('Business name');
    expect(screen.queryByTestId('notification-gate-stub')).not.toBeInTheDocument();

    await openSection('Notifications');
    const stub = screen.getByTestId('notification-gate-stub');
    expect(stub).toBeInTheDocument();
    expect(stub).toHaveAttribute('data-hasback', 'no');
  });

  it('mounts the Tags editor inline on first visit, with no back button', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    render(<Settings />);
    await screen.findByLabelText('Business name');
    expect(screen.queryByTestId('tags-editor-stub')).not.toBeInTheDocument();

    await openSection('Tags');
    const stub = screen.getByTestId('tags-editor-stub');
    expect(stub).toBeInTheDocument();
    expect(stub).toHaveAttribute('data-hasback', 'no');
  });
});

describe('Settings — Business profile editor', () => {
  it('disables Save until a field is edited, then saves the patch and shows Saved', async () => {
    getBusinessSettings.mockResolvedValue(withOverrides({ businessName: 'Tribe Tails Care' }));
    saveBusinessSettings.mockResolvedValue({ updatedAt: '2026-07-17T12:00:00.000Z', updatedBy: 'auntie@tribetails.com' });
    render(<Settings />);
    const panel = screen.getByRole('tabpanel');
    const nameInput = await within(panel).findByLabelText('Business name');
    const fields = panelOwning(nameInput);
    const saveBtn = within(fields).getByRole('button', { name: /^save$/i });
    expect(saveBtn).toBeDisabled();

    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'New Name');
    expect(saveBtn).toBeEnabled();

    await userEvent.click(saveBtn);
    // `weatherLocation` rides along because this panel saves every field it
    // renders, and it renders that one since mark 16 moved it here.
    expect(saveBusinessSettings).toHaveBeenCalledWith({
      businessName: 'New Name',
      businessEmail: '',
      businessPhone: '',
      businessAddress: '',
      weatherLocation: '',
    });
    expect(await within(fields).findByText('Saved')).toBeInTheDocument();
    expect(within(fields).getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  it('shows a fail-loud error and keeps the field dirty when the save rejects', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    saveBusinessSettings.mockRejectedValue(new Error('permission-denied'));
    render(<Settings />);
    const panel = screen.getByRole('tabpanel');
    const nameInput = await within(panel).findByLabelText('Business name');
    const fields = panelOwning(nameInput);
    await userEvent.type(nameInput, 'X');
    await userEvent.click(within(fields).getByRole('button', { name: /^save$/i }));
    expect(await within(fields).findByText(/permission-denied/i)).toBeInTheDocument();
    expect(within(fields).getByRole('button', { name: /^save$/i })).toBeEnabled();
    expect(within(fields).queryByText('Saved')).not.toBeInTheDocument();
  });

  it('trims saved values', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    saveBusinessSettings.mockResolvedValue({ updatedAt: 'x', updatedBy: 'y' });
    render(<Settings />);
    const panel = screen.getByRole('tabpanel');
    const nameInput = await within(panel).findByLabelText('Business name');
    await userEvent.type(nameInput, '  Padded  ');
    await userEvent.click(within(panelOwning(nameInput)).getByRole('button', { name: /^save$/i }));
    expect(saveBusinessSettings).toHaveBeenCalledWith(expect.objectContaining({ businessName: 'Padded' }));
  });

  it('keeps an in-progress edit alive across a trip to another section (mounted, not reset)', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    saveBusinessSettings.mockResolvedValue({ updatedAt: 'x', updatedBy: 'y' });
    render(<Settings />);
    let panel = screen.getByRole('tabpanel');
    await userEvent.type(await within(panel).findByLabelText('Business name'), 'Half-typed');

    // Visit and save a DIFFERENT section.
    panel = await openSection('Payments');
    await userEvent.type(within(panel).getByLabelText('Venmo handle'), '@tribetails');
    // Issue #409: this panel's button names what it saves, because it is now a
    // toggle board rather than one more set of text boxes.
    await userEvent.click(within(panel).getByRole('button', { name: /save payment options/i }));
    await within(panel).findByText('Saved');

    // Back to Business profile: the unsaved edit must still be there.
    panel = await openSection('Business profile');
    expect(within(panel).getByLabelText('Business name')).toHaveValue('Half-typed');
  });
});

describe('Settings — Booking behavior (instant-save toggles)', () => {
  it('saves a toggle immediately and reflects the new value once the write resolves', async () => {
    getBusinessSettings.mockResolvedValue(withOverrides({ autoConfirmRepeatKinfolk: false }));
    saveBusinessSettings.mockResolvedValue({ updatedAt: 'x', updatedBy: 'y' });
    render(<Settings />);
    await screen.findByLabelText('Business name');
    const panel = await openSection('Business profile');
    const sw = within(panel).getByRole('switch', { name: /auto-confirm repeat kinfolk/i });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(sw);
    expect(saveBusinessSettings).toHaveBeenCalledWith({ autoConfirmRepeatKinfolk: true });
    expect(await within(panel).findByRole('switch', { name: /auto-confirm repeat kinfolk/i })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  /**
   * #517: this row used to be a permanently disabled placeholder on the wasm
   * Settings screen, for a field (`enableConflictDetection`) that persisted on
   * every model and that nothing on the server read. It is now the switch the
   * booking guard reads, so it has to persist like the other two.
   */
  it('persists "Block bookings during busy events" and reads the new value back', async () => {
    getBusinessSettings.mockResolvedValue(withOverrides({ enableConflictDetection: true }));
    saveBusinessSettings.mockResolvedValue({ updatedAt: 'x', updatedBy: 'y' });
    render(<Settings />);
    await screen.findByLabelText('Business name');
    const panel = await openSection('Business profile');
    const sw = within(panel).getByRole('switch', { name: /block bookings during busy events/i });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(sw);
    expect(saveBusinessSettings).toHaveBeenCalledWith({ enableConflictDetection: false });
    expect(
      await within(panel).findByRole('switch', { name: /block bookings during busy events/i }),
    ).toHaveAttribute('aria-checked', 'false');
  });

  it('renders a stored OFF as off and flips it back on', async () => {
    getBusinessSettings.mockResolvedValue(withOverrides({ enableConflictDetection: false }));
    saveBusinessSettings.mockResolvedValue({ updatedAt: 'x', updatedBy: 'y' });
    render(<Settings />);
    await screen.findByLabelText('Business name');
    const panel = await openSection('Business profile');
    const sw = within(panel).getByRole('switch', { name: /block bookings during busy events/i });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(sw);
    expect(saveBusinessSettings).toHaveBeenCalledWith({ enableConflictDetection: true });
  });

  it('surfaces a fail-loud error and leaves the switch unchanged on a failed toggle', async () => {
    getBusinessSettings.mockResolvedValue(withOverrides({ snapRescheduleTo15Min: false }));
    saveBusinessSettings.mockRejectedValue(new Error('offline'));
    render(<Settings />);
    await screen.findByLabelText('Business name');
    const panel = await openSection('Business profile');
    await userEvent.click(within(panel).getByRole('switch', { name: /snap drag-to-reschedule/i }));
    expect(await within(panel).findByText(/offline/i)).toBeInTheDocument();
    expect(within(panel).getByRole('switch', { name: /snap drag-to-reschedule/i })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });
});

/**
 * Mark 16 of the 2026-08-17 walk: "move this and weather area to related
 * setting pages. it does not need to be its own page with so little fields".
 * The operator named Business profile. These pin that both arrived, and that
 * the two save models did not get merged on the way.
 */
describe('Settings — Business profile absorbed the two thin sections', () => {
  it('carries the weather field, labelled so it is not read as a second address', async () => {
    getBusinessSettings.mockResolvedValue(withOverrides({ weatherLocation: 'Austin, TX' }));
    render(<Settings />);
    const panel = screen.getByRole('tabpanel');
    expect(await within(panel).findByLabelText('Weather area')).toHaveValue('Austin, TX');
    expect(within(panel).getByLabelText('Address')).toBeInTheDocument();
    expect(within(panel).getByText(/not a street address/i)).toBeInTheDocument();
  });
  it('carries the booking toggles as their OWN panel, away from the staged Save', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    render(<Settings />);
    const panel = screen.getByRole('tabpanel');
    await within(panel).findByLabelText('Business name');
    expect(within(panel).getByRole('switch', { name: /auto-confirm repeat kinfolk/i })).toBeInTheDocument();
    expect(within(panel).getByRole('switch', { name: /snap drag-to-reschedule/i })).toBeInTheDocument();
    expect(within(panel).getByRole('switch', { name: /block bookings during busy events/i })).toBeInTheDocument();
    // NO Save button in the toggles' own panel. They write on every flip, so a
    // Save button beside them would be a lie about what is already stored. The
    // two Saves in this tab belong to the sibling panels (the text fields, and
    // #519's time-zone picker), which is why this is scoped to the toggle panel
    // rather than counting buttons across the whole tab.
    const togglePanel = panelOwning(
      within(panel).getByRole('switch', { name: /auto-confirm repeat kinfolk/i }),
    );
    expect(within(togglePanel).queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
    expect(within(panel).getAllByRole('button', { name: /^save$/i })).toHaveLength(2);
  });
});
describe('Settings — real editors wire through the shared persist', () => {
  it('Business hours: a per-day toggle saves the merged businessHours patch', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    saveBusinessSettings.mockResolvedValue({ updatedAt: 'x', updatedBy: 'y' });
    render(<Settings />);
    await screen.findByLabelText('Business name');
    const panel = await openSection('Business hours');
    await userEvent.click(within(panel).getByRole('switch', { name: 'Toggle Monday open' }));
    await userEvent.click(within(panel).getByRole('button', { name: /^save$/i }));
    expect(saveBusinessSettings).toHaveBeenCalledWith({ businessHours: { Monday: '09:00-17:00' } });
    expect(await within(panel).findByText('Saved')).toBeInTheDocument();
  });

  it('Time off: a toggled US holiday saves through the shared persist patch', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    saveBusinessSettings.mockResolvedValue({ updatedAt: 'x', updatedBy: 'y' });
    render(<Settings />);
    await screen.findByLabelText('Business name');
    const panel = await openSection('Time off');
    await userEvent.click(within(panel).getByRole('switch', { name: 'Toggle Juneteenth observed' }));
    await userEvent.click(within(panel).getByRole('button', { name: /^save$/i }));
    expect(saveBusinessSettings).toHaveBeenCalledWith({
      observedUsHolidays: ['juneteenth'],
      companyHolidays: [],
      specialHours: [],
    });
  });

  it('KinCare types: adding a rate row saves the folded serviceRates map', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    saveBusinessSettings.mockResolvedValue({ updatedAt: 'x', updatedBy: 'y' });
    render(<Settings />);
    await screen.findByLabelText('Business name');
    const panel = await openSection('KinCare types');
    await userEvent.type(within(panel).getByPlaceholderText('e.g. Drop-in visit'), 'Walk');
    await userEvent.click(within(panel).getByRole('button', { name: /^add$/i }));
    await userEvent.click(within(panel).getByRole('button', { name: /^save$/i }));
    expect(saveBusinessSettings).toHaveBeenCalledWith({ serviceRates: { Walk: '' }, serviceDurations: {} });
  });
});

describe('Settings — MyTribe portal editor', () => {
  it('disables the banner message field until the banner toggle is on', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    render(<Settings />);
    await screen.findByLabelText('Business name');
    const panel = await openSection('MyTribe portal');
    expect(within(panel).getByLabelText('Banner message')).toBeDisabled();
    await userEvent.click(within(panel).getByRole('switch', { name: /toggle the portal top banner/i }));
    expect(within(panel).getByLabelText('Banner message')).toBeEnabled();
  });

  it('saves the whole portal object on Save and clears dirty', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    saveBusinessSettings.mockResolvedValue({ updatedAt: 'x', updatedBy: 'y' });
    render(<Settings />);
    await screen.findByLabelText('Business name');
    const panel = await openSection('MyTribe portal');
    const themeInput = within(panel).getByLabelText('Theme id');
    await userEvent.clear(themeInput);
    await userEvent.type(themeInput, 'sunset');
    await userEvent.click(within(panel).getByRole('button', { name: /^save$/i }));
    expect(saveBusinessSettings).toHaveBeenCalledWith({
      mytribePortal: expect.objectContaining({ themeId: 'sunset' }),
    });
    expect(await within(panel).findByText('Saved')).toBeInTheDocument();
  });

  it('Cancel reverts unsaved portal edits', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    render(<Settings />);
    await screen.findByLabelText('Business name');
    const panel = await openSection('MyTribe portal');
    const themeInput = within(panel).getByLabelText('Theme id');
    await userEvent.clear(themeInput);
    await userEvent.type(themeInput, 'sunset');
    await userEvent.click(within(panel).getByRole('button', { name: /cancel/i }));
    expect(within(panel).getByLabelText('Theme id')).toHaveValue('default');
    expect(within(panel).getByRole('button', { name: /^save$/i })).toBeDisabled();
  });
});

// ISSUE #397 M10: the Home layout editor. `mt.home.sections` defaults to `[]`
// on DEFAULT_BUSINESS_SETTINGS, which the editor materializes into the full
// canonical row list (see `effectiveHomeSections`) so there's always something
// on screen to reorder, toggle, and cap — and so a reorder/toggle/limit edit
// starting from that empty default writes back the WHOLE five-row array, not
// a diff of one.
describe('Settings — MyTribe portal Home layout editor', () => {
  it('shows a row for every catalogue section, even with no config saved yet', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    render(<Settings />);
    await screen.findByLabelText('Business name');
    const panel = await openSection('MyTribe portal');

    for (const label of ['Live visit', 'Up next', 'Recent KinTales', 'Tribe roster', 'Quick start']) {
      expect(within(panel).getByText(label)).toBeInTheDocument();
    }
    // Top and bottom rows can't move further in their own direction.
    expect(within(panel).getByRole('button', { name: 'Move Live visit up' })).toBeDisabled();
    expect(within(panel).getByRole('button', { name: 'Move Quick start down' })).toBeDisabled();
  });

  it('reordering with the down arrow moves the section, and Save writes the new order', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    saveBusinessSettings.mockResolvedValue({ updatedAt: 'x', updatedBy: 'y' });
    render(<Settings />);
    await screen.findByLabelText('Business name');
    const panel = await openSection('MyTribe portal');

    await userEvent.click(within(panel).getByRole('button', { name: 'Move Live visit down' }));
    const rows = within(panel).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Up next');
    expect(rows[1]).toHaveTextContent('Live visit');

    await userEvent.click(within(panel).getByRole('button', { name: /^save$/i }));
    expect(saveBusinessSettings).toHaveBeenCalledWith({
      mytribePortal: expect.objectContaining({
        home: {
          sections: [
            { id: 'upNext', enabled: true, limit: 0 },
            { id: 'liveVisit', enabled: true, limit: 0 },
            { id: 'tales', enabled: true, limit: 0 },
            { id: 'roster', enabled: true, limit: 0 },
            { id: 'quickStart', enabled: true, limit: 0 },
          ],
        },
      }),
    });
  });

  it('turning a section off is a real, savable edit', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    saveBusinessSettings.mockResolvedValue({ updatedAt: 'x', updatedBy: 'y' });
    render(<Settings />);
    await screen.findByLabelText('Business name');
    const panel = await openSection('MyTribe portal');

    await userEvent.click(within(panel).getByRole('switch', { name: 'Show Tribe roster on Home' }));
    await userEvent.click(within(panel).getByRole('button', { name: /^save$/i }));

    const changes = saveBusinessSettings.mock.calls[0]?.[0] as {
      mytribePortal: { home: { sections: Array<{ id: string; enabled: boolean }> } };
    };
    const roster = changes.mytribePortal.home.sections.find((s) => s.id === 'roster');
    expect(roster).toEqual({ id: 'roster', enabled: false, limit: 0 });
  });

  it('setting a limit round-trips through Save', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    saveBusinessSettings.mockResolvedValue({ updatedAt: 'x', updatedBy: 'y' });
    render(<Settings />);
    await screen.findByLabelText('Business name');
    const panel = await openSection('MyTribe portal');

    const upNextRow = within(panel).getByText('Up next').closest('li') as HTMLElement;
    const limitInput = within(upNextRow).getByLabelText('Limit');
    await userEvent.clear(limitInput);
    await userEvent.type(limitInput, '5');
    await userEvent.click(within(panel).getByRole('button', { name: /^save$/i }));

    const changes = saveBusinessSettings.mock.calls[0]?.[0] as {
      mytribePortal: { home: { sections: Array<{ id: string; limit: number }> } };
    };
    const upNext = changes.mytribePortal.home.sections.find((s) => s.id === 'upNext');
    expect(upNext).toEqual({ id: 'upNext', enabled: true, limit: 5 });
  });

  it('appends a catalogue section a partial saved array had dropped, disabled and reachable', async () => {
    getBusinessSettings.mockResolvedValue(
      withOverrides({
        mytribePortal: {
          ...DEFAULT_BUSINESS_SETTINGS.mytribePortal,
          home: { sections: [{ id: 'upNext', enabled: true, limit: 5 }] },
        },
      }),
    );
    render(<Settings />);
    await screen.findByLabelText('Business name');
    const panel = await openSection('MyTribe portal');

    // upNext is the only configured row; every other catalogue section is
    // still on screen (disabled), never silently unreachable.
    expect(within(panel).getByRole('switch', { name: 'Show Up next on Home' })).toBeChecked();
    expect(within(panel).getByRole('switch', { name: 'Show Live visit on Home' })).not.toBeChecked();
    expect(within(panel).getByRole('switch', { name: 'Show Quick start on Home' })).not.toBeChecked();
  });
});
describe('Settings: Integrations is a report, and its Google row hands off', () => {
  const HEALTH = {
    checkedAt: '2026-07-31T12:00:00.000Z',
    declaredKnown: true,
    declaredError: '',
    integrations: [
      {
        key: 'googleCalendar',
        name: 'Google Calendar',
        purpose: 'Writes visits onto the calendar.',
        status: 'configured' as const,
        summary: 'No Google account has been connected yet.',
        secrets: [],
        liveness: { outcome: 'fail' as const, detail: 'Not connected.' },
        remediation: '',
        externalStep: '',
        // The whole point of the field: this row reports, and the section named
        // here is the one that actually connects. 'googleCalendar' is the
        // RETIRED id on purpose: an older deployed server may still send it,
        // and the alias in Settings.tsx must land it on the merged Calendar tab.
        ownedBySection: 'googleCalendar',
      },
    ],
  };
  it('does not ask the server until the section is opened', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    getIntegrationsHealth.mockResolvedValue(HEALTH);
    render(<Settings />);
    await screen.findByLabelText('Business name');
    expect(getIntegrationsHealth).not.toHaveBeenCalled();
    await openSection('Integrations');
    expect(getIntegrationsHealth).toHaveBeenCalledTimes(1);
  });
  it('the Google row really moves the operator to the section that owns the connect flow', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    getIntegrationsHealth.mockResolvedValue(HEALTH);
    render(<Settings />);
    await screen.findByLabelText('Business name');
    await openSection('Integrations');
    await userEvent.click(await screen.findByRole('button', { name: 'Open Google Calendar settings' }));
    expect(screen.getByRole('tab', { name: 'Calendar' })).toHaveAttribute('aria-selected', 'true');
  });
});
