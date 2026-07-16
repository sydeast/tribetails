import { describe, expect, it } from 'vitest';
import { denCurrentHour, formatTime, greetingForHour, serviceTone, statusLabel } from './denFormat';

/**
 * Ported from ui/components/DenScreenKit.kt + AuntieTones.kt. These specs exist to
 * pin the two things a reader would otherwise "correct" on sight: the lopsided
 * greeting boundaries (evening starts at 17, not 18) and serviceTone's "visit"
 * contains "sit" collision. Both match the live wasm app. If one of these fails,
 * the fix is a decision about the Kotlin, not a nudge to the expectation.
 */

describe('greetingForHour', () => {
  // The flip hours and the hour either side of each. Everything else is interior.
  it('greets morning from midnight through 11, the last morning hour', () => {
    expect(greetingForHour(0)).toBe('Good morning');
    expect(greetingForHour(10)).toBe('Good morning');
    expect(greetingForHour(11)).toBe('Good morning');
  });

  it('flips to afternoon exactly at noon', () => {
    expect(greetingForHour(11)).toBe('Good morning');
    expect(greetingForHour(12)).toBe('Good afternoon');
    expect(greetingForHour(13)).toBe('Good afternoon');
  });

  it('flips to evening at 17, NOT at 18: 16 is the last afternoon hour', () => {
    expect(greetingForHour(15)).toBe('Good afternoon');
    expect(greetingForHour(16)).toBe('Good afternoon');
    expect(greetingForHour(17)).toBe('Good evening');
    expect(greetingForHour(18)).toBe('Good evening');
  });

  it('stays evening through the last hour of the day', () => {
    expect(greetingForHour(23)).toBe('Good evening');
  });

  // Out-of-range hours cannot come from denCurrentHour, but greetingForHour is
  // exported on its own, so its total behaviour is worth stating.
  it('falls to evening for hours outside 0..23, matching the Kotlin else branch', () => {
    expect(greetingForHour(24)).toBe('Good evening');
    expect(greetingForHour(-1)).toBe('Good evening');
  });
});

describe('denCurrentHour', () => {
  it('reads the local hour off the injected instant', () => {
    // Constructed from local parts, so this asserts local reading without pinning
    // the suite to whatever zone CI happens to run in.
    expect(denCurrentHour(new Date(2026, 6, 15, 9, 30, 0))).toBe(9);
    expect(denCurrentHour(new Date(2026, 6, 15, 17, 0, 0))).toBe(17);
  });

  it('handles both ends of the day, where a clock-reading helper could not be tested', () => {
    expect(denCurrentHour(new Date(2026, 6, 15, 0, 0, 0))).toBe(0);
    expect(denCurrentHour(new Date(2026, 6, 15, 23, 59, 59))).toBe(23);
  });

  it('falls back to 9 for an Invalid Date, mirroring the Kotlin getOrDefault(9)', () => {
    expect(denCurrentHour(new Date('not a date'))).toBe(9);
  });

  it('composes with greetingForHour across a full day', () => {
    const at = (h: number) => greetingForHour(denCurrentHour(new Date(2026, 6, 15, h, 0, 0)));
    expect(at(0)).toBe('Good morning');
    expect(at(11)).toBe('Good morning');
    expect(at(12)).toBe('Good afternoon');
    expect(at(16)).toBe('Good afternoon');
    expect(at(17)).toBe('Good evening');
    expect(at(23)).toBe('Good evening');
  });
});

describe('serviceTone', () => {
  it('maps the four recognised service families', () => {
    expect(serviceTone('dog_walk')).toBe('teal');
    expect(serviceTone('drop_in')).toBe('orange');
    expect(serviceTone('house_sitting')).toBe('purple');
    expect(serviceTone('meet_and_greet')).toBe('success');
  });

  it('matches each purple alias', () => {
    expect(serviceTone('sitting')).toBe('purple');
    expect(serviceTone('housecall')).toBe('purple');
    expect(serviceTone('overnight')).toBe('purple');
  });

  it('matches greet as well as meet', () => {
    expect(serviceTone('greeting')).toBe('success');
  });

  it('is case insensitive', () => {
    expect(serviceTone('DOG_WALK')).toBe('teal');
    expect(serviceTone('OverNight')).toBe('purple');
  });

  it('checks walk before sit, so a walk that mentions sitting is still a walk', () => {
    // Order dependency: both substrings are present. walk must win.
    expect(serviceTone('walk_and_sit')).toBe('teal');
  });

  it('checks drop before sit', () => {
    expect(serviceTone('drop_in_sitting')).toBe('orange');
  });

  it('gives "visit" keys the PURPLE sitting tone, because "visit" contains "sit"', () => {
    // Not a typo and not a bug in this port. v-i-[s-i-t]. The raw keys the app
    // actually stores hit this, and ScheduleScreen.kt's comment claiming visit_60
    // resolves to Orange is simply wrong. Pinned so nobody "fixes" it downstream.
    expect(serviceTone('visit_60')).toBe('purple');
    expect(serviceTone('visit')).toBe('purple');
    expect(serviceTone('60Minute')).toBe('orange');
  });

  it('falls back to orange for unmatched and blank keys', () => {
    expect(serviceTone('boarding')).toBe('orange');
    expect(serviceTone('')).toBe('orange');
  });
});

describe('statusLabel', () => {
  it('maps every known status', () => {
    expect(statusLabel('COMPLETED')).toBe('done');
    expect(statusLabel('ON_MY_WAY')).toBe('on the way');
    expect(statusLabel('ARRIVED')).toBe('arrived');
    expect(statusLabel('DEPARTED')).toBe('departed');
    expect(statusLabel('CANCELLED')).toBe('cancelled');
  });

  it('is case insensitive', () => {
    expect(statusLabel('completed')).toBe('done');
    expect(statusLabel('on_my_way')).toBe('on the way');
  });

  it('reads SCHEDULED, unknown, and blank all as scheduled', () => {
    // Deliberate: an unsynced session is still one the auntie must show up for.
    expect(statusLabel('SCHEDULED')).toBe('scheduled');
    expect(statusLabel('NO_SHOW')).toBe('scheduled');
    expect(statusLabel('')).toBe('scheduled');
  });
});

describe('formatTime', () => {
  it('formats morning and afternoon times', () => {
    expect(formatTime('2026-07-15T09:05:00Z')).toBe('9:05a');
    expect(formatTime('2026-07-15T17:30:00Z')).toBe('5:30p');
  });

  it('handles the two hours that break naive modulo: midnight and noon', () => {
    // 0 % 12 and 12 % 12 are both 0, and neither should render as "0:00".
    expect(formatTime('2026-07-15T00:00:00Z')).toBe('12:00a');
    expect(formatTime('2026-07-15T12:00:00Z')).toBe('12:00p');
  });

  it('puts the am/pm flip at 12, not at 13', () => {
    expect(formatTime('2026-07-15T11:59:00Z')).toBe('11:59a');
    expect(formatTime('2026-07-15T12:01:00Z')).toBe('12:01p');
    expect(formatTime('2026-07-15T13:00:00Z')).toBe('1:00p');
  });

  it('formats the last minute of the day', () => {
    expect(formatTime('2026-07-15T23:59:00Z')).toBe('11:59p');
  });

  it('accepts a bare 16-char local timestamp, the shortest input it will read', () => {
    expect(formatTime('2026-07-15T08:15')).toBe('8:15a');
  });

  it('echoes input shorter than 16 chars rather than slicing garbage', () => {
    expect(formatTime('2026-07-15')).toBe('2026-07-15');
    expect(formatTime('')).toBe('');
    expect(formatTime('2026-07-15T08:1')).toBe('2026-07-15T08:1');
  });

  it('echoes input whose hour position is not numeric', () => {
    expect(formatTime('not-a-timestamp!!')).toBe('not-a-timestamp!!');
  });

  it('passes the minute through unvalidated, exactly as the Kotlin does', () => {
    // Kotlin only ever slices the minute, so it cannot throw here and neither can
    // this. Stated as a fact about the port, not endorsed as good input handling.
    expect(formatTime('2026-07-15T08:XX:00Z')).toBe('8:XXa');
  });
});
