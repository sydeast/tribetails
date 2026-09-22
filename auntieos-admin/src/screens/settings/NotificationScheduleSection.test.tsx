// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DEFAULT_BUSINESS_SETTINGS,
  mergeBusinessSettings,
  type BusinessSettings,
} from '../../api/settings';
import {
  HOUR_OPTIONS,
  NotificationScheduleSection,
  hourFieldNumber,
  hourFieldValue,
  hourLabel,
  notificationSchedulePatch,
  scheduleNote,
} from './NotificationScheduleSection';

/**
 * THE OPERATOR'S TWO CONTROLS.
 *
 * Phase 1's send gate shipped with no UI at all and had to be set by hand in the
 * Firestore console. The send hours are new. Both are asserted on the PATCH that
 * reaches `saveBusinessSettings`, not on a rendered label: a test that checked
 * only that a picker appeared would pass against a picker wired to nothing,
 * which is the exact defect (`persists but changes nothing`) this repo keeps
 * finding.
 */

const onSave = vi.fn();

beforeEach(() => {
  onSave.mockReset().mockResolvedValue(undefined);
});

function settings(over: Partial<BusinessSettings> = {}): BusinessSettings {
  return { ...DEFAULT_BUSINESS_SETTINGS, ...over };
}

describe('the shipped defaults', () => {
  /**
   * OPERATOR RULING 2026-09-22: nothing runs until they switch it on here. A
   * document with none of these keys, which is every document in production, has
   * to read as off and unscheduled.
   */
  it('an unconfigured document is off and has no cadence', () => {
    const merged = mergeBusinessSettings(undefined);
    expect(merged.householdNotificationsLive).toBe(false);
    expect(merged.householdNotificationHour).toBeNull();
    expect(merged.scheduleDigestHour).toBeNull();
  });

  /** Only the literal `true` opens the gate, mirroring the server's `=== true`. */
  it('a near-miss in the gate field does not read as on', () => {
    for (const near of ['true', 1, 'yes', {}]) {
      expect(mergeBusinessSettings({ householdNotificationsLive: near }).householdNotificationsLive).toBe(
        false,
      );
    }
    expect(mergeBusinessSettings({ householdNotificationsLive: true }).householdNotificationsLive).toBe(
      true,
    );
  });

  /** And a stored hour this app cannot use reads as no cadence, never as a guess. */
  it('a stored hour that is not an hour reads as not scheduled', () => {
    for (const bad of ['9', 9.5, -1, 24, true, null]) {
      expect(mergeBusinessSettings({ householdNotificationHour: bad }).householdNotificationHour).toBeNull();
    }
    expect(mergeBusinessSettings({ householdNotificationHour: 0 }).householdNotificationHour).toBe(0);
    expect(mergeBusinessSettings({ scheduleDigestHour: 23 }).scheduleDigestHour).toBe(23);
  });
});

describe('the pure helpers', () => {
  it('round-trips an hour through the picker, including midnight', () => {
    for (const h of [0, 9, 23]) {
      expect(hourFieldNumber(hourFieldValue(h))).toBe(h);
    }
    expect(hourFieldValue(null)).toBe('');
    expect(hourFieldNumber('')).toBeNull();
  });

  /** Hour 0 is a real choice and must not fall out as "nothing selected". */
  it('midnight is not mistaken for not scheduled', () => {
    expect(hourFieldValue(0)).toBe('0');
    expect(hourFieldNumber('0')).toBe(0);
  });

  it('labels the hours in twelve-hour time', () => {
    expect(hourLabel(0)).toBe('12:00 AM');
    expect(hourLabel(9)).toBe('9:00 AM');
    expect(hourLabel(12)).toBe('12:00 PM');
    expect(hourLabel(23)).toBe('11:00 PM');
  });

  it('offers not-scheduled first, then all 24 hours', () => {
    expect(HOUR_OPTIONS.length).toBe(25);
    expect(HOUR_OPTIONS[0]).toEqual({ value: '', label: 'Not scheduled' });
    expect(HOUR_OPTIONS[HOUR_OPTIONS.length - 1]).toEqual({ value: '23', label: '11:00 PM' });
  });

  it('builds the three-field patch', () => {
    expect(
      notificationSchedulePatch({
        householdNotificationsLive: true,
        householdNotificationHour: '14',
        scheduleDigestHour: '',
      }),
    ).toEqual({
      householdNotificationsLive: true,
      householdNotificationHour: 14,
      scheduleDigestHour: null,
    });
  });
});

describe('scheduleNote', () => {
  it('says so when sends are on but nothing is scheduled', () => {
    const note = scheduleNote({
      householdNotificationsLive: true,
      householdNotificationHour: '',
      scheduleDigestHour: '',
    });
    expect(note).toContain('no send time is set');
  });

  it('says so when a time is set but sends are off', () => {
    const note = scheduleNote({
      householdNotificationsLive: false,
      householdNotificationHour: '9',
      scheduleDigestHour: '',
    });
    expect(note).toContain('household notices are off');
  });

  it('says nothing when the two agree', () => {
    expect(
      scheduleNote({
        householdNotificationsLive: true,
        householdNotificationHour: '9',
        scheduleDigestHour: '7',
      }),
    ).toBeNull();
    expect(
      scheduleNote({
        householdNotificationsLive: false,
        householdNotificationHour: '',
        scheduleDigestHour: '',
      }),
    ).toBeNull();
  });
});

describe('the panel', () => {
  /**
   * THE WHOLE POINT OF THIS PANEL. Until now the only way to turn the product on
   * was to edit `business_settings` in the Firestore console.
   */
  it('turns household sending on and saves it', async () => {
    render(<NotificationScheduleSection data={settings()} onSave={onSave} />);
    await userEvent.click(screen.getByLabelText('Toggle household notifications'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledWith({
      householdNotificationsLive: true,
      householdNotificationHour: null,
      scheduleDigestHour: null,
    });
  });

  it('sets the invoice send hour and saves it', async () => {
    render(<NotificationScheduleSection data={settings()} onSave={onSave} />);
    await userEvent.selectOptions(
      screen.getByLabelText('Invoice reminders and overdue notices'),
      '14',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledWith({
      householdNotificationsLive: false,
      householdNotificationHour: 14,
      scheduleDigestHour: null,
    });
  });

  /** The digest has its own hour because it has its own audience. */
  it('sets the digest hour independently of the household hour', async () => {
    render(<NotificationScheduleSection data={settings()} onSave={onSave} />);
    await userEvent.selectOptions(screen.getByLabelText('Your daily schedule digest'), '6');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledWith({
      householdNotificationsLive: false,
      householdNotificationHour: null,
      scheduleDigestHour: 6,
    });
  });

  /** A scheduled job can be unscheduled again, and null has to survive the save. */
  it('clears a set hour back to not scheduled', async () => {
    render(
      <NotificationScheduleSection data={settings({ householdNotificationHour: 9 })} onSave={onSave} />,
    );
    await userEvent.selectOptions(
      screen.getByLabelText('Invoice reminders and overdue notices'),
      '',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledWith({
      householdNotificationsLive: false,
      householdNotificationHour: null,
      scheduleDigestHour: null,
    });
  });

  /**
   * THE PATCH CARRIES ONLY THIS PANEL'S FIELDS. The settings document has one
   * writer per section under a merge, and a panel that sent a whole model back
   * would revert whatever another section changed since the page loaded.
   */
  it('never sends a field it does not own', async () => {
    render(<NotificationScheduleSection data={settings()} onSave={onSave} />);
    await userEvent.click(screen.getByLabelText('Toggle household notifications'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(Object.keys(onSave.mock.calls[0][0]).sort()).toEqual([
      'householdNotificationHour',
      'householdNotificationsLive',
      'scheduleDigestHour',
    ]);
  });

  it('cannot be saved until something changes', () => {
    render(<NotificationScheduleSection data={settings()} onSave={onSave} />);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('reverts the draft on cancel', async () => {
    render(<NotificationScheduleSection data={settings()} onSave={onSave} />);
    const picker = screen.getByLabelText<HTMLSelectElement>('Invoice reminders and overdue notices');
    await userEvent.selectOptions(picker, '14');
    expect(picker.value).toBe('14');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(picker.value).toBe('');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('shows the business zone, so the operator knows which clock they are setting', () => {
    render(
      <NotificationScheduleSection data={settings({ timeZone: 'America/Chicago' })} onSave={onSave} />,
    );
    expect(screen.getByText('Times are in America/Chicago')).toBeInTheDocument();
  });

  /**
   * Visit reminders go out relative to the visit and obey neither hour, so the
   * panel says so rather than implying it governs every notification.
   */
  it('says where visit reminders are controlled instead of implying it owns them', () => {
    render(<NotificationScheduleSection data={settings()} onSave={onSave} />);
    expect(screen.getByText(/24 to 48 hours before each visit/)).toBeInTheDocument();
  });

  it('surfaces a failed save rather than looking saved', async () => {
    onSave.mockRejectedValue(new Error('permission-denied'));
    render(<NotificationScheduleSection data={settings()} onSave={onSave} />);
    await userEvent.click(screen.getByLabelText('Toggle household notifications'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('permission-denied')).toBeInTheDocument();
  });
});
