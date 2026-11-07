import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  classifyVisitWindow,
  rescheduleIntoPastRefusal,
  timingOf,
  RESCHEDULE_IN_PAST_MESSAGE,
  VISIT_UNDERWAY_MESSAGE,
} from './pastVisit';

const NOW = Date.parse('2026-11-06T18:00:00.000Z');
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

describe('classifyVisitWindow (#1574)', () => {
  it('names the three windows the server names', () => {
    expect(classifyVisitWindow(NOW + HOUR, NOW + 2 * HOUR, NOW)).toBe('ahead');
    expect(classifyVisitWindow(NOW - 2 * HOUR, NOW - HOUR, NOW)).toBe('ended');
    expect(classifyVisitWindow(NOW - HOUR, NOW + HOUR, NOW)).toBe('underway');
  });

  it('a start exactly at now is ahead, an end exactly at now has ended', () => {
    expect(classifyVisitWindow(NOW, NOW + HOUR, NOW)).toBe('ahead');
    expect(classifyVisitWindow(NOW - HOUR, NOW, NOW)).toBe('ended');
  });

  it('reads the ISO pair a create sends', () => {
    expect(timingOf({ startTime: iso(NOW - 2 * HOUR), endTime: iso(NOW - HOUR) }, NOW)).toBe('ended');
  });
});

describe('rescheduleIntoPastRefusal (#1574)', () => {
  it('refuses a start that has passed, with the server sentence', () => {
    expect(rescheduleIntoPastRefusal(iso(NOW - 1), NOW)).toBe(RESCHEDULE_IN_PAST_MESSAGE);
  });

  it('lets a start still ahead through, and leaves an unreadable one to the caller', () => {
    expect(rescheduleIntoPastRefusal(iso(NOW), NOW)).toBeNull();
    expect(rescheduleIntoPastRefusal('not a time', NOW)).toBeNull();
  });
});

/**
 * The client shows these sentences before sending; the server sends them when
 * it refuses. They must be the same words, so this reads the server's file.
 */
describe('the sentences match the server (#1574)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const server = readFileSync(resolve(here, '../../../mytribe/functions/src/lib/pastVisit.ts'), 'utf8');
  const flat = server.replace(/\s*\n\s*/g, ' ');

  it.each([
    ['RESCHEDULE_IN_PAST_MESSAGE', RESCHEDULE_IN_PAST_MESSAGE],
    ['VISIT_UNDERWAY_MESSAGE', VISIT_UNDERWAY_MESSAGE],
  ])('%s', (_name, sentence) => {
    expect(flat).toContain(`'${sentence}'`);
  });
});
