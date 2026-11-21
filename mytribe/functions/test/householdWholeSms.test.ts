import { describe, it, expect } from 'vitest';
import { SMS_BODY_MAX, householdWholeSmsParts } from '../src/notifications/templateParsers';
import { SMS_TEXT_MAX } from '../src/lib/templateChannelWording';

/**
 * #2316 (operator ruling 2026-11-20): a household with no MyTribe account is
 * texted the whole message, as several texts when one cannot carry it.
 */
describe('householdWholeSmsParts', () => {
  it('the one-text limit is the same number the template editor caps at', () => {
    expect(SMS_BODY_MAX).toBe(SMS_TEXT_MAX);
  });

  it('a message that fits is one text, as written, trimmed, with no cut and no link', () => {
    expect(householdWholeSmsParts('  Closed Monday.\nBack Tuesday.  ')).toEqual(['Closed Monday.\nBack Tuesday.']);
  });

  it('a long message is split at the end of a word, and nothing is lost', () => {
    const text = `${'word '.repeat(30)}end`;
    const parts = householdWholeSmsParts(text, 40);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(40);
    expect(parts.join(' ')).toBe(text);
    expect(parts.every((p) => !p.startsWith(' ') && !p.endsWith(' '))).toBe(true);
  });

  it('a run with no space near the limit is cut where it fits, never inside a character', () => {
    const text = `${'a'.repeat(30)}\u{1F415}${'b'.repeat(30)}`;
    const parts = householdWholeSmsParts(text, 31);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(31);
    expect(parts.join('')).toBe(text);
    expect(parts.some((p) => p.includes('\u{1F415}'))).toBe(true);
  });

  it('NEGATIVE: a blank message is no text at all', () => {
    expect(householdWholeSmsParts('   ')).toEqual([]);
  });
});
