import { describe, it, expect } from 'vitest';
import { blastBlocker, fireAtMsFrom, mergeFieldsToData, parseUidList } from './marketingBlastEdit';

describe('parseUidList', () => {
  it('splits on commas, spaces and newlines, because a pasted column has no commas', () => {
    expect(parseUidList('u1,u2\nu3 u4')).toEqual(['u1', 'u2', 'u3', 'u4']);
  });

  it('drops blanks and de-dupes, so one account is never scheduled the same blast twice', () => {
    expect(parseUidList(' u1 , ,u1,\n\nu2 ')).toEqual(['u1', 'u2']);
  });

  it('returns [] for a blank field', () => {
    expect(parseUidList('  \n ')).toEqual([]);
  });
});

describe('fireAtMsFrom', () => {
  it('reads the pair as LOCAL wall-clock time, not UTC', () => {
    const ms = fireAtMsFrom('2026-06-03', '09:00');
    expect(ms).not.toBeNull();
    const d = new Date(ms as number);
    // If this were parsed as UTC, the local hour would be offset by the zone.
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
    expect(d.getDate()).toBe(3);
  });

  it('is null when either half is missing, rather than defaulting to today', () => {
    expect(fireAtMsFrom('', '09:00')).toBeNull();
    expect(fireAtMsFrom('2026-06-03', '')).toBeNull();
  });

  it('is null for an unparseable pair', () => {
    expect(fireAtMsFrom('not-a-date', '09:00')).toBeNull();
  });
});

describe('mergeFieldsToData', () => {
  it('builds the record from named rows', () => {
    expect(mergeFieldsToData([{ key: ' headline ', value: 'Hello' }])).toEqual({ headline: 'Hello' });
  });

  it('drops a row with no key, which could never match a template token', () => {
    expect(mergeFieldsToData([{ key: '', value: 'orphan' }])).toEqual({});
  });

  it('lets a later row win, so the last thing typed is what is sent', () => {
    expect(
      mergeFieldsToData([
        { key: 'cta', value: 'first' },
        { key: 'cta', value: 'second' },
      ]),
    ).toEqual({ cta: 'second' });
  });

  it('keeps a blank VALUE, which is a real choice, unlike a blank key', () => {
    expect(mergeFieldsToData([{ key: 'note', value: '' }])).toEqual({ note: '' });
  });
});

describe('blastBlocker', () => {
  const now = 1_800_000_000_000;
  const audience = { criteria: { kind: 'all' } } as const;

  it('blocks with no audience first, before complaining about the time', () => {
    expect(blastBlocker(null, null, now, undefined)).toBe('Choose an audience first.');
  });

  it('blocks on a missing send time', () => {
    expect(blastBlocker(audience, null, now, undefined)).toBe('Pick a date and a time to send.');
  });

  it('blocks a time the server would refuse as past', () => {
    expect(blastBlocker(audience, now - 120_000, now, undefined)).toBe('That send time has already passed.');
  });

  it('allows a time inside the server\'s own 60 second grace window', () => {
    expect(blastBlocker(audience, now - 30_000, now, undefined)).toBeNull();
  });

  it('blocks once a preview has proven the audience reaches nobody', () => {
    expect(blastBlocker(audience, now + 60_000, now, 0)).toBe(
      'This audience reaches nobody. Widen it, or check who has opted in.',
    );
  });

  it('does NOT block when no preview has been run: undefined is not zero', () => {
    expect(blastBlocker(audience, now + 60_000, now, undefined)).toBeNull();
  });

  it('allows a previewed audience that reaches someone', () => {
    expect(blastBlocker(audience, now + 60_000, now, 12)).toBeNull();
  });
});
