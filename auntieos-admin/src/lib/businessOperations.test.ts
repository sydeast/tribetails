import { describe, it, expect } from 'vitest';
import {
  BOOKING_MODES,
  MAX_OPTION_LIST_LENGTH,
  MAX_TIME_BLOCKS,
  NUMBER_FIELDS,
  clampToOptions,
  defaultBlockEnd,
  formatOptionList,
  isUsableTimeZone,
  optionsIncluding,
  parseOptionList,
  parseWholeNumber,
  slugifyBlockId,
  timeBlockDraft,
  timeZoneOptions,
  validateTimeBlocks,
  firstActiveOverlap,
  compareBlocksByStart,
  type TimeBlockDraft,
} from './businessOperations';

function block(over: Partial<TimeBlockDraft> = {}): TimeBlockDraft {
  return { id: 'midday', label: 'Midday', startTime: '11:00', endTime: '15:00', active: true, ...over };
}

describe('optionsIncluding', () => {
  it('returns the vocabulary unchanged when the stored value is a member', () => {
    expect(optionsIncluding(BOOKING_MODES, 'TIME_BLOCK')).toHaveLength(BOOKING_MODES.length);
  });

  it('keeps an unknown stored value visible rather than snapping the control to a legal one', () => {
    const out = optionsIncluding(BOOKING_MODES, 'LEGACY_MODE');
    expect(out).toHaveLength(BOOKING_MODES.length + 1);
    expect(out.at(-1)).toEqual({ value: 'LEGACY_MODE', label: 'LEGACY_MODE (not a known value)' });
  });
});

describe('parseWholeNumber', () => {
  const spec = NUMBER_FIELDS.travelBufferMinutes;

  it('accepts a whole number inside the range', () => {
    expect(parseWholeNumber('30', spec)).toEqual({ value: 30 });
  });

  it('accepts the range endpoints', () => {
    expect(parseWholeNumber(String(spec.min), spec)).toEqual({ value: spec.min });
    expect(parseWholeNumber(String(spec.max), spec)).toEqual({ value: spec.max });
  });

  it('refuses a blank box rather than reading it as zero', () => {
    expect(parseWholeNumber('   ', spec)).toEqual({ error: 'Enter a number.' });
  });

  it('refuses a decimal, a negative, and letters', () => {
    expect(parseWholeNumber('4.5', spec)).toHaveProperty('error');
    expect(parseWholeNumber('-1', spec)).toHaveProperty('error');
    expect(parseWholeNumber('3O', spec)).toEqual({ error: 'Whole numbers only.' });
  });

  it('refuses a value past the range and says what the range is', () => {
    expect(parseWholeNumber(String(spec.max + 1), spec)).toEqual({
      error: `Enter ${spec.min} to ${spec.max} minutes.`,
    });
  });
});

describe('parseOptionList', () => {
  it('parses, sorts and de-spaces a comma list', () => {
    expect(parseOptionList(' 15,5 , 10 ', 'minutes')).toEqual({ value: [5, 10, 15] });
  });

  it('tolerates a trailing comma', () => {
    expect(parseOptionList('30, 60,', 'days')).toEqual({ value: [30, 60] });
  });

  it('refuses an empty list, because a dropdown with no rows offers nothing', () => {
    expect(parseOptionList('  ', 'minutes')).toEqual({ error: 'List at least one option, in minutes.' });
  });

  it('refuses a duplicate, naming it', () => {
    expect(parseOptionList('5, 10, 5', 'minutes')).toEqual({ error: '5 is listed twice.' });
  });

  it('refuses zero and non-numbers', () => {
    expect(parseOptionList('0, 5', 'minutes')).toEqual({ error: 'Every option has to be more than zero.' });
    expect(parseOptionList('5, soon', 'minutes')).toEqual({ error: '"soon" is not a whole number.' });
  });

  it('refuses a list longer than the cap', () => {
    const long = Array.from({ length: MAX_OPTION_LIST_LENGTH + 1 }, (_, i) => i + 1).join(',');
    expect(parseOptionList(long, 'minutes')).toHaveProperty('error');
  });

  it('round-trips through formatOptionList', () => {
    const parsed = parseOptionList(formatOptionList([5, 10, 15]), 'minutes');
    expect(parsed).toEqual({ value: [5, 10, 15] });
  });
});

describe('clampToOptions', () => {
  it('leaves a value that is already an option alone', () => {
    expect(clampToOptions(15, [5, 10, 15, 20])).toBe(15);
  });

  it('moves a dropped default to the nearest surviving option', () => {
    expect(clampToOptions(15, [5, 10, 20])).toBe(10);
  });

  it('breaks a tie toward the SMALLER option, so nobody is silently given a longer wait', () => {
    expect(clampToOptions(15, [10, 20])).toBe(10);
  });

  it('has nowhere to move to when the list is empty', () => {
    expect(clampToOptions(15, [])).toBe(15);
  });
});

describe('timeBlockDraft', () => {
  it('coerces every optional wire field to editable text instead of trusting it', () => {
    expect(timeBlockDraft({ active: true })).toEqual({
      id: '',
      label: '',
      startTime: '',
      endTime: '',
      active: true,
    });
  });

  it('reads a missing `active` as off', () => {
    expect(timeBlockDraft({ id: 'x', active: undefined as unknown as boolean }).active).toBe(false);
  });
});

describe('validateTimeBlocks', () => {
  it('accepts a well-formed set', () => {
    const out = validateTimeBlocks([block(), block({ id: 'evening', label: 'Evening', startTime: '17:00', endTime: '20:00' })]);
    expect(out).toEqual({
      value: [
        { id: 'midday', label: 'Midday', startTime: '11:00', endTime: '15:00', active: true },
        { id: 'evening', label: 'Evening', startTime: '17:00', endTime: '20:00', active: true },
      ],
    });
  });

  it('trims the label it stores', () => {
    const out = validateTimeBlocks([block({ label: '  Midday  ' })]);
    expect('value' in out && out.value[0]?.label).toBe('Midday');
  });

  it('refuses a blank name', () => {
    expect(validateTimeBlocks([block({ label: '  ' })])).toEqual({ error: 'Every block needs a name.' });
  });

  it('refuses two blocks with the same name, whatever the case', () => {
    expect(validateTimeBlocks([block(), block({ id: 'b2', label: 'MIDDAY' })])).toEqual({
      error: 'Two blocks are both called "MIDDAY".',
    });
  });

  it('refuses a malformed time', () => {
    expect(validateTimeBlocks([block({ startTime: '9:00' })])).toHaveProperty('error');
    expect(validateTimeBlocks([block({ endTime: '25:00' })])).toHaveProperty('error');
  });

  it('refuses a block that would wrap past midnight, because resolveTimeBlock would never match it', () => {
    expect(validateTimeBlocks([block({ startTime: '22:00', endTime: '02:00' })])).toEqual({
      error: '"Midday" has to end after it starts. A block cannot run past midnight.',
    });
  });

  it('refuses a zero-length block', () => {
    expect(validateTimeBlocks([block({ startTime: '11:00', endTime: '11:00' })])).toHaveProperty('error');
  });

  it('refuses duplicate ids', () => {
    expect(validateTimeBlocks([block(), block({ label: 'Evening' })])).toEqual({
      error: 'Two blocks share the id "midday".',
    });
  });

  /**
   * `resolveTimeBlock` picks with `firstOrNull` over the ACTIVE rows, so two
   * overlapping live blocks make a visit's displayed name a function of array
   * order rather than of the block a kinfolk chose.
   */
  it('refuses two ACTIVE blocks that overlap, naming both', () => {
    const out = validateTimeBlocks([
      block({ id: 'morning', label: 'Morning', startTime: '09:00', endTime: '13:00' }),
      block({ id: 'midday', label: 'Midday', startTime: '11:00', endTime: '15:00' }),
    ]);
    expect('error' in out && out.error).toContain('"Morning" and "Midday" overlap');
  });
  it('allows blocks that merely touch, because the range is half open', () => {
    const out = validateTimeBlocks([
      block({ id: 'morning', label: 'Morning', startTime: '09:00', endTime: '11:00' }),
      block({ id: 'midday', label: 'Midday', startTime: '11:00', endTime: '15:00' }),
    ]);
    expect('value' in out).toBe(true);
  });
  /** A parked seasonal block is not a conflict until it is switched on. */
  it('allows an INACTIVE block to overlap a live one', () => {
    const out = validateTimeBlocks([
      block({ id: 'morning', label: 'Morning', startTime: '09:00', endTime: '13:00', active: false }),
      block({ id: 'midday', label: 'Midday', startTime: '11:00', endTime: '15:00' }),
    ]);
    expect('value' in out).toBe(true);
  });
  it('stores rows sorted by start time, whatever order they were typed in', () => {
    const out = validateTimeBlocks([
      block({ id: 'evening', label: 'Evening', startTime: '17:00', endTime: '20:00' }),
      block({ id: 'dawn', label: 'Dawn', startTime: '06:00', endTime: '08:00' }),
      block({ id: 'midday', label: 'Midday', startTime: '11:00', endTime: '15:00' }),
    ]);
    expect('value' in out && out.value.map((b) => b.id)).toEqual(['dawn', 'midday', 'evening']);
  });
  it('refuses more blocks than the cap', () => {
    const many = Array.from({ length: MAX_TIME_BLOCKS + 1 }, (_, i) =>
      block({ id: `b${i}`, label: `Block ${i}` }),
    );
    expect(validateTimeBlocks(many)).toHaveProperty('error');
  });
});

describe('slugifyBlockId', () => {
  it('slugifies a label', () => {
    expect(slugifyBlockId('Late afternoon', [])).toBe('late-afternoon');
  });

  it('falls back to `block` when a label has nothing slug-safe in it', () => {
    expect(slugifyBlockId('!!!', [])).toBe('block');
  });

  it('suffixes rather than colliding with an id already in use', () => {
    expect(slugifyBlockId('Midday', ['midday'])).toBe('midday-2');
    expect(slugifyBlockId('Midday', ['midday', 'midday-2'])).toBe('midday-3');
  });
});

describe('defaultBlockEnd', () => {
  it('adds the default block length to the start', () => {
    expect(defaultBlockEnd('09:00', 4)).toBe('13:00');
  });

  it('caps at the end of the day rather than wrapping into the next one', () => {
    expect(defaultBlockEnd('22:00', 6)).toBe('23:59');
  });

  it('falls back to the end of the day on a malformed start', () => {
    expect(defaultBlockEnd('nope', 4)).toBe('23:59');
  });
});

describe('timeZoneOptions', () => {
  it('always contains the shipped default', () => {
    expect(timeZoneOptions('')).toContain('America/New_York');
  });

  it('keeps a stored zone this runtime does not know, rather than dropping it', () => {
    expect(timeZoneOptions('Mars/Olympus')).toContain('Mars/Olympus');
  });

  it('is sorted and free of duplicates', () => {
    const out = timeZoneOptions('America/New_York');
    expect(new Set(out).size).toBe(out.length);
    expect([...out].sort((a, b) => a.localeCompare(b))).toEqual(out);
  });
});

describe('isUsableTimeZone', () => {
  it('accepts a real IANA id', () => {
    expect(isUsableTimeZone('America/Chicago')).toBe(true);
  });

  it('refuses a blank and a made-up one', () => {
    expect(isUsableTimeZone('   ')).toBe(false);
    expect(isUsableTimeZone('Mars/Olympus')).toBe(false);
  });
});

describe('firstActiveOverlap / compareBlocksByStart', () => {
  const b = (id: string, startTime: string, endTime: string, active = true) => ({
    id, label: id, startTime, endTime, active,
  });
  it('finds nothing wrong with a start-ordered, non-overlapping set', () => {
    expect(firstActiveOverlap([b('a', '09:00', '11:00'), b('b', '11:00', '13:00')])).toBeNull();
  });
  it('names the overlapping pair', () => {
    expect(firstActiveOverlap([b('a', '09:00', '12:00'), b('b', '11:00', '13:00')])).toEqual(['a', 'b']);
  });
  it('ignores inactive rows entirely', () => {
    expect(firstActiveOverlap([b('a', '09:00', '12:00', false), b('b', '11:00', '13:00')])).toBeNull();
  });
  it('orders by start, then end, then label', () => {
    const rows = [b('z', '11:00', '15:00'), b('a', '09:00', '10:00'), b('m', '11:00', '12:00')];
    expect([...rows].sort(compareBlocksByStart).map((r) => r.id)).toEqual(['a', 'm', 'z']);
  });
});
