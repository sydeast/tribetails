import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  commentTimeOf,
  commentDayKey,
  commentWhen,
  commentMachineTime,
  commentAuthorRole,
  commentAuthorLabel,
  loveSummaryLabel,
  kinTaleMediaKindOf,
} from './kinTaleDetailFormat';

// TZ pinned to a west-of-UTC zone so the AO-18 (local, never UTC-slice)
// assertions below are meaningful on any CI runner, the identical rationale
// as sessionFormat.test.ts / kinTaleFormat.test.ts / inboxFormat.test.ts.
let originalTz: string | undefined;
beforeAll(() => {
  originalTz = process.env.TZ;
  process.env.TZ = 'America/Chicago';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe('commentTimeOf (AO-18: local, never a raw UTC slice)', () => {
  it('degrades honestly on null/non-finite/non-positive/NaN input, never fabricating a date', () => {
    expect(commentTimeOf(null)).toBeNull();
    expect(commentTimeOf(0)).toBeNull();
    expect(commentTimeOf(-1)).toBeNull();
    expect(commentTimeOf(Number.NaN)).toBeNull();
    expect(commentTimeOf(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('groups a late-evening UTC instant under its LOCAL day, not the UTC-next day', () => {
    // 2026-07-16 23:30 America/Chicago (CDT, UTC-5) == 2026-07-17 04:30 UTC.
    const ms = Date.parse('2026-07-17T04:30:00.000Z');
    expect(commentDayKey(ms)).toBe('2026-07-16');
  });
});

describe('commentWhen', () => {
  it('formats LOCAL "MM-DD HH:mm"', () => {
    const ms = Date.parse('2026-07-16T19:32:00.000Z'); // 14:32 CDT
    expect(commentWhen(ms)).toBe('07-16 14:32');
  });

  it('falls back to "Date TBD", never "(no time)", for a missing/unparseable value', () => {
    expect(commentWhen(null)).toBe('Date TBD');
    expect(commentWhen(Number.NaN)).toBe('Date TBD');
  });
});

describe('commentMachineTime', () => {
  it('returns a LOCAL machine-readable datetime for a real value', () => {
    const ms = Date.parse('2026-07-16T19:32:00.000Z');
    expect(commentMachineTime(ms)).toBe('2026-07-16T14:32');
  });

  it('returns undefined for a missing value, never a fabricated attribute', () => {
    expect(commentMachineTime(null)).toBeUndefined();
  });
});

describe('commentAuthorRole (positive enumeration, no negation)', () => {
  it('classifies the two real values the backend writes', () => {
    expect(commentAuthorRole('admin')).toBe('admin');
    expect(commentAuthorRole('kinfolk')).toBe('kinfolk');
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(commentAuthorRole(' ADMIN ')).toBe('admin');
  });

  it('buckets any other text as unknown, never guessing a side', () => {
    expect(commentAuthorRole('')).toBe('unknown');
    expect(commentAuthorRole('robot')).toBe('unknown');
  });
});

describe('commentAuthorLabel', () => {
  it('labels staff as Auntie', () => {
    expect(commentAuthorLabel({ authorRole: 'admin', guestName: null })).toBe('Auntie');
  });

  it('labels a kinfolk reply with the real guestName when present', () => {
    expect(commentAuthorLabel({ authorRole: 'kinfolk', guestName: 'Jamie' })).toBe('Jamie');
  });

  it('falls back to "Kinfolk" for a blank/absent guestName, never a fabricated name', () => {
    expect(commentAuthorLabel({ authorRole: 'kinfolk', guestName: null })).toBe('Kinfolk');
    expect(commentAuthorLabel({ authorRole: 'kinfolk', guestName: '   ' })).toBe('Kinfolk');
  });

  it('labels an unrecognized role "Someone", never guessing which side', () => {
    expect(commentAuthorLabel({ authorRole: 'robot', guestName: null })).toBe('Someone');
  });
});

describe('loveSummaryLabel', () => {
  it('reports no reactions honestly', () => {
    expect(loveSummaryLabel(false, 0)).toBe('No reactions yet.');
  });

  it('singular, self-reacted', () => {
    expect(loveSummaryLabel(true, 1)).toBe('You loved this.');
  });

  it('singular, someone else reacted (never claims "you")', () => {
    expect(loveSummaryLabel(false, 1)).toBe('1 person loved this.');
  });

  it('plural, self + others, correct pluralization at exactly one other', () => {
    expect(loveSummaryLabel(true, 2)).toBe('You and 1 other loved this.');
  });

  it('plural, self + several others', () => {
    expect(loveSummaryLabel(true, 4)).toBe('You and 3 others loved this.');
  });

  it('plural, none of them you', () => {
    expect(loveSummaryLabel(false, 3)).toBe('3 people loved this.');
  });
});

describe('kinTaleMediaKindOf (positive enumeration, no negation)', () => {
  it('classifies image/* and video/* MIME types', () => {
    expect(kinTaleMediaKindOf('image/jpeg')).toBe('image');
    expect(kinTaleMediaKindOf('video/mp4')).toBe('video');
  });

  it('is case-insensitive', () => {
    expect(kinTaleMediaKindOf('IMAGE/PNG')).toBe('image');
  });

  it('buckets null/other MIME types as "other", never guessing a preview', () => {
    expect(kinTaleMediaKindOf(null)).toBe('other');
    expect(kinTaleMediaKindOf('application/pdf')).toBe('other');
  });
});
