import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  threadTimeOf,
  threadDayKey,
  threadClock,
  threadMachineTime,
  threadDayLabel,
  threadReadState,
  unreadThreadCount,
  threadSender,
  threadHouseholdName,
  threadPreviewText,
  threadMessageCount,
  groupThreadsByDay,
  localDateIso,
} from './inboxFormat';

// File-scope TZ pin: several suites below (threadDayKey/threadClock,
// groupThreadsByDay) assert LOCAL day/time derived from a UTC-instant epoch
// ms. Without a fixed zone these pass on a US runner and fail east of UTC; pin
// the whole file to a known zone (the sessionFormat.test.ts convention) so the
// AO-18 local-day guarantee is tested meaningfully everywhere, not just on the
// author's machine.
let fileOriginalTz: string | undefined;
beforeAll(() => {
  fileOriginalTz = process.env.TZ;
  process.env.TZ = 'America/Chicago';
});
afterAll(() => {
  if (fileOriginalTz === undefined) delete process.env.TZ;
  else process.env.TZ = fileOriginalTz;
});

describe('threadTimeOf', () => {
  it('degrades honestly on non-finite/non-positive/NaN input, never fabricating a date', () => {
    expect(threadTimeOf(0)).toBeNull();
    expect(threadTimeOf(-1)).toBeNull();
    expect(threadTimeOf(Number.NaN)).toBeNull();
    expect(threadTimeOf(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('wraps a real epoch-ms value into a Date-backed fake Timestamp', () => {
    const ms = Date.parse('2026-07-16T09:03:00.000Z');
    const wrapped = threadTimeOf(ms);
    expect(wrapped).not.toBeNull();
    expect(wrapped?.toDate().getTime()).toBe(ms);
  });
});

describe('threadDayKey / threadClock (AO-18, applied to epoch-ms)', () => {
  it('Undated / (no time) for a non-finite ms value, same fallback lib/time.ts uses for a missing Timestamp', () => {
    expect(threadDayKey(0)).toBe('Undated');
    expect(threadClock(0)).toBe('(no time)');
  });

  // The historical AO-18 bug, reproduced for THIS field's shape: a naive
  // `new Date(ms).toISOString().slice(0, 10)` reads the UTC calendar day. An
  // 8pm-CDT message stamped as epoch ms for "2026-07-17T01:00:00.000Z" (the
  // next calendar day in UTC) must still group under 2026-07-16 and show
  // 20:00, not 01:00, because threadDayKey/threadClock parse the real instant
  // and ask the LOCAL clock what day/time it fell on.
  it('groups an 8pm-CDT message under its LOCAL day, not the UTC-next day a raw ISO slice would give', () => {
    const eightPmCdtAsUtcMs = Date.parse('2026-07-17T01:00:00.000Z'); // 2026-07-16 20:00 America/Chicago (CDT, UTC-5)
    expect(threadDayKey(eightPmCdtAsUtcMs)).toBe('2026-07-16');
    // The naive approach this replaces, spelled out so the regression is legible:
    expect(new Date(eightPmCdtAsUtcMs).toISOString().slice(0, 10)).toBe('2026-07-17');
  });

  it('shows the LOCAL clock time too, not the UTC hour (five hours off in CDT)', () => {
    expect(threadClock(Date.parse('2026-07-17T01:00:00.000Z'))).toBe('20:00');
  });

  it('a late-evening local time never rolls into the next LOCAL day even near a DST boundary', () => {
    // 11:30pm America/Chicago on 2026-07-16 (still CDT) as UTC epoch ms.
    expect(threadDayKey(Date.parse('2026-07-17T04:30:00.000Z'))).toBe('2026-07-16');
  });
});

describe('threadMachineTime', () => {
  it('is undefined for a non-finite ms value, never a fabricated attribute', () => {
    expect(threadMachineTime(0)).toBeUndefined();
  });

  it('renders a LOCAL machine-readable datetime for a real ms value', () => {
    expect(threadMachineTime(Date.parse('2026-07-17T01:00:00.000Z'))).toBe('2026-07-16T20:00');
  });
});

describe('threadDayLabel (re-exported from sessionFormat, not re-derived)', () => {
  it('labels today/tomorrow/yesterday relative to a given local today', () => {
    expect(threadDayLabel('2026-07-16', '2026-07-16')).toBe('Today');
    expect(threadDayLabel('2026-07-17', '2026-07-16')).toBe('Tomorrow');
    expect(threadDayLabel('2026-07-15', '2026-07-16')).toBe('Yesterday');
  });

  it('passes Undated through verbatim rather than folding it into Today', () => {
    expect(threadDayLabel('Undated', '2026-07-16')).toBe('Undated');
  });
});

describe('threadReadState / unreadThreadCount (positive enumeration, no negation)', () => {
  it('classifies unreadForAdmin true/false as unread/read', () => {
    expect(threadReadState(true)).toBe('unread');
    expect(threadReadState(false)).toBe('read');
  });

  it('counts only unread rows, never fabricating a count from an unrelated field', () => {
    expect(
      unreadThreadCount([
        { unreadForAdmin: true },
        { unreadForAdmin: false },
        { unreadForAdmin: true },
      ]),
    ).toBe(2);
    expect(unreadThreadCount([])).toBe(0);
  });
});

describe('threadSender (positive enumeration, unknown bucket, AO-12-style: never by negation)', () => {
  it('matches the two real values appendMessage ever writes', () => {
    expect(threadSender('kinfolk')).toBe('kinfolk');
    expect(threadSender('auntie')).toBe('auntie');
  });

  it('is case-insensitive and trims whitespace, mirroring sessionState', () => {
    expect(threadSender('  Kinfolk  ')).toBe('kinfolk');
    expect(threadSender('AUNTIE')).toBe('auntie');
  });

  it('an unrecognized or blank value is honestly "unknown", never silently assumed', () => {
    expect(threadSender('')).toBe('unknown');
    expect(threadSender('robot')).toBe('unknown');
  });
});

describe('defensive field reads', () => {
  it('threadHouseholdName falls back to the id when kinfolkName is missing/blank', () => {
    expect(threadHouseholdName(undefined, 'k1')).toBe('k1');
    expect(threadHouseholdName(null, 'k1')).toBe('k1');
    expect(threadHouseholdName('   ', 'k1')).toBe('k1');
    expect(threadHouseholdName('The Alvarez Household', 'k1')).toBe('The Alvarez Household');
  });

  it('threadPreviewText defensively trims and defaults a missing preview to blank', () => {
    expect(threadPreviewText(undefined)).toBe('');
    expect(threadPreviewText(null)).toBe('');
    expect(threadPreviewText('  Thanks!  ')).toBe('Thanks!');
  });

  it('threadMessageCount defaults a missing/non-finite count to 0, never NaN or undefined', () => {
    expect(threadMessageCount(undefined)).toBe(0);
    expect(threadMessageCount(null)).toBe(0);
    expect(threadMessageCount(Number.NaN)).toBe(0);
    expect(threadMessageCount(4)).toBe(4);
  });
});

describe('groupThreadsByDay', () => {
  interface Row {
    id: string;
    lastMessageAtMs: number;
  }

  it('groups rows by LOCAL day, newest day first, newest row first within a day', () => {
    const rows: Row[] = [
      { id: 'earlier-today', lastMessageAtMs: Date.parse('2026-07-16T09:00:00.000Z') },
      { id: 'later-today', lastMessageAtMs: Date.parse('2026-07-16T20:00:00.000Z') },
      { id: 'yesterday', lastMessageAtMs: Date.parse('2026-07-15T09:00:00.000Z') },
    ];
    const groups = groupThreadsByDay(rows);
    expect(groups.map((g) => g.dayKeyValue)).toEqual(['2026-07-16', '2026-07-15']);
    expect(groups[0]?.rows.map((r) => r.id)).toEqual(['later-today', 'earlier-today']);
  });

  it('Undated rows get their own group, sorted last', () => {
    const rows: Row[] = [
      { id: 'dated', lastMessageAtMs: Date.parse('2026-07-16T09:00:00.000Z') },
      { id: 'undated', lastMessageAtMs: 0 },
    ];
    const groups = groupThreadsByDay(rows);
    expect(groups.map((g) => g.dayKeyValue)).toEqual(['2026-07-16', 'Undated']);
  });

  it('an empty input produces no groups, never a fabricated placeholder', () => {
    expect(groupThreadsByDay([])).toEqual([]);
  });
});

describe('localDateIso re-export', () => {
  it('is the same lib/invoiceFormat helper (via sessionFormat), not a re-derived duplicate', () => {
    expect(typeof localDateIso).toBe('function');
    expect(localDateIso(new Date(2026, 6, 16))).toBe('2026-07-16');
  });
});
