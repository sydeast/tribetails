import { describe, it, expect } from 'vitest';
import {
  DAYS_OF_WEEK,
  businessHoursRows,
  serviceRateRows,
  US_HOLIDAYS,
  humanizeId,
  observedHolidayLabels,
  parseDatedEntry,
  companyHolidayRows,
  specialHourRows,
  portalHomeSummary,
  effectiveHomeSections,
  homeSectionLabel,
  moveHomeSectionUp,
  moveHomeSectionDown,
  HOME_SECTION_CATALOG,
  lastSavedLabel,
} from './settingsFormat';

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

describe('portalHomeSummary', () => {
  it('counts enabled sections out of the configured total', () => {
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

  it('reports the default layout when no sections are configured', () => {
    expect(portalHomeSummary({ sections: [] })).toBe('Default layout (no custom sections configured)');
  });
});

describe('homeSectionLabel', () => {
  it('names every catalogue id', () => {
    for (const s of HOME_SECTION_CATALOG) {
      expect(homeSectionLabel(s.id)).toBe(s.label);
    }
  });

  it('falls back to the raw id for an unknown or future section', () => {
    expect(homeSectionLabel('futureSection')).toBe('futureSection');
  });

  it('names an id-less row rather than rendering it uneditable', () => {
    expect(homeSectionLabel(undefined)).toBe('Unnamed section');
  });
});

describe('effectiveHomeSections', () => {
  it('materializes the canonical order, everything enabled and unlimited, when sections is empty', () => {
    expect(effectiveHomeSections([])).toEqual(
      HOME_SECTION_CATALOG.map((s) => ({ id: s.id, enabled: true, limit: 0 })),
    );
  });

  it('leaves a full, already-configured array untouched', () => {
    const configured = HOME_SECTION_CATALOG.map((s) => ({ id: s.id, enabled: false, limit: 2 }));
    expect(effectiveHomeSections(configured)).toEqual(configured);
  });

  it('appends a catalogue section a partial array omitted, disabled, so it stays reachable', () => {
    const partial = [{ id: 'upNext', enabled: true, limit: 5 }];
    const result = effectiveHomeSections(partial);
    expect(result[0]).toEqual({ id: 'upNext', enabled: true, limit: 5 });
    const rest = result.slice(1);
    expect(rest).toHaveLength(HOME_SECTION_CATALOG.length - 1);
    expect(rest.every((r) => r.enabled === false && r.limit === 0)).toBe(true);
  });

  it('keeps an unknown/legacy id rather than dropping it', () => {
    const legacy = [{ id: 'retiredSection', enabled: true, limit: 0 }];
    const result = effectiveHomeSections(legacy);
    expect(result[0]).toEqual({ id: 'retiredSection', enabled: true, limit: 0 });
    expect(result).toHaveLength(1 + HOME_SECTION_CATALOG.length);
  });
});

describe('moveHomeSectionUp / moveHomeSectionDown', () => {
  const rows = ['a', 'b', 'c'];

  it('swaps one step in each direction', () => {
    expect(moveHomeSectionUp(rows, 1)).toEqual(['b', 'a', 'c']);
    expect(moveHomeSectionDown(rows, 1)).toEqual(['a', 'c', 'b']);
  });

  it('is a no-op at either edge or out of range', () => {
    expect(moveHomeSectionUp(rows, 0)).toEqual(rows);
    expect(moveHomeSectionDown(rows, rows.length - 1)).toEqual(rows);
    expect(moveHomeSectionUp(rows, -1)).toEqual(rows);
    expect(moveHomeSectionDown(rows, rows.length)).toEqual(rows);
  });

  it('round-trips: moving up then down returns the original order', () => {
    expect(moveHomeSectionDown(moveHomeSectionUp(rows, 2), 1)).toEqual(rows);
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
