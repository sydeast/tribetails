// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
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
  calendarAutoSyncLastRunAt: '',
  calendarAutoSyncLastStatus: '',
  calendarAutoSyncLastAction: '',
  calendarAutoSyncLastSessionId: '',
  calendarAutoSyncLastError: '',
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
vi.mock('./settings/DoNotSendSection', () => ({
  DoNotSendSection: () => <div data-testid="do-not-send-stub">do not send</div>,
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

// Time off reads the visit calendar live (closure impact). An empty calendar,
// as TimeOffEditor.test.tsx uses; unmocked, it streamed production Firestore
// (#1138).
vi.mock('../lib/firestore', async (orig) => ({
  ...(await orig<typeof import('../lib/firestore')>()),
  useCollection: () => ({ status: 'ready', data: [] }),
}));
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
  privacyPolicyUrl: '',
  timeZone: 'America/New_York',
  serviceRates: {},
  serviceDurations: {},
  serviceStartTimeBooking: {},
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
  voiceLiveTransferEnabled: true, // issue #397; TRUE is this field's default
  householdNotificationsLive: false, // PR #943; nothing reaches a household until this is on
  householdNotificationHour: null, // and no job has a cadence until the operator picks one
  scheduleDigestHour: null,
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

  /**
   * #1564. Operator ruling, 2026-11-05 docket: every business email goes to
   * `businessEmail`; while it is blank, Settings says they have nowhere to go.
   */
  it('#1564: says business emails have nowhere to go while the business email is blank', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    render(<Settings />);
    await screen.findByLabelText('Business name');
    expect(screen.getByText(/Business emails have nowhere to go until this is filled/)).toBeInTheDocument();
  });

  it('#1564: drops the warning once a business email is stored', async () => {
    getBusinessSettings.mockResolvedValue({ ...DEFAULT_BUSINESS_SETTINGS, businessEmail: 'pawsome@hanasamku.com' });
    render(<Settings />);
    await screen.findByLabelText('Business name');
    expect(screen.queryByText(/Business emails have nowhere to go/)).not.toBeInTheDocument();
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
    // 11. It was 11 originally too, by coincidence: the 2026-07-31
    // calendar-tab merge took two calendar features down to one tab, then
    // mark 16 of the 2026-08-17 walk folded Weather area and Booking behavior
    // into Business profile ("it does not need to be its own page with so
    // little fields"). Issue #519 then added the two sections for the twenty
    // fields the clients decoded and none of them edited: Booking rules and
    // Visits and tracking, making 13. Issue #397 then added Phone line, the
    // press-3 live transfer, next to Business hours because it is gated on
    // them, making 14. Issue #712 then folded the separate Branding tab back
    // into Business profile, back down to 13. Issue #711 then folded Visits
    // and tracking into KinCare Settings (renamed from KinCare types), down
    // to 12. Issue #715 then folded the Calendar tab into Integrations, down
    // to 11. Integrations still sits last, because it reports on outside
    // services rather than editing anything. Issue #957 then added Email
    // frame after Notifications, making 12.
    expect(tabs).toHaveLength(12);
    expect(within(tablist).getByRole('tab', { name: 'Email frame' })).toBeInTheDocument();
    expect(within(tablist).getByRole('tab', { name: 'Booking rules' })).toBeInTheDocument();
    expect(within(tablist).getByRole('tab', { name: 'KinCare Settings' })).toBeInTheDocument();
    expect(within(tablist).getByRole('tab', { name: 'Phone line' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /weather area/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /booking behavior/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /google calendar/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Branding' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Visits and tracking' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'KinCare types' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Calendar' })).not.toBeInTheDocument();
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
});

// ISSUE #755, checklist line Settings: the screen matched to
// `ui-ideas/auntieos-settings-2026-05-27.html` on the navy ground.
describe('Settings: the mock hero, nav panel and Scheduling rows', () => {
  it('heads the screen with the mock kicker and title, the last save as the detail line', async () => {
    getBusinessSettings.mockResolvedValue(
      withOverrides({ updatedAt: '2026-07-31T12:00:00.000Z', updatedBy: 'auntie@example.com' }),
    );
    render(<Settings />);
    await screen.findByLabelText('Business name');

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('How the Den runs.');
    expect(heading.querySelector('.den-heading-accent')).toHaveTextContent('runs.');
    expect(document.querySelector('.den-heading-kicker')).toHaveTextContent('The Den · Settings');
    // The stamp is a VALUE, so it sits on the heading's detail line, never as
    // a stray paragraph between the band and the columns.
    const detail = document.querySelector('.den-heading-detail');
    expect(detail).toHaveTextContent(/^Last saved .* by auntie@example\.com$/);
    expect(document.querySelector('.settings__updated')).toBeNull();
  });

  it('draws the nav as its own panel: one glyph per tab, the label the whole accessible name', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    render(<Settings />);
    await screen.findByLabelText('Business name');

    const tablist = screen.getByRole('tablist', { name: /settings sections/i });
    expect(tablist).toHaveClass('settings__nav');
    const tabs = within(tablist).getAllByRole('tab');
    for (const tab of tabs) {
      const icon = tab.querySelector('svg.settings__nav-icon');
      expect(icon, `${tab.textContent ?? ''} has no glyph`).not.toBeNull();
      expect(icon).toHaveAttribute('aria-hidden', 'true');
    }
    // The open row paints cream; the modifier is what the stylesheet keys on.
    expect(screen.getByRole('tab', { name: 'Business profile' })).toHaveClass('settings__nav-item--active');
    expect(screen.getByRole('tab', { name: 'Business hours' })).not.toHaveClass('settings__nav-item--active');
  });

  it('#1594: opening a section reports it to the route, and the route opens it again on reload or Back', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    const onSectionChange = vi.fn();
    const { rerender } = render(<Settings onSectionChange={onSectionChange} />);
    await screen.findByLabelText('Business name');

    await userEvent.click(screen.getByRole('tab', { name: 'Business hours' }));
    expect(onSectionChange).toHaveBeenLastCalledWith('businessHours');

    // The URL says Booking rules (a reload of a bookmark, or Back): the screen follows.
    rerender(<Settings initialSection="bookingRules" onSectionChange={onSectionChange} />);
    expect(screen.getByRole('tab', { name: 'Booking rules' })).toHaveClass('settings__nav-item--active');
    expect(screen.getByRole('tab', { name: 'Business hours' })).not.toHaveClass('settings__nav-item--active');
  });

  it('#1597: moving through the nav with the arrow keys leaves exactly one section highlighted', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    render(<Settings />);
    await screen.findByLabelText('Business name');

    await userEvent.click(screen.getByRole('tab', { name: 'Business profile' }));
    await userEvent.keyboard('{ArrowDown}');

    const tablist = screen.getByRole('tablist', { name: /settings sections/i });
    const highlighted = within(tablist)
      .getAllByRole('tab')
      .filter((t) => t.classList.contains('settings__nav-item--active'));
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0]).toHaveFocus();
    expect(highlighted[0]).not.toHaveAccessibleName('Business profile');
  });

  it('titles the toggle panel Scheduling and draws the mock rows, in the mock order, each with its note', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    render(<Settings />);
    const panel = screen.getByRole('tabpanel');
    await within(panel).findByLabelText('Business name');

    const scheduling = panelOwning(within(panel).getByRole('switch', { name: /block bookings during busy events/i }));
    expect(within(scheduling).getByRole('heading', { name: 'Scheduling' })).toBeInTheDocument();
    expect(within(panel).queryByRole('heading', { name: 'Booking behavior' })).not.toBeInTheDocument();

    const switches = within(scheduling).getAllByRole('switch');
    expect(switches.map((s) => s.getAttribute('aria-label'))).toEqual([
      'Toggle block bookings during busy events',
      'Toggle snap drag-to-reschedule to 15 min',
      'Toggle auto-confirm repeat kinfolk',
    ]);
    const notes = [...scheduling.querySelectorAll('.settingsEdit__toggleNote')].map((n) => n.textContent);
    expect(notes).toEqual([
      'Stop new visits from landing on top of a Google Calendar block.',
      'Visits align to quarter-hour slots when dragged.',
      'Trusted kinfolk bookings skip manual approval.',
    ]);
    expect(scheduling.querySelectorAll('.settingsEdit__toggleRow--ruled')).toHaveLength(3);
  });
});

describe('Settings: the Payments panel', () => {
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

// ISSUE #715: Calendar lives inside Integrations now. Opening it is a click
// on the Google Calendar row's toggle, in place, rather than a tab switch.
const HEALTH_WITH_GOOGLE = {
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
      ownedBySection: 'googleCalendar',
    },
  ],
};

async function openCalendarFromIntegrations(): Promise<HTMLElement> {
  const panel = await openSection('Integrations');
  await userEvent.click(await within(panel).findByRole('button', { name: 'Open Google Calendar settings' }));
  return panel;
}

describe('Settings, Calendar lives inside Integrations holding both capabilities', () => {
  // INVERTED on 2026-07-25. This case used to assert the opposite ("shows the id
  // read-only with a reason, no editable control"), which pinned a wrong belief
  // rather than a behaviour: the free/busy sync runs as a service account inside
  // the Cloud Function and never needed the Google sign-in the old hint blamed.
  it('edits the calendar id and saves it through the shell, opened in place from Integrations', async () => {
    getBusinessSettings.mockResolvedValue(withOverrides({ calendarSyncId: '' }));
    saveBusinessSettings.mockResolvedValue({ updatedAt: '2026-07-25T10:00:00.000Z', updatedBy: 'a@b.c' });
    getIntegrationsHealth.mockResolvedValue(HEALTH_WITH_GOOGLE);
    render(<Settings />);
    await screen.findByLabelText('Business name');

    const panel = await openCalendarFromIntegrations();
    const field = within(panel).getByLabelText('Calendar ID');
    await userEvent.type(field, 'team@group.calendar.google.com');
    await userEvent.click(within(panel).getByRole('button', { name: /^save$/i }));

    // Through the shell's shared `persist`, so it merges onto the same doc every
    // other section writes, and only this section's field is sent.
    expect(saveBusinessSettings).toHaveBeenCalledWith({
      calendarSyncId: 'team@group.calendar.google.com',
    });
  });

  it('carries BOTH capabilities inline, each under its own sub-heading', async () => {
    // The operator complaint this merge answers: Calendar needs to be under
    // Integrations, not a tab of its own.
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    getIntegrationsHealth.mockResolvedValue(HEALTH_WITH_GOOGLE);
    render(<Settings />);
    await screen.findByLabelText('Business name');

    const panel = await openCalendarFromIntegrations();
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
    getIntegrationsHealth.mockResolvedValue(HEALTH_WITH_GOOGLE);
    render(<Settings />);
    await screen.findByText(/permission-denied/i);

    const panel = await openCalendarFromIntegrations();
    expect(within(panel).queryByLabelText('Calendar ID')).not.toBeInTheDocument();
    expect(
      await within(panel).findByRole('button', { name: /connect google calendar/i }),
    ).toBeInTheDocument();
  });
});

describe('Settings: MyTribe portal editor extras', () => {
  it('MyTribe portal shows the Home layout summary alongside its other editable fields', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    render(<Settings />);
    await screen.findByLabelText('Business name');

    const panel = await openSection('MyTribe portal');
    expect(within(panel).getByText('Home layout')).toBeInTheDocument();
    expect(within(panel).getByText('Default layout (no custom sections configured)')).toBeInTheDocument();
    expect(within(panel).getByLabelText('Theme')).toBeEnabled();
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
    // #1783: only the edited field travels. The server checks the fields in the
    // save, so an untouched one (a stored bad email, say) must not ride along.
    expect(saveBusinessSettings).toHaveBeenCalledWith({ businessName: 'New Name' });
    expect(await within(fields).findByText('Saved')).toBeInTheDocument();
    expect(within(fields).getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  /**
   * #1409: the name is required. A document with no name shows the refusal the
   * moment the panel opens, and Save stays off until one is typed, so the
   * operator sees it where she is typing instead of as a rules error.
   */
  it('shows "Enter the business name." on open when the stored name is blank, and gates Save on it', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    saveBusinessSettings.mockResolvedValue({ updatedAt: 'x', updatedBy: 'y' });
    render(<Settings />);
    const panel = screen.getByRole('tabpanel');
    const nameInput = await within(panel).findByLabelText('Business name');
    const fields = panelOwning(nameInput);
    expect(nameInput).toHaveAttribute('aria-required', 'true');
    expect(within(fields).getByRole('alert')).toHaveTextContent('Enter the business name.');

    await userEvent.type(within(fields).getByLabelText('Phone'), '512-555-0199');
    expect(within(fields).getByRole('button', { name: /^save$/i })).toBeDisabled();

    await userEvent.type(nameInput, 'Sunny Paws');
    expect(within(fields).queryByRole('alert')).toBeNull();
    expect(within(fields).getByRole('button', { name: /^save$/i })).toBeEnabled();
    await userEvent.click(within(fields).getByRole('button', { name: /^save$/i }));
    expect(saveBusinessSettings).toHaveBeenCalledWith(
      expect.objectContaining({ businessName: 'Sunny Paws', businessPhone: '512-555-0199' }),
    );
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

describe('Settings: Scheduling (instant-save toggles)', () => {
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
    // two Saves in this tab belong to the Business profile panel (issue #709
    // folded the time zone picker's Save into it) and the Branding text-fields
    // panel (issue #712 moved it here); the Logo panel saves on upload and has
    // no Save button of its own. This is scoped to the toggle panel rather
    // than counting buttons across the whole tab.
    const togglePanel = panelOwning(
      within(panel).getByRole('switch', { name: /auto-confirm repeat kinfolk/i }),
    );
    expect(within(togglePanel).queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
    expect(within(panel).getAllByRole('button', { name: /^save$/i })).toHaveLength(2);
  });
});

// ISSUE #712: "Branding should be under the business profile." The Logo and
// Branding panels moved from their own nav tab into this one.
describe('Settings: Business profile absorbed Branding', () => {
  it('shows the Logo and Branding panels inside the Business profile tab', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    render(<Settings />);
    const panel = screen.getByRole('tabpanel');
    await within(panel).findByLabelText('Business name');
    expect(within(panel).getByText('Business logo')).toBeInTheDocument();
    expect(within(panel).getByLabelText('App name')).toBeInTheDocument();
  });

  it('saves the branding text fields through the shared persist', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    saveBusinessSettings.mockResolvedValue({ updatedAt: 'x', updatedBy: 'y' });
    render(<Settings />);
    const panel = screen.getByRole('tabpanel');
    const wordmark = await within(panel).findByLabelText('App name');
    await userEvent.type(wordmark, 'AuntieOS');
    await userEvent.click(within(panelOwning(wordmark)).getByRole('button', { name: /^save$/i }));
    expect(saveBusinessSettings).toHaveBeenCalledWith(
      expect.objectContaining({ brandWordmark: 'AuntieOS' }),
    );
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

  // ISSUE #711: KinCare Settings now holds both the types/rates editor and
  // Visits and tracking, so the Save this test clicks has to be scoped to
  // the types/rates panel specifically (the tab has two Save buttons now).
  it('KinCare Settings: adding a rate row saves the folded serviceRates map', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    saveBusinessSettings.mockResolvedValue({ updatedAt: 'x', updatedBy: 'y' });
    render(<Settings />);
    await screen.findByLabelText('Business name');
    const panel = await openSection('KinCare Settings');
    // ISSUE #755: the mock's add appends a blank row to the table; the save
    // bar sits under the editor's two panels and carries its own label.
    await userEvent.click(within(panel).getByRole('button', { name: /^add kincare type$/i }));
    await userEvent.type(within(panel).getByLabelText('Name'), 'Walk');
    await userEvent.click(within(panel).getByRole('button', { name: /^save kincare types$/i }));
    expect(saveBusinessSettings).toHaveBeenCalledWith({ serviceRates: { Walk: '' } });
  });

  it('KinCare Settings holds both the types/rates editor and Visits and tracking, each headed', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    render(<Settings />);
    await screen.findByLabelText('Business name');
    const panel = await openSection('KinCare Settings');
    expect(within(panel).getByRole('heading', { name: 'Your KinCare types' })).toBeInTheDocument();
    expect(within(panel).getByText('Visits and tracking')).toBeInTheDocument();
    expect(within(panel).getByRole('switch', { name: /toggle gps tracking for all visits/i })).toBeInTheDocument();
  });
});

describe('Settings — MyTribe portal editor', () => {
  // ISSUE #708 mark 41: "Break up this one long as setting block." The three
  // subsections already existed as hairline-separated groups with no label; each
  // now carries a heading so a group can be told apart from the one above it.
  it('heads each of its three subsections', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    render(<Settings />);
    await screen.findByLabelText('Business name');
    const panel = await openSection('MyTribe portal');
    expect(within(panel).getByText('Top banner')).toBeInTheDocument();
    expect(within(panel).getByText('Message Auntie chat')).toBeInTheDocument();
    expect(within(panel).getByText('Home layout')).toBeInTheDocument();
  });

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
    await userEvent.selectOptions(within(panel).getByLabelText('Theme'), 'Sunset');
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
    await userEvent.selectOptions(within(panel).getByLabelText('Theme'), 'Sunset');
    await userEvent.click(within(panel).getByRole('button', { name: /cancel/i }));
    expect(within(panel).getByLabelText('Theme')).toHaveValue('default');
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

    for (const label of ['Live visit', 'Up next', 'Recent KinTales', 'Quick start']) {
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

    await userEvent.click(within(panel).getByRole('switch', { name: 'Show Quick start on Home' }));
    await userEvent.click(within(panel).getByRole('button', { name: /^save$/i }));

    const changes = saveBusinessSettings.mock.calls[0]?.[0] as {
      mytribePortal: { home: { sections: Array<{ id: string; enabled: boolean }> } };
    };
    const quickStart = changes.mytribePortal.home.sections.find((s) => s.id === 'quickStart');
    expect(quickStart).toEqual({ id: 'quickStart', enabled: false, limit: 0 });
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
  // ISSUE #397 M10 follow-up: an editor with no way back to the default is a
  // one-way door. These four pin the fix -- a visible mode, a Reset control
  // that genuinely restores the portal's implicit default (an empty array,
  // not a full canonical list dressed up to look like one), and proof that
  // merely opening this panel and saving is never itself a write.
  it('states the layout mode so it is never a guess: default with nothing configured, custom once something is', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    render(<Settings />);
    await screen.findByLabelText('Business name');
    let panel = await openSection('MyTribe portal');
    expect(within(panel).getByText('Default layout')).toBeInTheDocument();
    expect(within(panel).queryByText('Custom layout')).not.toBeInTheDocument();
    // Nothing to reset back to yet.
    expect(within(panel).getByRole('button', { name: 'Reset to default layout' })).toBeDisabled();
    getBusinessSettings.mockReset();
    getBusinessSettings.mockResolvedValue(
      withOverrides({
        mytribePortal: {
          ...DEFAULT_BUSINESS_SETTINGS.mytribePortal,
          home: { sections: [{ id: 'upNext', enabled: true, limit: 5 }] },
        },
      }),
    );
    cleanup();
    render(<Settings />);
    await screen.findByLabelText('Business name');
    panel = await openSection('MyTribe portal');
    expect(within(panel).getByText('Custom layout')).toBeInTheDocument();
    expect(within(panel).queryByText('Default layout')).not.toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Reset to default layout' })).toBeEnabled();
  });
  it('opening the panel and pressing Save with nothing touched never calls the save API, whatever the starting layout', async () => {
    getBusinessSettings.mockResolvedValue(
      withOverrides({
        mytribePortal: {
          ...DEFAULT_BUSINESS_SETTINGS.mytribePortal,
          home: { sections: [{ id: 'upNext', enabled: false, limit: 3 }] },
        },
      }),
    );
    render(<Settings />);
    await screen.findByLabelText('Business name');
    const panel = await openSection('MyTribe portal');
    // Rendering the full catalogue (upNext plus the four appended-disabled
    // rows) must not itself register as an edit.
    const saveButton = within(panel).getByRole('button', { name: /^save$/i });
    expect(saveButton).toBeDisabled();
    await userEvent.click(saveButton);
    expect(saveBusinessSettings).not.toHaveBeenCalled();
  });
  it('Reset to default layout writes the empty array back, not a canonical list that only looks like it', async () => {
    getBusinessSettings.mockResolvedValue(
      withOverrides({
        mytribePortal: {
          ...DEFAULT_BUSINESS_SETTINGS.mytribePortal,
          home: {
            sections: [
              { id: 'liveVisit', enabled: true, limit: 0 },
              { id: 'upNext', enabled: false, limit: 0 },
              { id: 'tales', enabled: true, limit: 0 },
              { id: 'quickStart', enabled: true, limit: 0 },
            ],
          },
        },
      }),
    );
    saveBusinessSettings.mockResolvedValue({ updatedAt: 'x', updatedBy: 'y' });
    render(<Settings />);
    await screen.findByLabelText('Business name');
    const panel = await openSection('MyTribe portal');
    await userEvent.click(within(panel).getByRole('button', { name: 'Reset to default layout' }));
    expect(within(panel).getByText('Default layout')).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: /^save$/i }));
    expect(saveBusinessSettings).toHaveBeenCalledWith({
      mytribePortal: expect.objectContaining({ home: { sections: [] } }),
    });
  });
  it('Cancel after Reset restores the layout that was actually saved', async () => {
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
    await userEvent.click(within(panel).getByRole('button', { name: 'Reset to default layout' }));
    expect(within(panel).getByText('Default layout')).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: /cancel/i }));
    expect(within(panel).getByText('Custom layout')).toBeInTheDocument();
    expect(within(panel).getByRole('switch', { name: 'Show Up next on Home' })).toBeChecked();
  });
});
// #1987 (walk 2026-11-10): typing one Limit and putting it back left the chip
// on "Custom layout" and the Kinfolk Home in one stacked column, with Reset
// the only way out. A layout equal to the default is the default: the chip
// says so, there is nothing to save, and a save that lands on it sends `[]`.
describe('Settings: a Home layout equal to the default is the default (#1987)', () => {
  const DEFAULT_ROWS = ['liveVisit', 'upNext', 'tales', 'quickStart'].map((id) => ({ id, enabled: true, limit: 0 }));
  const LIMIT_ONLY = DEFAULT_ROWS.map((r) => (r.id === 'upNext' ? { ...r, limit: 2 } : r));
  const withHome = (sections: Array<{ id: string; enabled: boolean; limit: number }>) =>
    withOverrides({ mytribePortal: { ...DEFAULT_BUSINESS_SETTINGS.mytribePortal, home: { sections } } });
  async function openPortal(settings = DEFAULT_BUSINESS_SETTINGS) {
    getBusinessSettings.mockResolvedValue(settings);
    saveBusinessSettings.mockResolvedValue({ updatedAt: 'x', updatedBy: 'y' });
    render(<Settings />);
    await screen.findByLabelText('Business name');
    return openSection('MyTribe portal');
  }
  const limitOf = (panel: HTMLElement, label: string) =>
    within(within(panel).getByText(label).closest('li') as HTMLElement).getByLabelText('Limit');
  async function typeLimit(panel: HTMLElement, label: string, text: string) {
    const input = limitOf(panel, label);
    await userEvent.clear(input);
    await userEvent.type(input, text);
  }
  const sentSections = () =>
    (saveBusinessSettings.mock.calls[0]?.[0] as { mytribePortal: { home: { sections: unknown } } }).mytribePortal.home
      .sections;
  it('a limit-only change saves the order untouched with just that limit', async () => {
    const panel = await openPortal();
    await typeLimit(panel, 'Up next', '2');
    expect(within(panel).getByText('Custom layout')).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: /^save$/i }));
    expect(sentSections()).toEqual(LIMIT_ONLY);
  });
  it('typing a limit and putting 0 back is the default again, with nothing to save', async () => {
    const panel = await openPortal();
    await typeLimit(panel, 'Up next', '2');
    expect(within(panel).getByText('Custom layout')).toBeInTheDocument();
    await typeLimit(panel, 'Up next', '0');
    expect(within(panel).getByText('Default layout')).toBeInTheDocument();
    expect(within(panel).queryByText('Custom layout')).not.toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Reset to default layout' })).toBeDisabled();
    const save = within(panel).getByRole('button', { name: /^save$/i });
    expect(save).toBeDisabled();
    await userEvent.click(save);
    expect(saveBusinessSettings).not.toHaveBeenCalled();
  });
  it('a saved limit put back to 0 reads Default and saves the empty list, not four rows', async () => {
    const panel = await openPortal(withHome(LIMIT_ONLY));
    expect(within(panel).getByText('Custom layout')).toBeInTheDocument();
    await typeLimit(panel, 'Up next', '0');
    expect(within(panel).getByText('Default layout')).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: /^save$/i }));
    expect(sentSections()).toEqual([]);
  });
  it('a switch turned off and back on, and a section moved and moved back, are the default again', async () => {
    const panel = await openPortal();
    const quick = within(panel).getByRole('switch', { name: 'Show Quick start on Home' });
    await userEvent.click(quick);
    expect(within(panel).getByText('Custom layout')).toBeInTheDocument();
    await userEvent.click(quick);
    expect(within(panel).getByText('Default layout')).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Move Live visit down' }));
    expect(within(panel).getByText('Custom layout')).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Move Live visit up' }));
    expect(within(panel).getByText('Default layout')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: /^save$/i })).toBeDisabled();
  });
  it('a stored layout equal to the default opens as Default, with nothing to reset or save', async () => {
    const panel = await openPortal(withHome(DEFAULT_ROWS));
    expect(within(panel).getByText('Default layout')).toBeInTheDocument();
    expect(within(panel).queryByText('Custom layout')).not.toBeInTheDocument();
    expect(within(panel).getByText('Default layout (no custom sections configured)')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Reset to default layout' })).toBeDisabled();
    expect(within(panel).getByRole('button', { name: /^save$/i })).toBeDisabled();
  });
  it('a real custom order still reads Custom and is saved in that order with its limit', async () => {
    const custom = [
      { id: 'quickStart', enabled: true, limit: 0 },
      { id: 'liveVisit', enabled: true, limit: 0 },
      { id: 'upNext', enabled: true, limit: 0 },
      { id: 'tales', enabled: true, limit: 0 },
    ];
    const panel = await openPortal(withHome(custom));
    expect(within(panel).getByText('Custom layout')).toBeInTheDocument();
    expect(within(panel).getAllByRole('listitem')[0]).toHaveTextContent('Quick start');
    await typeLimit(panel, 'Up next', '3');
    await userEvent.click(within(panel).getByRole('button', { name: /^save$/i }));
    expect(sentSections()).toEqual(custom.map((r) => (r.id === 'upNext' ? { ...r, limit: 3 } : r)));
  });
});
describe('Settings: Integrations is a report, and its Google row opens Calendar in place', () => {
  it('does not ask the server until the section is opened', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    getIntegrationsHealth.mockResolvedValue(HEALTH_WITH_GOOGLE);
    render(<Settings />);
    await screen.findByLabelText('Business name');
    expect(getIntegrationsHealth).not.toHaveBeenCalled();
    await openSection('Integrations');
    expect(getIntegrationsHealth).toHaveBeenCalledTimes(1);
  });
  it('the Google row expands the Calendar panels in place, still inside Integrations', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    getIntegrationsHealth.mockResolvedValue(HEALTH_WITH_GOOGLE);
    render(<Settings />);
    await screen.findByLabelText('Business name');
    const panel = await openSection('Integrations');
    await userEvent.click(await screen.findByRole('button', { name: 'Open Google Calendar settings' }));
    // No separate tab to switch to any more: the row's own tab stays selected,
    // and the calendar controls are inline in the SAME tabpanel.
    expect(screen.getByRole('tab', { name: 'Integrations' })).toHaveAttribute('aria-selected', 'true');
    expect(within(panel).getByLabelText('Calendar ID')).toBeInTheDocument();
    expect(
      await within(panel).findByRole('button', { name: /connect google calendar/i }),
    ).toBeInTheDocument();
  });

  // ISSUE #755: the report is the mock's card grid. Each service is a card
  // with a monogram tile, the state as an LED line in the server's words, and
  // the report's timestamp and re-check control on the panel header.
  it('draws each service as a mock card: monogram tile, LED state line, header detail and control', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    getIntegrationsHealth.mockResolvedValue({
      ...HEALTH_WITH_GOOGLE,
      integrations: [
        ...HEALTH_WITH_GOOGLE.integrations,
        {
          key: 'stripe',
          name: 'Stripe',
          purpose: 'Card payments on invoices.',
          status: 'working' as const,
          summary: 'A test charge was authorised.',
          secrets: [],
          liveness: { outcome: 'pass' as const, detail: '' },
          remediation: '',
          externalStep: '',
          ownedBySection: '',
        },
      ],
    });
    render(<Settings />);
    await screen.findByLabelText('Business name');
    const panel = await openSection('Integrations');
    await within(panel).findByText('Stripe');

    const cards = panel.querySelectorAll('.integrations__grid > .integrations__card');
    expect(cards).toHaveLength(2);
    const [google, stripe] = [...cards] as HTMLElement[];
    expect(google).toBeDefined();
    expect(stripe).toBeDefined();
    if (!google || !stripe) throw new Error('two cards expected');

    // The mock's `.logo`: the service's first letter on a brand gradient tile.
    expect(google.querySelector('.icon-tile-gradient .integrations__monogram')).toHaveTextContent('G');
    expect(stripe.querySelector('.icon-tile-gradient .integrations__monogram')).toHaveTextContent('S');

    // The mock's `.conn`: the LED and the server's words, in the status tone.
    const googleConn = google.querySelector('.integrations__conn');
    expect(googleConn).toHaveTextContent('Set up, not verified');
    expect(googleConn).toHaveAttribute('data-tone', 'warning');
    expect(googleConn?.querySelector('.integrations__led')).not.toBeNull();
    const stripeConn = stripe.querySelector('.integrations__conn');
    expect(stripeConn).toHaveTextContent('Working');
    expect(stripeConn).toHaveAttribute('data-tone', 'success');
    // The local capsule is gone; the state line is the only status element.
    expect(panel.querySelector('.integrations__pill')).toBeNull();

    // Only the row with a flow of its own carries a control, in the foot.
    expect(within(google).getByRole('button', { name: 'Open Google Calendar settings' })).toBeInTheDocument();
    // #1595: the purpose line is the name's info tip now, so its button is the only other one.
    expect(within(stripe).queryAllByRole('button').filter((b) => b.getAttribute('aria-label') !== 'About this section')).toHaveLength(0);
    expect(within(stripe).getByRole('tooltip', { hidden: true })).toHaveTextContent('Card payments on invoices.');
    expect(stripe.querySelector('.integrations__purpose')).toBeNull();

    // #1758: the name reads as the name alone. With the tip INSIDE the h4, its
    // text was "Stripe iCard payments on invoices." (what the nightly's
    // real-services spec read off `.integrations__name`) and its accessible
    // name "Stripe About this section". The tip sits beside it, and the
    // heading is described by it, so the purpose is still reachable.
    const stripeName = stripe.querySelector('.integrations__name');
    expect(stripeName?.textContent).toBe('Stripe');
    const stripeHeading = within(stripe).getByRole('heading', { name: 'Stripe' });
    expect(stripeHeading).toHaveAccessibleDescription('Card payments on invoices.');
    expect(within(stripeHeading).queryByRole('button', { hidden: true })).toBeNull();
    expect(within(stripe).getByRole('button', { name: 'About this section' })).toBeInTheDocument();

    // The panel header owns the report's stamp and the re-check.
    const integrationsPanel = panelOwning(google);
    expect(integrationsPanel.querySelector('.den-panel-detail')).toHaveTextContent(/^Checked .*\.$/);
    expect(
      within(integrationsPanel.querySelector('.den-panel-header') as HTMLElement).getByRole('button', {
        name: 'Check again',
      }),
    ).toBeInTheDocument();
  });
});

// #1593: every MyTribe portal field refuses a bad value beside itself, and a
// server refusal's sentence is what the operator reads.
describe('Settings #1593: MyTribe portal checks', () => {
  it('offers the portal themes as a list, by name', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    render(<Settings />);
    await screen.findByLabelText('Business name');
    const panel = await openSection('MyTribe portal');
    const theme = within(panel).getByLabelText('Theme');
    expect(theme.tagName).toBe('SELECT');
    expect(within(theme).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Default', 'Midnight', 'Clear', 'Sunset', 'Duotone', 'Calm', 'Hearth', 'Jewel', 'Soft',
    ]);
    expect(theme).not.toHaveAttribute('aria-invalid');
  });

  it('shows a stored theme the list does not know under its raw id, refused, and still saves a different edit (#1783)', async () => {
    getBusinessSettings.mockResolvedValue(
      withOverrides({ mytribePortal: { ...DEFAULT_BUSINESS_SETTINGS.mytribePortal, themeId: 'neon' } }),
    );
    saveBusinessSettings.mockResolvedValue({ updatedAt: 'x', updatedBy: 'y' });
    render(<Settings />);
    await screen.findByLabelText('Business name');
    const panel = await openSection('MyTribe portal');
    const theme = within(panel).getByLabelText('Theme');
    expect(theme).toHaveValue('neon');
    expect(theme).toHaveAttribute('aria-invalid', 'true');
    expect(theme).toHaveAccessibleErrorMessage('Pick a theme from the list.');
    // A different field changes: the stored theme is not in this save, so Save
    // is on and only the banner travels.
    await userEvent.click(within(panel).getByRole('switch', { name: /toggle the portal top banner/i }));
    expect(within(panel).getByRole('button', { name: /^save$/i })).toBeEnabled();
    expect(theme).toHaveAccessibleErrorMessage('Pick a theme from the list.');
    await userEvent.click(within(panel).getByRole('button', { name: /^save$/i }));
    expect(saveBusinessSettings).toHaveBeenLastCalledWith({
      mytribePortal: { banner: expect.objectContaining({ enabled: true }) },
    });
  });
  describe('a stored home limit the portal cannot use (#1783)', () => {
    const storedBad = () =>
      withOverrides({
        mytribePortal: {
          ...DEFAULT_BUSINESS_SETTINGS.mytribePortal,
          home: { sections: [{ id: 'upNext', enabled: true, limit: -2 }] },
        },
      });
    async function open() {
      getBusinessSettings.mockResolvedValue(storedBad());
      saveBusinessSettings.mockResolvedValue({ updatedAt: 'x', updatedBy: 'y' });
      render(<Settings />);
      await screen.findByLabelText('Business name');
      const panel = await openSection('MyTribe portal');
      const row = within(panel).getByText('Up next').closest('li') as HTMLElement;
      return { panel, row, limit: within(row).getByLabelText('Limit') };
    }
    it('shows its sentence beside the box as the screen opens', async () => {
      const { row, limit } = await open();
      expect(limit).toHaveValue('-2');
      expect(limit).toHaveAttribute('aria-invalid', 'true');
      expect(within(row).getByRole('alert')).toHaveTextContent(
        'Enter a limit of 0 or more, as a whole number. 0 shows everything.',
      );
    });
    it('does not stop a save of a different part of the portal, and does not send the home layout', async () => {
      const { panel } = await open();
      await userEvent.click(within(panel).getByRole('switch', { name: /toggle the portal top banner/i }));
      const save = within(panel).getByRole('button', { name: /^save$/i });
      expect(save).toBeEnabled();
      await userEvent.click(save);
      expect(saveBusinessSettings).toHaveBeenLastCalledWith({
        mytribePortal: { banner: expect.objectContaining({ enabled: true }) },
      });
    });
    it('refuses another bad value typed into the limit, then saves a good one', async () => {
      const { panel, limit } = await open();
      await userEvent.clear(limit);
      await userEvent.type(limit, 'abc');
      expect(within(panel).getByRole('button', { name: /^save$/i })).toBeDisabled();
      await userEvent.clear(limit);
      await userEvent.type(limit, '5');
      const save = within(panel).getByRole('button', { name: /^save$/i });
      expect(save).toBeEnabled();
      await userEvent.click(save);
      expect(saveBusinessSettings).toHaveBeenLastCalledWith({
        mytribePortal: { home: { sections: expect.arrayContaining([expect.objectContaining({ id: 'upNext', limit: 5 })]) } },
      });
    });
    it('blocks a change to the layout while a stored limit stays bad, because the layout is checked whole', async () => {
      const { panel } = await open();
      await userEvent.click(within(panel).getByRole('switch', { name: /show up next on home/i }));
      expect(within(panel).getByRole('button', { name: /^save$/i })).toBeDisabled();
    });
  });
  it.each(['-3', 'abc', '1.5'])(
    'keeps a typed limit of %j in the box, says why beside it, and keeps Save off',
    async (typed) => {
      getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
      render(<Settings />);
      await screen.findByLabelText('Business name');
      const panel = await openSection('MyTribe portal');
      const upNextRow = within(panel).getByText('Up next').closest('li') as HTMLElement;
      const limit = within(upNextRow).getByLabelText('Limit');
      await userEvent.clear(limit);
      await userEvent.type(limit, typed);
      expect(limit).toHaveValue(typed);
      expect(limit).toHaveAttribute('aria-invalid', 'true');
      expect(within(upNextRow).getByRole('alert')).toHaveTextContent(
        'Enter a limit of 0 or more, as a whole number. 0 shows everything.',
      );
      expect(within(panel).getByRole('button', { name: /^save$/i })).toBeDisabled();
    },
  );
  it('a fixed limit clears the sentence and saves the number typed', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    saveBusinessSettings.mockResolvedValue({ updatedAt: 'x', updatedBy: 'y' });
    render(<Settings />);
    await screen.findByLabelText('Business name');
    const panel = await openSection('MyTribe portal');
    const upNextRow = within(panel).getByText('Up next').closest('li') as HTMLElement;
    const limit = within(upNextRow).getByLabelText('Limit');
    await userEvent.clear(limit);
    await userEvent.type(limit, '-3');
    expect(within(upNextRow).getByRole('alert')).toBeInTheDocument();
    await userEvent.clear(limit);
    await userEvent.type(limit, '3');
    expect(within(upNextRow).queryByRole('alert')).toBeNull();
    expect(limit).not.toHaveAttribute('aria-invalid');
    await userEvent.click(within(panel).getByRole('button', { name: /^save$/i }));
    const changes = saveBusinessSettings.mock.calls[0]?.[0] as {
      mytribePortal: { home: { sections: Array<{ id: string; limit: number }> } };
    };
    expect(changes.mytribePortal.home.sections.find((s) => s.id === 'upNext')?.limit).toBe(3);
  });

  it('Cancel puts a refused limit back to the saved one', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    render(<Settings />);
    await screen.findByLabelText('Business name');
    const panel = await openSection('MyTribe portal');
    const upNextRow = within(panel).getByText('Up next').closest('li') as HTMLElement;
    const limit = within(upNextRow).getByLabelText('Limit');
    await userEvent.clear(limit);
    await userEvent.type(limit, 'abc');
    await userEvent.click(within(panel).getByRole('button', { name: /cancel/i }));
    expect(within(upNextRow).getByLabelText('Limit')).toHaveValue('0');
    expect(within(upNextRow).queryByRole('alert')).toBeNull();
  });

  it('shows the server refusal sentence when the save is refused', async () => {
    getBusinessSettings.mockResolvedValue(DEFAULT_BUSINESS_SETTINGS);
    saveBusinessSettings.mockRejectedValue(
      Object.assign(new Error('Pick a theme from the list.'), {
        details: { code: 'settings_refused', field: 'mytribePortal', refusals: [{ field: 'mytribePortal', message: 'Pick a theme from the list.' }] },
      }),
    );
    render(<Settings />);
    await screen.findByLabelText('Business name');
    const panel = await openSection('MyTribe portal');
    await userEvent.selectOptions(within(panel).getByLabelText('Theme'), 'Sunset');
    await userEvent.click(within(panel).getByRole('button', { name: /^save$/i }));
    expect(await within(panel).findByText('Pick a theme from the list.')).toBeInTheDocument();
  });
});

describe('Settings #1593: Business profile email and phone', () => {
  async function profileFields(): Promise<HTMLElement> {
    render(<Settings />);
    const panel = screen.getByRole('tabpanel');
    const nameInput = await within(panel).findByLabelText('Business name');
    return panelOwning(nameInput);
  }

  it('refuses an email that is not an address, beside the field, and Save stays off until it is fixed', async () => {
    getBusinessSettings.mockResolvedValue(withOverrides({ businessName: 'Tribe Tails' }));
    saveBusinessSettings.mockResolvedValue({ updatedAt: 'x', updatedBy: 'y' });
    const fields = await profileFields();
    const email = within(fields).getByLabelText('Email');
    await userEvent.type(email, 'pawsome@');
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(email).toHaveAccessibleErrorMessage('Enter an email like name@example.com, or leave it blank.');
    expect(within(fields).getByRole('button', { name: /^save$/i })).toBeDisabled();
    await userEvent.type(email, 'hanasamku.com');
    expect(email).not.toHaveAttribute('aria-invalid');
    await userEvent.click(within(fields).getByRole('button', { name: /^save$/i }));
    expect(saveBusinessSettings).toHaveBeenCalledWith(expect.objectContaining({ businessEmail: 'pawsome@hanasamku.com' }));
  });

  it('refuses a phone number without ten digits; a blank one may be saved', async () => {
    getBusinessSettings.mockResolvedValue(withOverrides({ businessName: 'Tribe Tails', businessPhone: '512-555-0199' }));
    saveBusinessSettings.mockResolvedValue({ updatedAt: 'x', updatedBy: 'y' });
    const fields = await profileFields();
    const phone = within(fields).getByLabelText('Phone');
    await userEvent.clear(phone);
    await userEvent.type(phone, '555-0199');
    expect(within(fields).getByText('Enter a 10-digit phone number, or leave it blank.')).toBeInTheDocument();
    expect(within(fields).getByRole('button', { name: /^save$/i })).toBeDisabled();
    await userEvent.clear(phone);
    expect(within(fields).queryByText('Enter a 10-digit phone number, or leave it blank.')).toBeNull();
    await userEvent.click(within(fields).getByRole('button', { name: /^save$/i }));
    expect(saveBusinessSettings).toHaveBeenCalledWith(expect.objectContaining({ businessPhone: '' }));
  });

  it('puts a server refusal for one field beside that field, and editing the field clears it', async () => {
    getBusinessSettings.mockResolvedValue(withOverrides({ businessName: 'Tribe Tails' }));
    saveBusinessSettings.mockRejectedValue(
      Object.assign(new Error('Enter a 10-digit phone number, or leave it blank.'), {
        details: {
          code: 'settings_refused',
          field: 'businessPhone',
          refusals: [{ field: 'businessPhone', message: 'Enter a 10-digit phone number, or leave it blank.' }],
        },
      }),
    );
    const fields = await profileFields();
    const phone = within(fields).getByLabelText('Phone');
    await userEvent.type(phone, '512-555-0199');
    await userEvent.click(within(fields).getByRole('button', { name: /^save$/i }));
    expect(await within(fields).findByText('Enter a 10-digit phone number, or leave it blank.')).toBeInTheDocument();
    expect(phone).toHaveAccessibleErrorMessage('Enter a 10-digit phone number, or leave it blank.');
    // Beside the field, not repeated in a banner.
    expect(within(fields).queryByText('Save failed')).toBeNull();
    await userEvent.clear(phone);
    await userEvent.type(phone, '512-555-0198');
    expect(phone).not.toHaveAttribute('aria-invalid');
    expect(within(fields).queryByText('Enter a 10-digit phone number, or leave it blank.')).toBeNull();
  });
});
