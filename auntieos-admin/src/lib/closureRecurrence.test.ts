import { describe, it, expect } from 'vitest';
import {
  parseClosureEntry,
  formatClosureEntry,
  describeClosureRecurrence,
  closureDateInYear,
  closureOccurrencesInRange,
  nextClosureOccurrence,
  closureEntryFromPreset,
  US_HOLIDAY_PRESETS,
  type ClosureEntry,
} from './closureRecurrence';

/**
 * Mirrors `mytribe/functions/test/closureRecurrence.test.ts` exactly (same
 * cases, same expected dates) since this file is a verbatim port of that
 * module. The 2026-07-31 operator ruling: a US national holiday recurs
 * yearly, so the closures editor should not demand a fresh `YYYY-MM-DD` every
 * January. These tests pin the resolver's behavior before any UI is built on
 * top of it, covering the two shapes that are subtle enough to get wrong
 * silently (Nth-weekday, last-weekday), the leap-day policy, and a range
 * crossing a year boundary.
 */

describe('parseClosureEntry: legacy `once` entries are untouched', () => {
  it('a plain YYYY-MM-DD|Name decodes exactly as parseDatedEntry always has', () => {
    expect(parseClosureEntry('2026-12-25|Christmas closure')).toEqual<ClosureEntry>({
      recurrence: 'once',
      name: 'Christmas closure',
      date: '2026-12-25',
      month: 0,
      day: 0,
      weekday: 0,
      nth: 0,
    });
  });

  it('a pipe inside the name still round-trips (limit=2 split)', () => {
    expect(parseClosureEntry('2026-12-25|Office closed | half day').name).toBe('Office closed | half day');
  });

  it('no pipe at all: whole string is the name, blank date (parseDatedEntry parity)', () => {
    const result = parseClosureEntry('malformed entry');
    expect(result).toEqual<ClosureEntry>({
      recurrence: 'once',
      name: 'malformed entry',
      date: '',
      month: 0,
      day: 0,
      weekday: 0,
      nth: 0,
    });
  });

  it('a bare date with no pipe is ALSO the no-pipe fallback (matches parseDatedEntry)', () => {
    const result = parseClosureEntry('2026-12-25');
    expect(result.date).toBe('');
    expect(result.name).toBe('2026-12-25');
  });
});

describe('parseClosureEntry: new yearly shapes', () => {
  it('yearly-fixed', () => {
    expect(parseClosureEntry('yearly:07-04|Independence Day')).toEqual<ClosureEntry>({
      recurrence: 'yearly-fixed',
      name: 'Independence Day',
      date: '',
      month: 7,
      day: 4,
      weekday: 0,
      nth: 0,
    });
  });

  it('yearly-nth-weekday', () => {
    expect(parseClosureEntry('yearly-nth:11-4-4|Thanksgiving')).toEqual<ClosureEntry>({
      recurrence: 'yearly-nth-weekday',
      name: 'Thanksgiving',
      date: '',
      month: 11,
      day: 0,
      weekday: 4,
      nth: 4,
    });
  });

  it('yearly-last-weekday', () => {
    expect(parseClosureEntry('yearly-last:05-1|Memorial Day')).toEqual<ClosureEntry>({
      recurrence: 'yearly-last-weekday',
      name: 'Memorial Day',
      date: '',
      month: 5,
      day: 0,
      weekday: 1,
      nth: 0,
    });
  });
});

describe('parseClosureEntry: malformed / out-of-range shapes fall back instead of lying', () => {
  it('an out-of-range month in yearly: falls back', () => {
    const raw = 'yearly:13-04|Bad month';
    expect(parseClosureEntry(raw)).toEqual<ClosureEntry>({
      recurrence: 'once',
      name: raw,
      date: '',
      month: 0,
      day: 0,
      weekday: 0,
      nth: 0,
    });
  });

  it('a day that does not exist in ANY year (Feb 30) falls back', () => {
    const raw = 'yearly:02-30|Bad day';
    expect(parseClosureEntry(raw).recurrence).toBe('once');
    expect(parseClosureEntry(raw).name).toBe(raw);
  });

  it('an out-of-range weekday or nth never matches the regex, and falls back', () => {
    const raw = 'yearly-nth:11-8-5|Bad weekday and nth';
    expect(parseClosureEntry(raw).recurrence).toBe('once');
    expect(parseClosureEntry(raw).name).toBe(raw);
  });
});

describe('formatClosureEntry: the inverse of parseClosureEntry', () => {
  it('once', () => {
    expect(formatClosureEntry({ recurrence: 'once', name: 'Office closed', date: '2026-09-14' })).toBe(
      '2026-09-14|Office closed',
    );
  });

  it('yearly-fixed zero-pads month and day', () => {
    expect(formatClosureEntry({ recurrence: 'yearly-fixed', name: 'Independence Day', month: 7, day: 4 })).toBe(
      'yearly:07-04|Independence Day',
    );
  });

  it('yearly-nth-weekday', () => {
    expect(
      formatClosureEntry({ recurrence: 'yearly-nth-weekday', name: 'Thanksgiving', month: 11, weekday: 4, nth: 4 }),
    ).toBe('yearly-nth:11-4-4|Thanksgiving');
  });

  it('yearly-last-weekday', () => {
    expect(
      formatClosureEntry({ recurrence: 'yearly-last-weekday', name: 'Memorial Day', month: 5, weekday: 1 }),
    ).toBe('yearly-last:05-1|Memorial Day');
  });

  it('round-trips through parseClosureEntry for every preset', () => {
    for (const preset of US_HOLIDAY_PRESETS) {
      const entry = closureEntryFromPreset(preset);
      const wire = formatClosureEntry({ ...entry });
      expect(parseClosureEntry(wire)).toEqual(entry);
    }
  });
});

describe('describeClosureRecurrence', () => {
  it('once is the bare date', () => {
    expect(describeClosureRecurrence(parseClosureEntry('2026-09-14|Surgery'))).toBe('2026-09-14');
  });

  it('yearly-fixed', () => {
    expect(describeClosureRecurrence(parseClosureEntry('yearly:07-04|Independence Day'))).toBe('Every year, July 4');
  });

  it('yearly-nth-weekday', () => {
    expect(describeClosureRecurrence(parseClosureEntry('yearly-nth:11-4-4|Thanksgiving'))).toBe(
      'Every year, 4th Thursday of November',
    );
  });

  it('yearly-last-weekday', () => {
    expect(describeClosureRecurrence(parseClosureEntry('yearly-last:05-1|Memorial Day'))).toBe(
      'Every year, last Monday of May',
    );
  });
});

describe('closureDateInYear: Thanksgiving (4th Thursday of November)', () => {
  const thanksgiving = closureEntryFromPreset(US_HOLIDAY_PRESETS.find((p) => p.id === 'thanksgiving')!);

  it('2026-11-26', () => {
    expect(closureDateInYear(thanksgiving, 2026)).toBe('2026-11-26');
  });

  it('2027-11-25', () => {
    expect(closureDateInYear(thanksgiving, 2027)).toBe('2027-11-25');
  });
});

describe('closureDateInYear: Memorial Day (last Monday of May)', () => {
  const memorial = closureEntryFromPreset(US_HOLIDAY_PRESETS.find((p) => p.id === 'memorial')!);

  it('2026-05-25', () => {
    expect(closureDateInYear(memorial, 2026)).toBe('2026-05-25');
  });

  it('2027-05-31', () => {
    expect(closureDateInYear(memorial, 2027)).toBe('2027-05-31');
  });
});

describe('leap-day policy: a yearly-fixed Feb 29 entry', () => {
  const leapEntry: ClosureEntry = {
    recurrence: 'yearly-fixed',
    name: 'Leap day closure',
    date: '',
    month: 2,
    day: 29,
    weekday: 0,
    nth: 0,
  };

  it('resolves to Feb 29 in a leap year (2028)', () => {
    expect(closureDateInYear(leapEntry, 2028)).toBe('2028-02-29');
  });

  it('CHOSEN POLICY: resolves to Feb 28 in a non-leap year (2026), not Mar 1 and not no-occurrence', () => {
    expect(closureDateInYear(leapEntry, 2026)).toBe('2026-02-28');
  });

  it('also clamps correctly the following non-leap year (2027)', () => {
    expect(closureDateInYear(leapEntry, 2027)).toBe('2027-02-28');
  });
});

describe('closureOccurrencesInRange: a single-year window', () => {
  it('once entry inside the range', () => {
    const entry = parseClosureEntry('2026-09-14|Surgery');
    expect(closureOccurrencesInRange(entry, '2026-01-01', '2026-12-31')).toEqual(['2026-09-14']);
  });

  it('once entry outside the range', () => {
    const entry = parseClosureEntry('2026-09-14|Surgery');
    expect(closureOccurrencesInRange(entry, '2027-01-01', '2027-12-31')).toEqual([]);
  });

  it('an empty range (start after end) is always empty', () => {
    const entry = parseClosureEntry('yearly:07-04|Independence Day');
    expect(closureOccurrencesInRange(entry, '2026-12-31', '2026-01-01')).toEqual([]);
  });

  it('a yearly-fixed entry inside a same-year range', () => {
    const entry = parseClosureEntry('yearly:07-04|Independence Day');
    expect(closureOccurrencesInRange(entry, '2026-01-01', '2026-12-31')).toEqual(['2026-07-04']);
  });
});

describe('closureOccurrencesInRange: crossing a year boundary', () => {
  it('a Dec-to-Jan window catches BOTH the ending year Christmas and the following year New Year, from two separate entries', () => {
    const christmas = closureEntryFromPreset(US_HOLIDAY_PRESETS.find((p) => p.id === 'christmas')!);
    const newYears = closureEntryFromPreset(US_HOLIDAY_PRESETS.find((p) => p.id === 'new_years')!);

    expect(closureOccurrencesInRange(christmas, '2026-12-20', '2027-01-10')).toEqual(['2026-12-25']);
    expect(closureOccurrencesInRange(newYears, '2026-12-20', '2027-01-10')).toEqual(['2027-01-01']);
  });

  it('a multi-year range returns every occurrence, one per year touched', () => {
    const independence = closureEntryFromPreset(US_HOLIDAY_PRESETS.find((p) => p.id === 'independence')!);
    expect(closureOccurrencesInRange(independence, '2025-01-01', '2028-12-31')).toEqual([
      '2025-07-04',
      '2026-07-04',
      '2027-07-04',
      '2028-07-04',
    ]);
  });

  it('Thanksgiving across the 2026/2027 boundary resolves to the two distinct dates', () => {
    const thanksgiving = closureEntryFromPreset(US_HOLIDAY_PRESETS.find((p) => p.id === 'thanksgiving')!);
    expect(closureOccurrencesInRange(thanksgiving, '2026-01-01', '2027-12-31')).toEqual(['2026-11-26', '2027-11-25']);
  });
});

describe('nextClosureOccurrence', () => {
  it('a once entry in the future', () => {
    expect(nextClosureOccurrence(parseClosureEntry('2026-09-14|Surgery'), '2026-01-01')).toBe('2026-09-14');
  });

  it('a once entry already in the past is null, not last year forever', () => {
    expect(nextClosureOccurrence(parseClosureEntry('2026-09-14|Surgery'), '2026-10-01')).toBeNull();
  });

  it('a yearly entry queried after this year rolls to next year', () => {
    const independence = closureEntryFromPreset(US_HOLIDAY_PRESETS.find((p) => p.id === 'independence')!);
    expect(nextClosureOccurrence(independence, '2026-08-01')).toBe('2027-07-04');
  });

  it('a yearly entry queried before this year in the same year stays this year', () => {
    const independence = closureEntryFromPreset(US_HOLIDAY_PRESETS.find((p) => p.id === 'independence')!);
    expect(nextClosureOccurrence(independence, '2026-01-01')).toBe('2026-07-04');
  });
});

describe('US_HOLIDAY_PRESETS: the full 2026-07-31 ruling catalog resolves correctly', () => {
  const expected2026: Record<string, string> = {
    new_years: '2026-01-01',
    mlk: '2026-01-19',
    presidents: '2026-02-16',
    memorial: '2026-05-25',
    juneteenth: '2026-06-19',
    independence: '2026-07-04',
    labor: '2026-09-07',
    indigenous_columbus: '2026-10-12',
    veterans: '2026-11-11',
    thanksgiving: '2026-11-26',
    christmas: '2026-12-25',
  };

  it('has exactly eleven presets, one per ruling holiday', () => {
    expect(US_HOLIDAY_PRESETS).toHaveLength(11);
  });

  it.each(US_HOLIDAY_PRESETS.map((p) => [p.id, p] as const))('%s resolves to its 2026 date', (id, preset) => {
    const entry = closureEntryFromPreset(preset);
    expect(closureDateInYear(entry, 2026)).toBe(expected2026[id]);
  });
});
