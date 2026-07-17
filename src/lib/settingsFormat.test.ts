import { describe, it, expect } from 'vitest';
import {
  DAYS_OF_WEEK,
  businessHoursRows,
  serviceRateRows,
  paymentRows,
  US_HOLIDAYS,
  humanizeId,
  observedHolidayLabels,
  parseDatedEntry,
  companyHolidayRows,
  specialHourRows,
  boolLabel,
  brandingRows,
  portalBannerSummary,
  portalChatSummary,
  portalHomeSummary,
  lastSavedLabel,
} from './settingsFormat';
import { DEFAULT_BUSINESS_SETTINGS } from '../api/settings';

describe('businessHoursRows', () => {
  it('renders one row per day, Monday first, matching the wasm daysOfWeek order', () => {
    const rows = businessHoursRows({ Monday: '09:00-17:00' });
    expect(rows.map((r) => r.day)).toEqual([...DAYS_OF_WEEK]);
    expect(rows[0]).toEqual({ day: 'Monday', label: '09:00-17:00' });
  });

  it('shows "Closed" for a blank or missing day, never an empty string', () => {
    const rows = businessHoursRows({ Sunday: '  ' });
    const sunday = rows.find((r) => r.day === 'Sunday');
    const tuesday = rows.find((r) => r.day === 'Tuesday');
    expect(sunday?.label).toBe('Closed');
    expect(tuesday?.label).toBe('Closed');
  });
});

describe('serviceRateRows', () => {
  it('maps each rate entry and flags an unset rate', () => {
    const rows = serviceRateRows({ 'Drop-in visit': '25.00', 'Overnight': '' });
    expect(rows).toEqual([
      { type: 'Drop-in visit', rate: '25.00' },
      { type: 'Overnight', rate: 'Not set' },
    ]);
  });

  it('drops a blank-type key (unsaveable in the source editor too)', () => {
    expect(serviceRateRows({ '': '10.00' })).toEqual([]);
  });

  it('renders no rows for an empty map, not a fabricated placeholder row', () => {
    expect(serviceRateRows({})).toEqual([]);
  });
});

describe('paymentRows', () => {
  it('shows the three handles in Venmo/PayPal/Cash App order', () => {
    const rows = paymentRows({ venmoHandle: '@tribetails', paypalHandle: '', cashappHandle: '$tribetails' });
    expect(rows.map((r) => r.label)).toEqual(['Venmo', 'PayPal', 'Cash App']);
    expect(rows[0]).toEqual({ label: 'Venmo', value: '@tribetails', isSet: true });
    expect(rows[1]).toEqual({ label: 'PayPal', value: 'Not set (hidden on invoices)', isSet: false });
  });
});

describe('humanizeId', () => {
  it('title-cases a snake_case id', () => {
    expect(humanizeId('some_unknown_id')).toBe('Some Unknown Id');
  });

  it('handles a single-word id', () => {
    expect(humanizeId('solo')).toBe('Solo');
  });
});

describe('observedHolidayLabels', () => {
  it('renders in the fixed catalog order, not the storage order', () => {
    expect(observedHolidayLabels(['christmas', 'new_years'])).toEqual(["New Year's Day", 'Christmas Day']);
  });

  it('renders every US_HOLIDAYS entry when all are observed', () => {
    const allIds = US_HOLIDAYS.map(([id]) => id);
    expect(observedHolidayLabels(allIds)).toEqual(US_HOLIDAYS.map(([, name]) => name));
  });

  it('still shows an id outside the known catalog, humanized, rather than dropping it', () => {
    expect(observedHolidayLabels(['thanksgiving', 'company_founding_day'])).toEqual([
      'Thanksgiving',
      'Company Founding Day',
    ]);
  });

  it('returns an empty list for no observed holidays', () => {
    expect(observedHolidayLabels([])).toEqual([]);
  });
});

describe('parseDatedEntry', () => {
  it('splits on the first pipe only, so a pipe inside the label survives', () => {
    expect(parseDatedEntry('2026-12-25|Office closed | half day')).toEqual({
      date: '2026-12-25',
      label: 'Office closed | half day',
    });
  });

  it('treats a pipe-less entry as an all-label, blank-date row instead of dropping it', () => {
    expect(parseDatedEntry('malformed entry')).toEqual({ date: '', label: 'malformed entry' });
  });
});

describe('companyHolidayRows / specialHourRows', () => {
  it('sorts oldest first', () => {
    const rows = companyHolidayRows(['2026-12-25|Christmas', '2026-01-01|New Year']);
    expect(rows.map((r) => r.date)).toEqual(['2026-01-01', '2026-12-25']);
  });

  it('sorts an unparseable (blank-date) entry last', () => {
    const rows = specialHourRows(['bad entry', '2026-07-04|08:00-12:00']);
    expect(rows.map((r) => r.date)).toEqual(['2026-07-04', '']);
  });

  it('returns an empty list for no entries', () => {
    expect(companyHolidayRows([])).toEqual([]);
    expect(specialHourRows([])).toEqual([]);
  });
});

describe('boolLabel', () => {
  it('renders On/Off', () => {
    expect(boolLabel(true)).toBe('On');
    expect(boolLabel(false)).toBe('Off');
  });
});

describe('brandingRows', () => {
  it('shows the real value when set', () => {
    const rows = brandingRows({
      logoUrl: 'https://cdn/logo.png',
      brandWordmark: 'Tribe Tails',
      brandTagline: 'Care, always',
      homeGreeting: 'Evening',
      homeAccentTail: 'Friend.',
    });
    expect(rows.find((r) => r.label === 'App name')?.value).toBe('Tribe Tails');
  });

  it('shows the shipped-default hint, not a blank value, when a field is unset', () => {
    const rows = brandingRows(DEFAULT_BUSINESS_SETTINGS);
    expect(rows.find((r) => r.label === 'App name')?.value).toBe('Default: "AuntieOS"');
    expect(rows.every((r) => r.value !== '')).toBe(true);
  });
});

describe('MyTribe portal summaries', () => {
  it('portalBannerSummary reports Off when disabled', () => {
    expect(portalBannerSummary(DEFAULT_BUSINESS_SETTINGS.mytribePortal.banner)).toBe('Off');
  });

  it('portalBannerSummary quotes the message when enabled', () => {
    expect(portalBannerSummary({ enabled: true, message: 'We are closed today', tone: 'info', dismissMode: 'none', id: 'x' })).toBe(
      'On: "We are closed today"',
    );
  });

  it('portalBannerSummary flags a message-less enabled banner', () => {
    expect(portalBannerSummary({ enabled: true, message: '', tone: 'info', dismissMode: 'none', id: 'x' })).toBe(
      'On (no message set)',
    );
  });

  it('portalChatSummary reports the away message when set', () => {
    expect(
      portalChatSummary({ enabled: true, awayMessage: "We're out", hoursEnabled: false, hours: {}, maxMessageLength: 2000, rateLimitPerHour: 0 }),
    ).toBe('On, away message: "We\'re out"');
  });

  it('portalHomeSummary counts enabled sections out of the configured total', () => {
    expect(
      portalHomeSummary({
        sections: [
          { id: 'a', enabled: true, limit: 0 },
          { id: 'b', enabled: false, limit: 0 },
          { id: 'c', enabled: true, limit: 3 },
        ],
      }),
    ).toBe('2 of 3 sections shown');
  });

  it('portalHomeSummary reports the default layout when no sections are configured', () => {
    expect(portalHomeSummary({ sections: [] })).toBe('Default layout (no custom sections configured)');
  });
});

describe('lastSavedLabel', () => {
  it('reports "Never saved yet" for a blank updatedAt', () => {
    expect(lastSavedLabel('', 'someone')).toBe('Never saved yet');
  });

  it('reports "Never saved yet" for an unparseable updatedAt, never a fabricated date', () => {
    expect(lastSavedLabel('not-a-date', 'someone')).toBe('Never saved yet');
  });

  it('renders LOCAL time (AO-18), not a UTC slice', () => {
    // Built from LOCAL wall-clock components (the time.test.ts convention), so
    // the assertion holds regardless of the test runner's own timezone: the
    // instant round-trips through toISOString() and back, and formatWhen must
    // read the SAME local wall-clock time out the other side.
    const d = new Date(2026, 6, 16, 20, 5);
    const label = lastSavedLabel(d.toISOString(), 'auntie1');
    expect(label).toContain('by auntie1');
    expect(label).toContain('07-16 20:05');
  });

  it('omits "by X" when updatedBy is blank', () => {
    const label = lastSavedLabel('2026-07-16T09:00:00-05:00', '');
    expect(label).not.toContain(' by ');
  });
});
