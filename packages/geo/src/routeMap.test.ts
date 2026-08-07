import { describe, expect, it } from 'vitest';
import { durationFromPoints, formatDistance, formatDuration, projectRoute, totalDistanceMeters } from './routeMap';

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
