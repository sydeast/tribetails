import { describe, expect, it } from 'vitest';
import { clockTime, relativeAge, routeHeaderStrip } from './routeHeader';

/**
 * The strip over the Kin Care route map (#760). Driven as pure functions, so
 * the wording can be read off a failure rather than off a rendered map nothing
 * in CI can draw.
 *
 * Every instant here is written WITHOUT a trailing Z. The strip prints the
 * operator's wall clock, which is `lib/time.ts`'s AO-18 rule, so a UTC literal
 * would assert one hour on this machine and another on the CI runner.
 */

describe('clockTime', () => {
  it.each([
    ['2026-08-11T12:05:00', '12:05pm'],
    ['2026-08-11T00:07:00', '12:07am'],
    ['2026-08-11T09:01:00', '9:01am'],
    ['2026-08-11T13:09:00', '1:09pm'],
    ['2026-08-11T23:59:00', '11:59pm'],
  ])('%s -> %s', (iso, expected) => {
    expect(clockTime(iso)).toBe(expected);
  });

  // Noon and midnight are the two the 12-hour clock gets wrong, because
  // `hours % 12` is 0 for both and the hour has to read 12, not 0.
  it('reads noon as 12pm and midnight as 12am, never 0', () => {
    expect(clockTime('2026-08-11T12:00:00')).toBe('12:00pm');
    expect(clockTime('2026-08-11T00:00:00')).toBe('12:00am');
  });

  it('returns nothing for a blank or unparseable stamp, never "Invalid Date"', () => {
    expect(clockTime('')).toBe('');
    expect(clockTime(undefined)).toBe('');
    expect(clockTime('whenever')).toBe('');
  });
});

describe('relativeAge', () => {
  const NOW = new Date('2026-09-11T12:00:00');
  const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

  it.each([
    [30_000, 'just now'],
    [60_000, '1 minute ago'],
    [12 * 60_000, '12 minutes ago'],
    [60 * 60_000, '1 hour ago'],
    [5 * 60 * 60_000, '5 hours ago'],
    [26 * 60 * 60_000, '1 day ago'],
    [6 * 24 * 60 * 60_000, '6 days ago'],
    // The screenshot's own label.
    [33 * 24 * 60 * 60_000, '1 month ago'],
    [70 * 24 * 60 * 60_000, '2 months ago'],
    [400 * 24 * 60 * 60_000, '1 year ago'],
  ])('%dms back -> %s', (ms, expected) => {
    expect(relativeAge(ago(ms), NOW)).toBe(expected);
  });

  it('singularizes exactly one of a unit and pluralizes the rest', () => {
    expect(relativeAge(ago(24 * 60 * 60_000), NOW)).toBe('1 day ago');
    expect(relativeAge(ago(2 * 24 * 60 * 60_000), NOW)).toBe('2 days ago');
  });

  /**
   * A FUTURE STAMP IS NOT AN AGE. A visit that has not happened has no route to
   * draw, so a stamp ahead of now here is clock skew or a bad document, and
   * "in -3 days" is not a fact worth printing over a map.
   */
  it('says nothing about a stamp in the future', () => {
    expect(relativeAge(new Date(NOW.getTime() + 86_400_000).toISOString(), NOW)).toBe('');
  });

  it('says nothing when there is no stamp at all', () => {
    expect(relativeAge('', NOW)).toBe('');
    expect(relativeAge(undefined, NOW)).toBe('');
  });
});

describe('routeHeaderStrip', () => {
  const NOW = new Date('2026-09-11T12:00:00');

  it('writes the reference report\'s line', () => {
    const strip = routeHeaderStrip({
      arrivedAt: '2026-08-11T12:05:00',
      departedAt: '2026-08-11T13:09:00',
      distanceMeters: 200,
      durationSeconds: 3852,
      now: NOW,
    });
    expect(strip.lead).toBe('Completed in 1:04');
    expect(strip.detail).toBe('Arrived at 12:05pm - Departed at 1:09pm - 0.1 miles');
    expect(strip.age).toBe('1 month ago');
  });

  /**
   * DEPARTED IS NOT COMPLETED. The reference report writes "Completed at" over
   * what this system stores as `departedAt`, and `SessionDetail.tsx` carries
   * the ruling that the two are different events. A strip using the report's
   * word would put a second, invented completion time on a screen that already
   * prints the real one.
   */
  it('never labels the departure stamp as a completion', () => {
    const strip = routeHeaderStrip({
      arrivedAt: '2026-08-11T12:05:00',
      departedAt: '2026-08-11T13:09:00',
      now: NOW,
    });
    expect(strip.detail).toContain('Departed at 1:09pm');
    expect(strip.detail).not.toContain('Completed at');
  });

  it('measures the visit from the two stamps when no GPS summary carries a duration', () => {
    const strip = routeHeaderStrip({
      arrivedAt: '2026-08-11T12:05:00',
      departedAt: '2026-08-11T13:09:00',
      now: NOW,
    });
    // A visit can carry honest arrival and departure times with no GPS at all:
    // breadcrumbs off, or purged past the retention window. The office still
    // wants to know it ran an hour.
    expect(strip.lead).toBe('Completed in 1:04');
  });

  it('prefers a stored duration over the gap between the stamps', () => {
    // The stamps say 1:04. The summary says 30 minutes, and the summary is what
    // the tracker actually measured on the ground.
    const strip = routeHeaderStrip({
      arrivedAt: '2026-08-11T12:05:00',
      departedAt: '2026-08-11T13:09:00',
      durationSeconds: 1800,
      now: NOW,
    });
    expect(strip.lead).toBe('Completed in 0:30');
  });

  it('drops the clauses a live visit does not have yet', () => {
    const strip = routeHeaderStrip({ arrivedAt: '2026-09-11T11:30:00', distanceMeters: 200, now: NOW });
    expect(strip.lead).toBe('');
    expect(strip.detail).toBe('Arrived at 11:30am - 0.1 miles');
    expect(strip.age).toBe('30 minutes ago');
  });

  /**
   * THE LIVE-VISIT CASE, and it is not covered by the one above. RouteMap has
   * no `gpsSummary` to read on an ARRIVED visit, so it falls back to
   * `durationFromPoints(route)` and hands this function the span of the
   * breadcrumbs so far, which is a real positive number. Printing "Completed
   * in 0:07" from it would state a completion that has not happened, on the
   * screen whose own header carries the ruling that arriving, departing and
   * completing are three different events.
   */
  it('refuses to report a length for a visit with no departure stamp, however long the pings run', () => {
    const strip = routeHeaderStrip({
      arrivedAt: '2026-09-11T11:30:00',
      durationSeconds: 420,
      distanceMeters: 200,
      now: NOW,
    });
    expect(strip.lead).toBe('');
    expect(strip.detail).toBe('Arrived at 11:30am - 0.1 miles');
  });

  it('leaves every clause out rather than printing a blank one', () => {
    const strip = routeHeaderStrip({ now: NOW });
    expect(strip).toEqual({ lead: '', detail: '', age: '' });
  });

  // Zero metres is a fact, not a missing value: a visit whose Auntie stood
  // still has a distance and it is none.
  it('reports a standing-still visit as no miles rather than omitting the clause', () => {
    const strip = routeHeaderStrip({ arrivedAt: '2026-08-11T12:05:00', distanceMeters: 0, now: NOW });
    expect(strip.detail).toBe('Arrived at 12:05pm - 0 miles');
  });

  it('ages a visit from its departure, not from its arrival', () => {
    const strip = routeHeaderStrip({
      arrivedAt: '2026-08-11T12:05:00',
      departedAt: '2026-09-11T11:00:00',
      now: NOW,
    });
    expect(strip.age).toBe('1 hour ago');
  });

  it('falls back to the arrival when the visit has not been clocked out', () => {
    const strip = routeHeaderStrip({ arrivedAt: '2026-09-11T10:00:00', now: NOW });
    expect(strip.age).toBe('2 hours ago');
  });
});
