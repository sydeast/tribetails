// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_BUSINESS_SETTINGS, mergeBusinessSettings, type BusinessSettings } from '../../api/settings';
import { BookingRulesSection, bookingRulesPatch } from './BookingRulesSection';
import { VisitsTrackingSection, visitsTrackingPatch } from './VisitsTrackingSection';
import { NotificationScheduleSection } from './NotificationScheduleSection';
import { VISIT_REMINDER_TIMING } from '../../lib/businessOperations';

/**
 * ISSUE #519. Each case here names a field the three admin clients decoded and
 * that no React surface offered a control for, and asserts the PATCH that
 * reaches `saveBusinessSettings` — not merely that a control rendered. A test
 * that only asserted a label would have passed against the unfixed code the
 * moment somebody added a read-only row.
 */

const onSave = vi.fn();

beforeEach(() => {
  onSave.mockReset().mockResolvedValue(undefined);
});

function settings(over: Partial<BusinessSettings> = {}): BusinessSettings {
  return { ...DEFAULT_BUSINESS_SETTINGS, ...over };
}

// ── Booking rules ───────────────────────────────────────────────────────────

describe('bookingRulesPatch (pure)', () => {
  const base = {
    defaultBookingMode: 'SPECIFIC_TIME',
    defaultCalendarView: 'MONTH',
    allowTimeBlockBooking: true,
    allowSpecificTimeBooking: true,
    defaultTimeBlockDurationHours: '4',
    travelBufferMinutes: '30',
    enableAutoReminder24h: true,
    blocks: [{ id: 'midday', label: 'Midday', startTime: '11:00', endTime: '15:00', active: true }],
  };

  it('builds every one of the eight fields', () => {
    const out = bookingRulesPatch(base);
    expect('patch' in out && out.patch).toEqual({
      defaultBookingMode: 'SPECIFIC_TIME',
      defaultCalendarView: 'MONTH',
      allowTimeBlockBooking: true,
      allowSpecificTimeBooking: true,
      defaultTimeBlockDurationHours: 4,
      travelBufferMinutes: 30,
      enableAutoReminder24h: true,
      timeBlocks: [{ id: 'midday', label: 'Midday', startTime: '11:00', endTime: '15:00', active: true }],
    });
  });

  it('refuses turning both booking modes off', () => {
    const out = bookingRulesPatch({ ...base, allowTimeBlockBooking: false, allowSpecificTimeBooking: false });
    expect(out).toEqual({ error: 'Leave at least one booking mode on, or nothing can be booked at all.' });
  });

  it('refuses defaulting to a mode that is turned off', () => {
    const out = bookingRulesPatch({ ...base, defaultBookingMode: 'TIME_BLOCK', allowTimeBlockBooking: false });
    expect(out).toHaveProperty('error');
  });

  it('refuses time-block booking with no active block behind it', () => {
    const out = bookingRulesPatch({
      ...base,
      blocks: [{ ...base.blocks[0]!, active: false }],
    });
    expect(out).toEqual({
      error: 'Time-block booking is on but no block is active, so there is nothing to book into.',
    });
  });

  it('names the field in a numeric error', () => {
    expect(bookingRulesPatch({ ...base, travelBufferMinutes: 'soon' })).toEqual({
      error: 'Travel buffer: Whole numbers only.',
    });
  });
});

describe('BookingRulesSection', () => {
  it('saves a changed travel buffer as a number', async () => {
    const user = userEvent.setup();
    render(<BookingRulesSection data={settings()} onSave={onSave} />);

    const buffer = screen.getByLabelText('Travel buffer (minutes)');
    await user.clear(buffer);
    await user.type(buffer, '45');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ travelBufferMinutes: 45 });
  });

  it('saves the 24-hour reminder switch, the field the cron now reads', async () => {
    const user = userEvent.setup();
    render(<BookingRulesSection data={settings()} onSave={onSave} />);

    await user.click(screen.getByRole('switch', { name: 'Toggle the visit reminder' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ enableAutoReminder24h: false });
  });

  it('shows an absent reminder value as ON, matching the server gate', () => {
    render(
      <BookingRulesSection
        data={settings({ enableAutoReminder24h: undefined as unknown as boolean })}
        onSave={onSave}
      />,
    );
    expect(screen.getByRole('switch', { name: 'Toggle the visit reminder' })).toBeChecked();
  });

  it('saves an edited time block, with the name trimmed', async () => {
    const user = userEvent.setup();
    render(<BookingRulesSection data={settings()} onSave={onSave} />);

    const name = screen.getByDisplayValue('Midday');
    await user.clear(name);
    await user.type(name, ' Middle of the day ');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave.mock.calls[0]?.[0]?.timeBlocks).toEqual([
      { id: 'midday', label: 'Middle of the day', startTime: '11:00', endTime: '15:00', active: true },
    ]);
  });

  it('keeps a block id stable across a rename, so labelled visits are not orphaned', async () => {
    const user = userEvent.setup();
    render(<BookingRulesSection data={settings()} onSave={onSave} />);
    const name = screen.getByDisplayValue('Midday');
    await user.clear(name);
    await user.type(name, 'Lunchtime');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave.mock.calls[0]?.[0]?.timeBlocks?.[0]?.id).toBe('midday');
  });

  // -- #710: turning off the default mode should not need a second edit ------

  it('auto-selects the remaining mode as default when the current default is turned off', async () => {
    const user = userEvent.setup();
    render(<BookingRulesSection data={settings({ defaultBookingMode: 'SPECIFIC_TIME' })} onSave={onSave} />);

    await user.click(screen.getByRole('switch', { name: 'Toggle booking at a specific time' }));

    expect(screen.getByLabelText('New bookings start as')).toHaveValue('TIME_BLOCK');
    expect(screen.queryByText(/Specific times are turned off/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      defaultBookingMode: 'TIME_BLOCK',
      allowSpecificTimeBooking: false,
    });
  });

  it('auto-selects specific time as default when time blocks are turned off', async () => {
    const user = userEvent.setup();
    render(<BookingRulesSection data={settings({ defaultBookingMode: 'TIME_BLOCK' })} onSave={onSave} />);

    await user.click(screen.getByRole('switch', { name: 'Toggle booking into a time block' }));

    expect(screen.getByLabelText('New bookings start as')).toHaveValue('SPECIFIC_TIME');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('keeps a loaded default visible under its real label even when its mode is already off', () => {
    render(
      <BookingRulesSection
        data={settings({ defaultBookingMode: 'SPECIFIC_TIME', allowSpecificTimeBooking: false })}
        onSave={onSave}
      />,
    );
    expect(screen.getByRole('option', { name: 'A specific time (11:15 AM)' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /not a known value/ })).not.toBeInTheDocument();
  });

  it('only offers enabled modes in the default-mode picker', async () => {
    const user = userEvent.setup();
    render(<BookingRulesSection data={settings()} onSave={onSave} />);

    await user.click(screen.getByRole('switch', { name: 'Toggle booking at a specific time' }));

    expect(
      screen.queryByRole('option', { name: 'A specific time (11:15 AM)' }),
    ).not.toBeInTheDocument();
  });

  it('blocks the save and says why when both modes are turned off', async () => {
    const user = userEvent.setup();
    render(<BookingRulesSection data={settings()} onSave={onSave} />);

    await user.click(screen.getByRole('switch', { name: 'Toggle booking at a specific time' }));
    await user.click(screen.getByRole('switch', { name: 'Toggle booking into a time block' }));

    expect(
      screen.getByText('Leave at least one booking mode on, or nothing can be booked at all.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
    // The default still names a real mode, so it keeps its real label instead
    // of being mislabelled "(not a known value)".
    expect(
      screen.queryByRole('option', { name: /not a known value/ }),
    ).not.toBeInTheDocument();
  });

  it('surfaces a save failure instead of swallowing it', async () => {
    const user = userEvent.setup();
    onSave.mockRejectedValue(new Error('permission-denied'));
    render(<BookingRulesSection data={settings()} onSave={onSave} />);

    const buffer = screen.getByLabelText('Travel buffer (minutes)');
    await user.clear(buffer);
    await user.type(buffer, '45');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('permission-denied')).toBeInTheDocument();
  });

  it('sends nothing until something changes', () => {
    render(<BookingRulesSection data={settings()} onSave={onSave} />);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  // ISSUE #708 mark 38: "This is just a huge weird block, there is no spacial
  // breakup." The panel now reads as three named groups rather than one flat
  // column.
  it('groups the panel into Booking modes, Defaults, and Time blocks, each headed', () => {
    render(<BookingRulesSection data={settings()} onSave={onSave} />);
    expect(screen.getByText('Booking modes')).toBeInTheDocument();
    expect(screen.getByText('Defaults')).toBeInTheDocument();
    expect(screen.getByText('Time blocks')).toBeInTheDocument();
  });
});

// ── Visits and tracking ─────────────────────────────────────────────────────

describe('visitsTrackingPatch (pure)', () => {
  const base = {
    enableGPSTrackingForAllVisits: true,
    autoStartTrackingOnVisitStart: true,
    trackingAccuracy: 'HIGH',
    enablePhotoLocationTagging: true,
    requireArrivalDepartureVerification: true,
    kinTaleRequired: true,
    arrivalRadiusMeters: '150',
    allowClientLocationSharing: true,
    saveRoutesForDays: '90',
    defaultEtaMinutes: 15,
    etaMinuteOptions: '5, 10, 15',
    draftRetentionDays: 30,
    draftRetentionOptions: '30, 60, 90',
  };

  it('parses both option lists and keeps the defaults', () => {
    const out = visitsTrackingPatch(base);
    expect('patch' in out && out.patch).toMatchObject({
      saveRoutesForDays: 90,
      defaultEtaMinutes: 15,
      etaMinuteOptions: [5, 10, 15],
      draftRetentionDays: 30,
      draftRetentionOptions: [30, 60, 90],
    });
  });

  it('clamps a default whose option was deleted rather than blocking the save', () => {
    const out = visitsTrackingPatch({ ...base, etaMinuteOptions: '5, 10' });
    expect('patch' in out && out.patch.defaultEtaMinutes).toBe(10);
  });

  it('names which list is wrong', () => {
    expect(visitsTrackingPatch({ ...base, draftRetentionOptions: '30, 30' })).toEqual({
      error: 'Draft-retention choices: 30 is listed twice.',
    });
  });

  // -- #582: the arrival radius ---------------------------------------------

  it('carries the arrival radius through as a number', () => {
    const out = visitsTrackingPatch({ ...base, arrivalRadiusMeters: '300' });
    expect('patch' in out && out.patch.arrivalRadiusMeters).toBe(300);
  });

  /**
   * The bounds are the rules guard's own (`bsInt('arrivalRadiusMeters', 10,
   * 5000)`), so the operator reads what is wrong here instead of watching a
   * save bounce off firestore.rules with no usable message.
   */
  it('refuses a radius tighter than a GPS fix would ever be, naming the field', () => {
    expect(visitsTrackingPatch({ ...base, arrivalRadiusMeters: '5' })).toEqual({
      error: 'Arrival must be within: Enter 10 to 5000 metres.',
    });
  });

  it('refuses a radius so wide it is not a check', () => {
    expect(visitsTrackingPatch({ ...base, arrivalRadiusMeters: '5001' })).toMatchObject({
      error: 'Arrival must be within: Enter 10 to 5000 metres.',
    });
  });

  it('refuses a cleared box rather than saving a silent zero', () => {
    expect(visitsTrackingPatch({ ...base, arrivalRadiusMeters: '' })).toEqual({
      error: 'Arrival must be within: Enter a number.',
    });
  });

  /**
   * Validated even with the switch off. The value is saved either way, and a
   * bad one left behind becomes an unfixable problem the first time somebody
   * turns verification on.
   */
  it('validates the radius even while arrival verification is switched off', () => {
    expect(
      visitsTrackingPatch({
        ...base,
        requireArrivalDepartureVerification: false,
        arrivalRadiusMeters: '0',
      }),
    ).toMatchObject({ error: 'Arrival must be within: Enter 10 to 5000 metres.' });
  });
});

describe('VisitsTrackingSection', () => {
  it('saves the four fields that had no editor anywhere', async () => {
    const user = userEvent.setup();
    render(<VisitsTrackingSection data={settings()} onSave={onSave} />);

    await user.click(screen.getByRole('switch', { name: 'Toggle photo location tagging' }));
    await user.click(screen.getByRole('switch', { name: 'Toggle arrival and departure verification' }));
    await user.click(screen.getByRole('switch', { name: 'Toggle kinfolk location sharing' }));
    const days = screen.getByLabelText('Keep visit routes for (days)');
    await user.clear(days);
    await user.type(days, '365');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      enablePhotoLocationTagging: false,
      // #1620: the default is OFF, so the click turns it on.
      requireArrivalDepartureVerification: true,
      allowClientLocationSharing: false,
      saveRoutesForDays: 365,
    });
  });
  it('shows Verify arrival and departure OFF when the document has no such key, as the server reads it (#1620)', async () => {
    const user = userEvent.setup();
    // A document written before the switch existed: no requireArrivalDepartureVerification key.
    render(<VisitsTrackingSection data={mergeBusinessSettings({ businessName: 'Tribe Tails' })} onSave={onSave} />);
    const toggle = screen.getByRole('switch', { name: 'Toggle arrival and departure verification' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    // Saving another field never turns the rule on behind the operator's back.
    await user.click(screen.getByRole('switch', { name: 'Toggle kinfolk location sharing' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    // #1783: the switch the operator did not touch is not in the save at all.
    expect(onSave.mock.calls[0]?.[0]).toEqual({ allowClientLocationSharing: false });
  });

  /** #2123: "KinTale required". Absent reads OFF (ruling 2026-11-13, "Start it off"), the server's reading. */
  it('shows KinTale required OFF for a document with no such key, and saves turning it on alone', async () => {
    const user = userEvent.setup();
    render(<VisitsTrackingSection data={mergeBusinessSettings({ businessName: 'Tribe Tails' })} onSave={onSave} />);
    const toggle = screen.getByRole('switch', { name: 'Toggle KinTale required' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('KinTale required')).toBeInTheDocument();
    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave.mock.calls[0]?.[0]).toEqual({ kinTaleRequired: true });
  });

  it('turns KinTale required off from a stored on', async () => {
    const user = userEvent.setup();
    render(<VisitsTrackingSection data={mergeBusinessSettings({ kinTaleRequired: true })} onSave={onSave} />);
    const toggle = screen.getByRole('switch', { name: 'Toggle KinTale required' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave.mock.calls[0]?.[0]).toEqual({ kinTaleRequired: false });
  });

  it('turns KinTale required back on from a stored off', async () => {
    const user = userEvent.setup();
    render(<VisitsTrackingSection data={mergeBusinessSettings({ kinTaleRequired: false })} onSave={onSave} />);
    const toggle = screen.getByRole('switch', { name: 'Toggle KinTale required' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave.mock.calls[0]?.[0]).toEqual({ kinTaleRequired: true });
  });

  it('a save of another field leaves KinTale required out of the save', async () => {
    const user = userEvent.setup();
    render(<VisitsTrackingSection data={mergeBusinessSettings({ kinTaleRequired: false })} onSave={onSave} />);
    await user.click(screen.getByRole('switch', { name: 'Toggle photo location tagging' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty('kinTaleRequired');
  });

  /** #582: the threshold under the arrival switch, editable on this surface too. */
  it('saves an edited arrival radius', async () => {
    const user = userEvent.setup();
    render(<VisitsTrackingSection data={settings()} onSave={onSave} />);

    const radius = screen.getByLabelText('Arrival must be within (metres)');
    await user.clear(radius);
    await user.type(radius, '300');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ arrivalRadiusMeters: 300 });
  });

  it('refuses to save an out-of-range radius and says why', async () => {
    const user = userEvent.setup();
    render(<VisitsTrackingSection data={settings()} onSave={onSave} />);

    const radius = screen.getByLabelText('Arrival must be within (metres)');
    await user.clear(radius);
    await user.type(radius, '2');

    // #1593: the sentence sits under the field it is about.
    expect(radius).toHaveAccessibleErrorMessage('Enter 10 to 5000 metres.');
    expect(radius).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  });

  /**
   * The panel must not promise a check that cannot always run. An arrival with
   * no usable location completes and is recorded as unverified, and the
   * operator has to be able to read that here.
   */
  it('tells the operator that an arrival with no usable location still goes through', () => {
    render(<VisitsTrackingSection data={settings()} onSave={onSave} />);
    expect(screen.getByText(/still goes through, and is recorded as unverified/)).toBeTruthy();
  });

  it('saves an edited ETA option list', async () => {
    const user = userEvent.setup();
    render(<VisitsTrackingSection data={settings()} onSave={onSave} />);

    const list = screen.getByLabelText('Choices offered (minutes)');
    await user.clear(list);
    await user.type(list, '10, 20, 30');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      etaMinuteOptions: [10, 20, 30],
      // 15 is gone from the list, so the default follows it to the nearest survivor.
      defaultEtaMinutes: 10,
    });
  });

  it('disables the tracking sub-controls when the master switch is off', () => {
    render(<VisitsTrackingSection data={settings({ enableGPSTrackingForAllVisits: false })} onSave={onSave} />);
    expect(screen.getByRole('switch', { name: 'Toggle auto-start tracking on visit start' })).toBeDisabled();
    expect(screen.getByLabelText('Tracking accuracy')).toBeDisabled();
  });

  /**
   * The panel used to carry two "saved but nothing acts on this" warnings. The
   * operator's 2026-08-24 ruling closed that: every field here has a consumer,
   * so the copy now says what happens instead of apologising for what does not.
   */
  it('describes what each retention window actually does, with no unenforced warning left', () => {
    render(<VisitsTrackingSection data={settings()} onSave={onSave} />);
    expect(screen.getByText(/Unsent drafts older than this are deleted nightly/)).toBeInTheDocument();
    expect(screen.getByText(/Route pings older than this are deleted nightly/)).toBeInTheDocument();
    expect(screen.queryByText(/nothing acts on them yet/)).not.toBeInTheDocument();
    expect(screen.queryByText(/nothing clears old drafts yet/)).not.toBeInTheDocument();
  });

  it('refuses an empty options list and says so', async () => {
    const user = userEvent.setup();
    render(<VisitsTrackingSection data={settings()} onSave={onSave} />);
    const list = screen.getByLabelText('Choices offered (minutes)');
    await user.clear(list);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(list).toHaveAccessibleErrorMessage('List at least one option, in minutes.');
    expect(onSave).not.toHaveBeenCalled();
  });
});

// ── ISSUE #1612 ─────────────────────────────────────────────────────────────
describe('BookingRulesSection, adding a block (#1612)', () => {
  // Operator ruling: the app never picks a block's hours. A new row used to
  // arrive as 09:00 to 13:00, on top of Midday, with nothing saying so.
  it('opens a new block with no start or end time', async () => {
    const user = userEvent.setup();
    render(<BookingRulesSection data={settings()} onSave={onSave} />);
    await user.click(screen.getByRole('button', { name: 'Add a block' }));
    expect(screen.getByLabelText('Block start time')).toHaveValue('');
    expect(screen.getByLabelText('Block end time')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('runs the new block for the default block length from the start the operator gives it', async () => {
    const user = userEvent.setup();
    render(<BookingRulesSection data={settings({ defaultTimeBlockDurationHours: 3 })} onSave={onSave} />);
    await user.click(screen.getByRole('button', { name: 'Add a block' }));
    fireEvent.change(screen.getByLabelText('Block start time'), { target: { value: '16:00' } });
    expect(screen.getByLabelText('Block end time')).toHaveValue('19:00');
  });

  it('shows an overlap on both clashing rows while the new one is still unnamed', async () => {
    const user = userEvent.setup();
    render(<BookingRulesSection data={settings()} onSave={onSave} />);
    await user.click(screen.getByRole('button', { name: 'Add a block' }));
    fireEvent.change(screen.getByLabelText('Block start time'), { target: { value: '09:00' } });
    fireEvent.change(screen.getByLabelText('Block end time'), { target: { value: '13:00' } });
    expect(screen.getByText('Overlaps Midday.')).toBeInTheDocument();
    expect(screen.getByText('Overlaps a block with no name yet.')).toBeInTheDocument();
  });

  it('says nothing about overlap once the clash is gone', async () => {
    const user = userEvent.setup();
    render(<BookingRulesSection data={settings()} onSave={onSave} />);
    await user.click(screen.getByRole('button', { name: 'Add a block' }));
    fireEvent.change(screen.getByLabelText('Block start time'), { target: { value: '15:00' } });
    fireEvent.change(screen.getByLabelText('Block end time'), { target: { value: '19:00' } });
    expect(screen.queryByText(/^Overlaps /)).not.toBeInTheDocument();
  });
});

describe('visit reminder timing reads the same in both sections (#1612)', () => {
  it('states one timing under Booking rules and under Notifications', () => {
    const { unmount } = render(<BookingRulesSection data={settings()} onSave={onSave} />);
    expect(screen.getByText(`Remind kinfolk ${VISIT_REMINDER_TIMING} a visit`)).toBeInTheDocument();
    unmount();
    render(<NotificationScheduleSection data={settings()} onSave={onSave} />);
    expect(screen.getByText(new RegExp(`go out ${VISIT_REMINDER_TIMING} each visit`))).toBeInTheDocument();
  });
});

describe('VisitsTrackingSection, the arrival radius note (#1612)', () => {
  // The note sits under "Let kinfolk see visit locations" on this screen, so
  // "the switch above" pointed at the wrong switch.
  it('names the switch the radius depends on', () => {
    render(<VisitsTrackingSection data={settings()} onSave={onSave} />);
    expect(
      screen.getByText(/Only applies while Verify arrival and departure by location is on\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/the switch above/)).not.toBeInTheDocument();
  });
});

// ── ISSUE #1593 ─────────────────────────────────────────────────────────────
function refusal(field: string, message: string): Error {
  return Object.assign(new Error(message), {
    details: { code: 'settings_refused', field, refusals: [{ field, message }] },
  });
}

describe('VisitsTrackingSection, each field carries its own refusal (#1593)', () => {
  it('shows every failing field its own sentence at once, with no panel banner', async () => {
    const user = userEvent.setup();
    render(<VisitsTrackingSection data={settings()} onSave={onSave} />);
    const days = screen.getByLabelText('Keep visit routes for (days)');
    const radius = screen.getByLabelText('Arrival must be within (metres)');
    const eta = screen.getByLabelText('Choices offered (minutes)');
    const drafts = screen.getByLabelText('Choices offered (days)');
    await user.clear(days);
    await user.type(days, 'abc');
    await user.clear(radius);
    await user.type(radius, '-5');
    await user.clear(eta);
    await user.type(eta, '5, 5');
    await user.clear(drafts);
    await user.type(drafts, '0');

    expect(days).toHaveAccessibleErrorMessage('Whole numbers only.');
    expect(radius).toHaveAccessibleErrorMessage('Whole numbers only.');
    expect(eta).toHaveAccessibleErrorMessage('5 is listed twice.');
    expect(drafts).toHaveAccessibleErrorMessage('Every option has to be more than zero.');
    for (const box of [days, radius, eta, drafts]) expect(box).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByText('Not ready to save')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('the hint stays in the description beside the refusal', async () => {
    const user = userEvent.setup();
    render(<VisitsTrackingSection data={settings()} onSave={onSave} />);
    const eta = screen.getByLabelText('Choices offered (minutes)');
    await user.clear(eta);
    expect(eta.getAttribute('aria-describedby')).toBe('etaOptions-hint etaOptions-error');
  });

  it('fixing a field clears its sentence and lets Save through', async () => {
    const user = userEvent.setup();
    render(<VisitsTrackingSection data={settings()} onSave={onSave} />);
    const days = screen.getByLabelText('Keep visit routes for (days)');
    await user.clear(days);
    expect(days).toHaveAccessibleErrorMessage('Enter a number.');
    await user.type(days, '120');
    expect(days).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ saveRoutesForDays: 120 });
  });

  it('puts a server refusal for a field under that field', async () => {
    const user = userEvent.setup();
    onSave.mockRejectedValue(refusal('arrivalRadiusMeters', 'Enter 10 to 5000 metres.'));
    render(<VisitsTrackingSection data={settings()} onSave={onSave} />);
    const radius = screen.getByLabelText('Arrival must be within (metres)');
    await user.clear(radius);
    await user.type(radius, '300');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter 10 to 5000 metres.')).toBeInTheDocument();
    expect(radius).toHaveAccessibleErrorMessage('Enter 10 to 5000 metres.');
    expect(screen.queryByText('Save failed')).toBeNull();
  });

  it('shows a server refusal for a field with no box of its own in the banner', async () => {
    const user = userEvent.setup();
    onSave.mockRejectedValue(refusal('trackingAccuracy', 'Pick a tracking accuracy from the list.'));
    render(<VisitsTrackingSection data={settings()} onSave={onSave} />);
    await user.click(screen.getByRole('switch', { name: 'Toggle photo location tagging' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Pick a tracking accuracy from the list.')).toBeInTheDocument();
    expect(screen.getByText('Save failed')).toBeInTheDocument();
  });
});

describe('BookingRulesSection, the number fields carry their own refusal (#1593)', () => {
  it('shows a bad block length under the field, not in the banner', async () => {
    const user = userEvent.setup();
    render(<BookingRulesSection data={settings()} onSave={onSave} />);
    const length = screen.getByLabelText('Default block length (hours)');
    await user.clear(length);
    await user.type(length, '30');
    expect(length).toHaveAccessibleErrorMessage('Enter 1 to 24 hours.');
    expect(length.getAttribute('aria-describedby')).toBe('blockLength-hint blockLength-error');
    expect(screen.queryByText('Not ready to save')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('shows a bad travel buffer under the field, and fixing it clears it', async () => {
    const user = userEvent.setup();
    render(<BookingRulesSection data={settings()} onSave={onSave} />);
    const buffer = screen.getByLabelText('Travel buffer (minutes)');
    await user.clear(buffer);
    await user.type(buffer, '1.5');
    expect(buffer).toHaveAccessibleErrorMessage('Whole numbers only.');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.clear(buffer);
    await user.type(buffer, '20');
    expect(buffer).not.toHaveAttribute('aria-invalid');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ travelBufferMinutes: 20 });
  });

  it('a panel-wide problem still shows in the banner beside a field refusal', async () => {
    const user = userEvent.setup();
    render(<BookingRulesSection data={settings()} onSave={onSave} />);
    const buffer = screen.getByLabelText('Travel buffer (minutes)');
    await user.clear(buffer);
    await user.click(screen.getByRole('switch', { name: 'Toggle booking at a specific time' }));
    await user.click(screen.getByRole('switch', { name: 'Toggle booking into a time block' }));
    expect(buffer).toHaveAccessibleErrorMessage('Enter a number.');
    expect(screen.getByText('Not ready to save')).toBeInTheDocument();
    expect(
      screen.getByText('Leave at least one booking mode on, or nothing can be booked at all.'),
    ).toBeInTheDocument();
  });

  it('puts a server refusal for a number field under that field', async () => {
    const user = userEvent.setup();
    onSave.mockRejectedValue(refusal('travelBufferMinutes', 'Enter 0 to 480 minutes.'));
    render(<BookingRulesSection data={settings()} onSave={onSave} />);
    const buffer = screen.getByLabelText('Travel buffer (minutes)');
    await user.clear(buffer);
    await user.type(buffer, '45');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter 0 to 480 minutes.')).toBeInTheDocument();
    expect(buffer).toHaveAccessibleErrorMessage('Enter 0 to 480 minutes.');
    expect(screen.queryByText('Save failed')).toBeNull();
  });
});
describe('BookingRulesSection, a stored bad value (#1783)', () => {
  const stored = () => settings({ travelBufferMinutes: 9999 });
  it('shows its sentence beside the field as the panel opens', () => {
    render(<BookingRulesSection data={stored()} onSave={onSave} />);
    expect(screen.getByLabelText('Travel buffer (minutes)')).toHaveAccessibleErrorMessage('Enter 0 to 480 minutes.');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
  it('saves a different field, and the stored buffer stays out of the save', async () => {
    const user = userEvent.setup();
    render(<BookingRulesSection data={stored()} onSave={onSave} />);
    await user.click(screen.getByRole('switch', { name: 'Toggle the visit reminder' }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith({ enableAutoReminder24h: false });
  });
  it('refuses the stored field once it is edited to another bad value, and saves a good one', async () => {
    const user = userEvent.setup();
    render(<BookingRulesSection data={stored()} onSave={onSave} />);
    const buffer = screen.getByLabelText('Travel buffer (minutes)');
    await user.clear(buffer);
    await user.type(buffer, '9000');
    expect(buffer).toHaveAccessibleErrorMessage('Enter 0 to 480 minutes.');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.clear(buffer);
    await user.type(buffer, '45');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith({ travelBufferMinutes: 45 });
  });
  it('shows two stored booking modes both off, and saves an unrelated edit anyway', async () => {
    const user = userEvent.setup();
    render(
      <BookingRulesSection
        data={settings({ allowSpecificTimeBooking: false, allowTimeBlockBooking: false })}
        onSave={onSave}
      />,
    );
    expect(
      screen.getByText('Leave at least one booking mode on, or nothing can be booked at all.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'Toggle the visit reminder' }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith({ enableAutoReminder24h: false });
  });
});
describe('VisitsTrackingSection, a stored bad value (#1783)', () => {
  const stored = () => settings({ arrivalRadiusMeters: 3 });
  it('shows its sentence beside the field as the panel opens', () => {
    render(<VisitsTrackingSection data={stored()} onSave={onSave} />);
    expect(screen.getByLabelText('Arrival must be within (metres)')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
  it('saves a different field, and the stored radius stays out of the save', async () => {
    const user = userEvent.setup();
    render(<VisitsTrackingSection data={stored()} onSave={onSave} />);
    await user.click(screen.getByRole('switch', { name: 'Toggle kinfolk location sharing' }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith({ allowClientLocationSharing: false });
  });
  it('refuses the stored field once it is edited to another bad value, and saves a good one', async () => {
    const user = userEvent.setup();
    render(<VisitsTrackingSection data={stored()} onSave={onSave} />);
    const radius = screen.getByLabelText('Arrival must be within (metres)');
    await user.clear(radius);
    await user.type(radius, '9');
    expect(radius).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.clear(radius);
    await user.type(radius, '300');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith({ arrivalRadiusMeters: 300 });
  });
});
