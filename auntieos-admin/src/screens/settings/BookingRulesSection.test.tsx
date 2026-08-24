// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_BUSINESS_SETTINGS, type BusinessSettings } from '../../api/settings';
import { BookingRulesSection, bookingRulesPatch } from './BookingRulesSection';
import { VisitsTrackingSection, visitsTrackingPatch } from './VisitsTrackingSection';
import { TimeZoneSection } from './TimeZoneSection';

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

    await user.click(screen.getByRole('switch', { name: 'Toggle the 24-hour visit reminder' }));
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
    expect(screen.getByRole('switch', { name: 'Toggle the 24-hour visit reminder' })).toBeChecked();
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
});

// ── Visits and tracking ─────────────────────────────────────────────────────

describe('visitsTrackingPatch (pure)', () => {
  const base = {
    enableGPSTrackingForAllVisits: true,
    autoStartTrackingOnVisitStart: true,
    trackingAccuracy: 'HIGH',
    enablePhotoLocationTagging: true,
    requireArrivalDepartureVerification: true,
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
      requireArrivalDepartureVerification: false,
      allowClientLocationSharing: false,
      saveRoutesForDays: 365,
    });
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

  it('says out loud that the four unenforced settings are not enforced', () => {
    render(<VisitsTrackingSection data={settings()} onSave={onSave} />);
    expect(
      screen.getByText(/These four save and read back, and nothing acts on them yet/),
    ).toBeInTheDocument();
    expect(screen.getByText(/nothing clears old drafts yet/)).toBeInTheDocument();
  });

  it('refuses an empty options list and says so', async () => {
    const user = userEvent.setup();
    render(<VisitsTrackingSection data={settings()} onSave={onSave} />);
    const list = screen.getByLabelText('Choices offered (minutes)');
    await user.clear(list);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByText(/On-my-way choices/)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });
});

// ── Time zone ───────────────────────────────────────────────────────────────

describe('TimeZoneSection', () => {
  it('saves the picked zone', async () => {
    const user = userEvent.setup();
    render(<TimeZoneSection data={settings()} onSave={onSave} />);

    await user.selectOptions(screen.getByLabelText('Business time zone'), 'America/Chicago');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledWith({ timeZone: 'America/Chicago' });
  });

  it('offers a stored zone the runtime does not know, and warns instead of saving it silently', () => {
    render(<TimeZoneSection data={settings({ timeZone: 'Mars/Olympus' })} onSave={onSave} />);
    expect(screen.getByLabelText('Business time zone')).toHaveValue('Mars/Olympus');
    expect(screen.getByText(/the phone line answers as open around the clock/)).toBeInTheDocument();
  });

  it('starts with nothing to save', () => {
    render(<TimeZoneSection data={settings()} onSave={onSave} />);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
