import { describe, it, expect } from 'vitest';
import { durationFromPoints } from '@tribetails/geo';
import { normalizeBreadcrumb, orderBreadcrumbs, routePointsFromGpsSummary } from './breadcrumbs';

/**
 * The GPS read's normalizers.
 *
 * THE TWO-SHAPE CASE IS THE POINT OF THIS FILE. Android's `LocationPoint`
 * writes `latitude` / `longitude` / `timestamp: Long`; the older wasm web client
 * wrote `lat` / `lng` / `timestamp: String`. The portal's own reader handles
 * only the second, so a route recorded on a phone comes back empty there. Both
 * shapes are on live documents, so a reader that took either one alone would be
 * blank on half the visits in the book.
 */

describe('normalizeBreadcrumb accepts both writers', () => {
  it('reads the Android shape: latitude/longitude and epoch millis', () => {
    expect(
      normalizeBreadcrumb({ latitude: 30.2672, longitude: -97.7431, timestamp: 1_770_000_000_000 }),
    ).toEqual({ lat: 30.2672, lng: -97.7431, t: 1_770_000_000_000 });
  });

  it('reads the legacy web shape: lat/lng and an ISO string', () => {
    expect(normalizeBreadcrumb({ lat: 30.1, lng: -97.7, timestamp: '2026-08-24T14:00:00Z' })).toEqual({
      lat: 30.1,
      lng: -97.7,
      t: Date.parse('2026-08-24T14:00:00Z'),
    });
  });

  it('drops a document with no usable coordinate pair rather than plotting 0,0', () => {
    expect(normalizeBreadcrumb({})).toBeNull();
    expect(normalizeBreadcrumb({ lat: 30.1 })).toBeNull();
    expect(normalizeBreadcrumb({ latitude: '30.1', longitude: '-97.7' })).toBeNull();
    expect(normalizeBreadcrumb({ lat: Number.NaN, lng: -97.7 })).toBeNull();
  });

  // A real location with an unreadable clock is still a real location, and the
  // map does not draw the clock. Dropping it would put a hole in the polyline.
  it('keeps a point whose timestamp is missing or unparseable, without a t', () => {
    expect(normalizeBreadcrumb({ lat: 30.1, lng: -97.7 })).toEqual({ lat: 30.1, lng: -97.7 });
    expect(normalizeBreadcrumb({ lat: 30.1, lng: -97.7, timestamp: 'soon' })).toEqual({
      lat: 30.1,
      lng: -97.7,
    });
  });

  it('is not fooled by a zero coordinate, which is a real place', () => {
    expect(normalizeBreadcrumb({ lat: 0, lng: 0, timestamp: 5 })).toEqual({ lat: 0, lng: 0, t: 5 });
  });
});

describe('orderBreadcrumbs', () => {
  // Firestore orders a mixed-type field by type GROUP first, so a server
  // orderBy('timestamp') would put every Android ping before every web one
  // whatever the clock said. Sorting on the normalized value is the fix.
  it('interleaves the two writers by real time, not by stored type', () => {
    const points = [
      normalizeBreadcrumb({ lat: 1, lng: 1, timestamp: '2026-08-24T14:00:10Z' })!,
      normalizeBreadcrumb({ latitude: 2, longitude: 2, timestamp: Date.parse('2026-08-24T14:00:05Z') })!,
      normalizeBreadcrumb({ latitude: 3, longitude: 3, timestamp: Date.parse('2026-08-24T14:00:15Z') })!,
    ];
    expect(orderBreadcrumbs(points).map((p) => p.lat)).toEqual([2, 1, 3]);
  });

  it('does not mutate its input', () => {
    const input = [
      { lat: 1, lng: 1, t: 20 },
      { lat: 2, lng: 2, t: 10 },
    ];
    orderBreadcrumbs(input);
    expect(input.map((p) => p.t)).toEqual([20, 10]);
  });
});

describe('routePointsFromGpsSummary', () => {
  // The durable copy is what survives `purgeOldVisitRoutes`, so a completed
  // visit's only route is usually this one.
  /**
   * CHANGED BY #610, deliberately: this used to assert the two points came back
   * SORTED, pinning a re-order this function no longer does. A summary's `route`
   * is written in walked order by both writers, so the stored order is the
   * answer and sorting on a partial clock could only corrupt it. The points are
   * returned as stored.
   */
  it('reads the {lat,lng,t} points the summary stores, in stored order', () => {
    expect(
      routePointsFromGpsSummary({
        distanceMeters: 1200,
        route: [
          { lat: 30.2, lng: -97.7, t: 20 },
          { lat: 30.3, lng: -97.8, t: 10 },
        ],
      }),
    ).toEqual([
      { lat: 30.2, lng: -97.7, t: 20 },
      { lat: 30.3, lng: -97.8, t: 10 },
    ]);
  });

  it('returns an empty route for anything that is not one, rather than throwing', () => {
    expect(routePointsFromGpsSummary(undefined)).toEqual([]);
    expect(routePointsFromGpsSummary(null)).toEqual([]);
    expect(routePointsFromGpsSummary({})).toEqual([]);
    expect(routePointsFromGpsSummary({ route: 'nope' })).toEqual([]);
    expect(routePointsFromGpsSummary({ route: [null, 3, 'x'] })).toEqual([]);
  });

  it('skips a malformed point instead of dropping the whole route', () => {
    expect(
      routePointsFromGpsSummary({ route: [{ lat: 30.2, lng: -97.7 }, { lat: 30.3 }] }),
    ).toEqual([{ lat: 30.2, lng: -97.7 }]);
  });
});

/**
 * ISSUE #610: `t: 0` is Android's documented UNKNOWN sentinel on a summary
 * point (`GpsPoint`, `LocationModels.kt`: "Epoch millis. 0 if unknown"), not a
 * timestamp in 1970. Two normalizers read this field and only one of them knew
 * that, which is what this file now pins.
 */
describe('routePointsFromGpsSummary and the zero sentinel', () => {
  it('drops t === 0 rather than reading it as 1970', () => {
    const points = routePointsFromGpsSummary({
      route: [
        { lat: 30.1, lng: -97.7, t: 0 },
        { lat: 30.2, lng: -97.8, t: 1_787_580_600_000 },
      ],
    });
    expect(points).toEqual([
      { lat: 30.1, lng: -97.7 },
      { lat: 30.2, lng: -97.8, t: 1_787_580_600_000 },
    ]);
  });
  /**
   * The visible harm, and the reason the sentinel matters here rather than
   * being a tidiness point. `RouteMap` falls back to `durationFromPoints(route)`
   * when the stored `durationSeconds` is absent, and that reads the FIRST and
   * LAST point's `t`. A zero at either end spans from 1970 to the real ping:
   * about 56 years, rendered as a five-figure hour count on an operator's
   * screen.
   */
  it('does not turn an unknown clock into a fifty-six-year visit', () => {
    const points = routePointsFromGpsSummary({
      route: [
        { lat: 30.1, lng: -97.7, t: 0 },
        { lat: 30.2, lng: -97.8, t: 1_787_580_600_000 },
      ],
    });
    expect(durationFromPoints(points)).toBe(0);
  });
  /**
   * A summary's points arrive in the order they were walked: both writers build
   * `route` by mapping over an already-ordered list
   * (`LocationTrackingService#downsamplePoints`, and the desktop's `downsample`),
   * and Android's own composer renders `gpsSummary.route` as-is. Sorting here
   * was not preserving that order, it was overriding it -- and sorting on
   * `t ?? 0` put every unknown-clock point at the FRONT, which moved the start
   * of the drawn polyline.
   */
  it('preserves the stored order instead of sorting on a partial clock', () => {
    const points = routePointsFromGpsSummary({
      route: [
        { lat: 1, lng: 1, t: 300 },
        { lat: 2, lng: 2, t: 0 },
        { lat: 3, lng: 3, t: 100 },
      ],
    });
    expect(points.map((p) => p.lat)).toEqual([1, 2, 3]);
  });
  it('is not fooled by a real coordinate of zero', () => {
    expect(routePointsFromGpsSummary({ route: [{ lat: 0, lng: 0, t: 5 }] })).toEqual([
      { lat: 0, lng: 0, t: 5 },
    ]);
  });
});
