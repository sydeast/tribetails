import { describe, it, expect } from 'vitest';
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
  it('reads the {lat,lng,t} points the summary stores', () => {
    expect(
      routePointsFromGpsSummary({
        distanceMeters: 1200,
        route: [
          { lat: 30.2, lng: -97.7, t: 20 },
          { lat: 30.3, lng: -97.8, t: 10 },
        ],
      }),
    ).toEqual([
      { lat: 30.3, lng: -97.8, t: 10 },
      { lat: 30.2, lng: -97.7, t: 20 },
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
