import { describe, it, expect } from 'vitest';
import { formatDuration } from '@tribetails/geo';
import { kinTaleGpsBlock, routePointsFrom } from './kinTaleGps';
import type { SessionGpsSummary } from '../api/sessions';

/**
 * The GPS block reads the session's baked `gpsSummary`. These pin the two
 * things a screen test cannot see: which summaries produce no block at all, and
 * that Android's `t: 0` sentinel never reaches the duration math as 1970.
 */

const TWO_POINTS: SessionGpsSummary = {
  distanceMeters: 1234,
  durationSeconds: 900,
  route: [
    { lat: 34.42, lng: -119.7, t: 1_755_000_000_000 },
    { lat: 34.43, lng: -119.69, t: 1_755_000_900_000 },
  ],
};

describe('kinTaleGpsBlock (what renders nothing)', () => {
  it('renders nothing when the session has no summary at all', () => {
    expect(kinTaleGpsBlock(undefined)).toBeNull();
  });

  it('renders nothing for an empty route', () => {
    expect(kinTaleGpsBlock({ route: [] })).toBeNull();
  });

  /** One ping is a location, not a route; drawing it would imply a walk. */
  it('renders nothing for a single ping', () => {
    expect(kinTaleGpsBlock({ route: [{ lat: 34.42, lng: -119.7 }] })).toBeNull();
  });

  it('renders nothing when every point is missing a coordinate', () => {
    expect(kinTaleGpsBlock({ route: [{ lat: 34.42 }, { lng: -119.7 }] })).toBeNull();
  });
});

describe('kinTaleGpsBlock (what it reports)', () => {
  it('prefers the stored distance and duration over recomputing them', () => {
    const block = kinTaleGpsBlock(TWO_POINTS);
    expect(block?.route).toHaveLength(2);
    // 1234 m formats as km; 900 s as 15m 0s. Recomputing from these two points
    // would give roughly 1.4 km, so a match here proves the stored pair won.
    expect(block?.distanceLabel).toBe('1.2 km');
    expect(block?.durationLabel).toBe('15m 0s');
  });

  it('falls back to computing from the points when the summary omits the stats', () => {
    const block = kinTaleGpsBlock({ route: TWO_POINTS.route });
    expect(block).not.toBeNull();
    expect(block?.distanceLabel).not.toBe('0 m');
    expect(block?.durationLabel).toBe('15m 0s');
  });
});

describe('routePointsFrom', () => {
  it('drops Android’s t=0 sentinel rather than reading it as 1970', () => {
    const points = routePointsFrom({
      route: [
        { lat: 1, lng: 2, t: 0 },
        { lat: 3, lng: 4, t: 0 },
      ],
    });
    expect(points).toEqual([
      { lat: 1, lng: 2 },
      { lat: 3, lng: 4 },
    ]);
    // With the sentinel dropped there is no duration to claim, so the block
    // falls through to `@tribetails/geo`'s own zero-duration placeholder rather
    // than announcing a 55-year walk. Asserted against that function so this
    // test pins the BEHAVIOUR, not the shared package's choice of glyph.
    expect(kinTaleGpsBlock({ route: [{ lat: 1, lng: 2, t: 0 }, { lat: 3, lng: 4, t: 0 }] })?.durationLabel).toBe(
      formatDuration(0),
    );
  });

  it('skips a malformed point without losing the rest of the trail', () => {
    expect(
      routePointsFrom({
        route: [{ lat: 1, lng: 2 }, { lat: Number.NaN, lng: 4 }, { lat: 5, lng: 6 }],
      }),
    ).toEqual([
      { lat: 1, lng: 2 },
      { lat: 5, lng: 6 },
    ]);
  });

  it('returns an empty list when route is absent or not an array', () => {
    expect(routePointsFrom(undefined)).toEqual([]);
    expect(routePointsFrom({})).toEqual([]);
    expect(routePointsFrom({ route: 'nope' as unknown as [] })).toEqual([]);
  });
});
