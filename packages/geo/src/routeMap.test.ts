import { describe, expect, it } from 'vitest';
import {
  durationFromPoints,
  formatClockDuration,
  formatDistance,
  formatDuration,
  formatMiles,
  projectRoute,
  totalDistanceMeters,
} from './routeMap';

describe('projectRoute', () => {
  it('empty route -> no points', () => {
    expect(projectRoute([], 200, 180)).toEqual([]);
  });

  it('single point -> falls within the padded canvas (degenerate bounding box)', () => {
    // A lone point has zero lat/lng spread, so the bounding-box fit (ported
    // verbatim from RouteMap.kt) doesn't land exactly on-center — it's
    // whatever the min(w/effDLng, h/dLat) scale pick produces. Just assert
    // it's inside the drawable area, not falling outside the canvas.
    const [p] = projectRoute([{ lat: 40, lng: -73 }], 200, 180, 16);
    expect(p!.x).toBeGreaterThanOrEqual(16);
    expect(p!.x).toBeLessThanOrEqual(184);
    expect(p!.y).toBeGreaterThanOrEqual(16);
    expect(p!.y).toBeLessThanOrEqual(164);
  });

  it('north point projects above a south point (y-axis flip)', () => {
    const points = projectRoute(
      [
        { lat: 40.0, lng: -73.0 },
        { lat: 40.001, lng: -73.0 },
      ],
      200,
      180,
    );
    expect(points[1]!.y).toBeLessThan(points[0]!.y);
  });

  it('degenerate box (zero width) -> no points', () => {
    expect(projectRoute([{ lat: 40, lng: -73 }], 10, 180, 16)).toEqual([]);
  });
});

describe('totalDistanceMeters', () => {
  it('fewer than 2 points -> 0', () => {
    expect(totalDistanceMeters([])).toBe(0);
    expect(totalDistanceMeters([{ lat: 40, lng: -73 }])).toBe(0);
  });

  it('one degree of latitude ~ 111.2km', () => {
    const d = totalDistanceMeters([
      { lat: 0, lng: 0 },
      { lat: 1, lng: 0 },
    ]);
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });
});

describe('durationFromPoints', () => {
  it('missing timestamps -> 0', () => {
    expect(durationFromPoints([{ lat: 0, lng: 0 }])).toBe(0);
  });

  it('computes seconds between first and last', () => {
    expect(
      durationFromPoints([
        { lat: 0, lng: 0, t: 1_000 },
        { lat: 0, lng: 0.01, t: 61_000 },
      ]),
    ).toBe(60);
  });
});

describe('formatDistance', () => {
  it.each([
    [0, '0 m'],
    [0.5, '0 m'],
    [42, '42 m'],
    [999, '999 m'],
    [1_000, '1 km'],
    [1_250, '1.2 km'],
    [15_040, '15 km'],
  ])('%d meters -> %s', (meters, expected) => {
    expect(formatDistance(meters)).toBe(expected);
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '—'],
    [-5, '—'],
    [45, '45s'],
    [125, '2m 5s'],
    [3_725, '1h 2m'],
  ])('%d seconds -> %s', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });
});

describe('formatClockDuration', () => {
  it.each([
    [0, ''],
    [-5, ''],
    [Number.NaN, ''],
    // Under a minute is a real visit length and reads as 0:00, not as nothing:
    // the caller asked for a clock figure and the clock says zero minutes.
    [45, '0:00'],
    [125, '0:02'],
    // The screenshot's own figure: 1:04 over a visit that ran 1h 4m 12s.
    [3_852, '1:04'],
    // Seconds are dropped, never rounded up. 1h 4m 59s is still 1:04.
    [3_899, '1:04'],
    [36_000, '10:00'],
  ])('%d seconds -> %s', (seconds, expected) => {
    expect(formatClockDuration(seconds)).toBe(expected);
  });
});

describe('formatMiles', () => {
  it.each([
    [0, '0 miles'],
    [-1, '0 miles'],
    [Number.NaN, '0 miles'],
    // The screenshot's own figure: a short in-neighbourhood walk.
    [200, '0.1 miles'],
    // Truncated, not rounded: 0.99 miles has not covered a mile.
    [1_609, '0.9 miles'],
    [1_610, '1.0 miles'],
    // 4828 m is three miles less 3 cm, and it prints as 2.9 for that reason.
    [4_828, '2.9 miles'],
    [4_830, '3.0 miles'],
  ])('%d meters -> %s', (meters, expected) => {
    expect(formatMiles(meters)).toBe(expected);
  });

  it('never reports ground that was not walked', () => {
    // 0.16 miles truncates DOWN to 0.1, where rounding would print 0.2 and
    // overstate a route by more than half its length at this scale.
    expect(formatMiles(260)).toBe('0.1 miles');
  });
});
