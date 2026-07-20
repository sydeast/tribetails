import { describe, expect, it } from 'vitest';
import {
  bookingChip,
  calTile,
  elapsedMinutes,
  fullDateKick,
  greetingKick,
  isoTime,
  kinVariant,
  relativeDay,
  resolveHomeLayout,
  speciesEmoji,
  visitSubtitle,
  visitVariant,
  weekdayTime,
} from './portalFormat';

describe('calTile', () => {
  it('formats month + zero-padded day', () => {
    expect(calTile(new Date(2026, 5, 2).getTime())).toEqual({ month: 'Jun', day: '02' });
  });
});

describe('weekdayTime', () => {
  it('formats weekday + 12h time', () => {
    expect(weekdayTime(new Date(2026, 5, 1, 8, 0).getTime())).toBe('Mon, 8:00 AM');
  });

  it('handles noon and midnight edges', () => {
    expect(weekdayTime(new Date(2026, 5, 1, 0, 5).getTime())).toBe('Mon, 12:05 AM');
    expect(weekdayTime(new Date(2026, 5, 1, 12, 0).getTime())).toBe('Mon, 12:00 PM');
  });
});

describe('visitSubtitle', () => {
  it('combines weekday-time with the auntie name', () => {
    expect(visitSubtitle(new Date(2026, 5, 1, 8, 0).getTime(), 'Maya')).toBe('Mon, 8:00 AM with Auntie Maya');
  });

  it('falls back when the start time is unknown', () => {
    expect(visitSubtitle(null, 'Maya')).toBe('With Auntie Maya');
    expect(visitSubtitle(null, null)).toBe('Time to be confirmed');
  });
});

describe('relativeDay', () => {
  const now = new Date(2026, 5, 10, 9, 0).getTime();

  it('today / yesterday / N days ago', () => {
    expect(relativeDay(new Date(2026, 5, 10, 2, 0).getTime(), now)).toBe('Today');
    expect(relativeDay(new Date(2026, 5, 9).getTime(), now)).toBe('Yesterday');
    expect(relativeDay(new Date(2026, 5, 7).getTime(), now)).toBe('3 days ago');
  });

  it('falls back to a short date past a week out', () => {
    expect(relativeDay(new Date(2026, 5, 1).getTime(), now)).toBe('Jun 1');
  });
});

describe('speciesEmoji', () => {
  it('maps known species', () => {
    expect(speciesEmoji('dog')).toBe('\u{1F436}');
    expect(speciesEmoji('Cat')).toBe('\u{1F431}');
  });

  it('falls back to a paw print for unknown/null species', () => {
    expect(speciesEmoji('betta fish')).toBe('\u{1F43E}');
    expect(speciesEmoji(null)).toBe('\u{1F43E}');
  });
});

describe('bookingChip', () => {
  it.each([
    ['confirmed', 'CONFIRMED', 'warm'],
    ['requested', 'PENDING', 'go'],
    ['completed', 'COMPLETED', 'done'],
    ['cancelled', 'CANCELLED', 'done'],
  ] as const)('%s -> %s / %s', (status, label, tone) => {
    expect(bookingChip(status)).toEqual({ label, tone });
  });
});

describe('visitVariant', () => {
  it('cycles v1/v2/v3', () => {
    expect([0, 1, 2, 3, 4].map(visitVariant)).toEqual(['v1', 'v2', 'v3', 'v1', 'v2']);
  });
});

describe('kinVariant', () => {
  it('cycles k1..k4', () => {
    expect([0, 1, 2, 3, 4].map(kinVariant)).toEqual(['k1', 'k2', 'k3', 'k4', 'k1']);
  });
});

describe('greetingKick', () => {
  it.each([
    [new Date(2026, 5, 6, 8, 0).getTime(), 'Saturday morning'],
    [new Date(2026, 5, 6, 13, 0).getTime(), 'Saturday afternoon'],
    [new Date(2026, 5, 6, 19, 0).getTime(), 'Saturday evening'],
  ])('%d -> %s', (now, expected) => {
    expect(greetingKick(now)).toBe(expected);
  });
});

describe('elapsedMinutes', () => {
  it('computes whole minutes since start', () => {
    const start = new Date(2026, 5, 6, 8, 0).getTime();
    const now = new Date(2026, 5, 6, 8, 12, 30).getTime();
    expect(elapsedMinutes(start, now)).toBe(12);
  });

  it('clamps to 0 for future timestamps (clock skew)', () => {
    expect(elapsedMinutes(Date.now() + 60_000)).toBe(0);
  });
});

describe('fullDateKick', () => {
  it('formats weekday, abbreviated month, day', () => {
    expect(fullDateKick(new Date(2026, 5, 6).getTime())).toBe('Saturday, Jun 6');
  });
});

describe('isoTime', () => {
  it('extracts the time-of-day portion', () => {
    expect(isoTime(new Date(2026, 5, 6, 8, 2).toISOString())).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
  });

  it('returns null for missing/invalid input', () => {
    expect(isoTime(null)).toBeNull();
    expect(isoTime('not-a-date')).toBeNull();
  });
});

describe('resolveHomeLayout', () => {
  it('empty config -> canonical order, all sections, unlimited', () => {
    expect(resolveHomeLayout([])).toEqual([
      { id: 'liveVisit', limit: 0 },
      { id: 'upNext', limit: 0 },
      { id: 'tales', limit: 0 },
      { id: 'roster', limit: 0 },
      { id: 'quickStart', limit: 0 },
    ]);
  });

  it('configured order is honored verbatim (not forced back to canonical)', () => {
    expect(
      resolveHomeLayout([
        { id: 'quickStart', enabled: true, limit: 0 },
        { id: 'tales', enabled: true, limit: 5 },
      ]),
    ).toEqual([
      { id: 'quickStart', limit: 0 },
      { id: 'tales', limit: 5 },
    ]);
  });

  it('drops disabled sections', () => {
    expect(
      resolveHomeLayout([
        { id: 'upNext', enabled: false, limit: 0 },
        { id: 'roster', enabled: true, limit: 2 },
      ]),
    ).toEqual([{ id: 'roster', limit: 2 }]);
  });

  it('drops unknown section ids (forward-compat with a future operator config)', () => {
    expect(
      resolveHomeLayout([
        { id: 'someFutureWidget', enabled: true, limit: 0 },
        { id: 'roster', enabled: true, limit: 0 },
      ]),
    ).toEqual([{ id: 'roster', limit: 0 }]);
  });
});
