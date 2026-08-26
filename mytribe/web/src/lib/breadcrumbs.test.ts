import { describe, it, expect } from 'vitest';
import { normalizeBreadcrumb, orderBreadcrumbs } from './breadcrumbs';

/**
 * The household's GPS read, and the reason it showed nothing.
 *
 * TWO WRITERS, TWO SHAPES. Android's `LocationPoint`
 * (`data/model/LocationModels.kt`) writes `latitude` / `longitude` /
 * `timestamp: Long`. The wasm web client, retired in #513, wrote `lat` / `lng`
 * / `timestamp: String`. This module read the second shape and ONLY the second
 * shape, so every point written by an Android Auntie came back with both
 * coordinates null and was dropped: issue #607. Since the wasm client is gone,
 * that is every point of every current visit, which is why a household watching
 * a live visit saw an empty map.
 *
 * Both shapes sit on live documents, so accepting both is the fix rather than a
 * migration. These are the same cases the admin reader pins in
 * `auntieos-admin/src/lib/breadcrumbs.test.ts`; the two normalizers are
 * deliberately kept semantically identical, and this file is what proves it.
 */

describe('normalizeBreadcrumb accepts both writers', () => {
  // The case that fails against the pre-#607 reader.
  it('reads the Android shape: latitude/longitude and epoch millis', () => {
    expect(
      normalizeBreadcrumb({ latitude: 30.2672, longitude: -97.7431, timestamp: 1_770_000_000_000 }),
    ).toEqual({ lat: 30.2672, lng: -97.7431, t: 1_770_000_000_000 });
  });

  it('still reads the legacy web shape: lat/lng and an ISO string', () => {
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
    expect(normalizeBreadcrumb({ latitude: 30.1, longitude: -97.7, timestamp: 'soon' })).toEqual({
      lat: 30.1,
      lng: -97.7,
    });
  });

  it('is not fooled by a zero coordinate, which is a real place', () => {
    expect(normalizeBreadcrumb({ lat: 0, lng: 0, timestamp: 5 })).toEqual({ lat: 0, lng: 0, t: 5 });
  });

  // No writer in the tree emits both pairs. The precedence is a tiebreak that
  // should never fire, pinned so the two readers cannot drift apart on it.
  it('prefers the short pair when a document somehow carries both', () => {
    expect(
      normalizeBreadcrumb({ lat: 1, lng: 2, latitude: 30, longitude: 40, timestamp: 7 }),
    ).toEqual({ lat: 1, lng: 2, t: 7 });
  });
});

describe('orderBreadcrumbs', () => {
  // Firestore orders a mixed-type field by type GROUP first, so a server
  // orderBy('timestamp') would put every Android ping before every web one
  // whatever the clock said. Sorting on the normalized value is the fix, and is
  // why this query still has no orderBy.
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
    expect(input.map((p) => p.lat)).toEqual([1, 2]);
  });

  // A timestampless point sorts to the front rather than being dropped, the
  // same `?? 0` this module has always used.
  it('sorts a point with no timestamp to the front', () => {
    const points = [
      { lat: 1, lng: 1, t: 10 },
      { lat: 2, lng: 2 },
    ];
    expect(orderBreadcrumbs(points).map((p) => p.lat)).toEqual([2, 1]);
  });
});
