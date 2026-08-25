import { describe, it, expect } from 'vitest';
import {
  MAX_USEFUL_ACCURACY_METERS,
  classifyArrivalDistance,
  formatDistance,
  haversineMeters,
  isValidLatLng,
} from '../src/lib/geo';

/**
 * ISSUE #582. The arithmetic under the arrival radius, tested away from
 * Firestore, Mapbox and the callable, because the interesting behaviour is in
 * the edges: what a vague fix does, what a missing one does, and which way the
 * error bar is spent.
 */

describe('haversineMeters', () => {
  it('is zero between a point and itself', () => {
    expect(haversineMeters({ lat: 34.05, lng: -118.24 }, { lat: 34.05, lng: -118.24 })).toBe(0);
  });

  /** One minute of latitude is a nautical mile, 1852 m, everywhere on the globe. */
  it('measures a minute of latitude as a nautical mile', () => {
    const d = haversineMeters({ lat: 34, lng: -118 }, { lat: 34 + 1 / 60, lng: -118 });
    expect(d).toBeGreaterThan(1840);
    expect(d).toBeLessThan(1865);
  });

  it('measures a house-sized offset in tens of metres, not in kilometres', () => {
    // ~0.00045 degrees of latitude is about 50 m.
    const d = haversineMeters({ lat: 34.05, lng: -118.24 }, { lat: 34.05045, lng: -118.24 });
    expect(d).toBeGreaterThan(45);
    expect(d).toBeLessThan(55);
  });

  it('is symmetric', () => {
    const a = { lat: 40.7128, lng: -74.006 };
    const b = { lat: 34.0522, lng: -118.2437 };
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 6);
  });

  /** LA to New York, ~3936 km. A degree-arithmetic slip shows up here immediately. */
  it('gets a continental distance right', () => {
    const d = haversineMeters({ lat: 34.0522, lng: -118.2437 }, { lat: 40.7128, lng: -74.006 });
    expect(d / 1000).toBeGreaterThan(3900);
    expect(d / 1000).toBeLessThan(3970);
  });
});

describe('isValidLatLng', () => {
  it('accepts a real coordinate', () => {
    expect(isValidLatLng({ lat: 34.05, lng: -118.24 })).toBe(true);
  });
  it('refuses out-of-range, NaN, missing and non-numeric values', () => {
    expect(isValidLatLng({ lat: 91, lng: 0 })).toBe(false);
    expect(isValidLatLng({ lat: 0, lng: 181 })).toBe(false);
    expect(isValidLatLng({ lat: Number.NaN, lng: 0 })).toBe(false);
    expect(isValidLatLng({ lat: 0 })).toBe(false);
    expect(isValidLatLng(null)).toBe(false);
    expect(isValidLatLng({ lat: '34' as unknown as number, lng: 0 })).toBe(false);
  });
  /** 0,0 is in the Gulf of Guinea. It is a real coordinate and a common bug; the shape check is not the place to reject it. */
  it('accepts the null island rather than special-casing it here', () => {
    expect(isValidLatLng({ lat: 0, lng: 0 })).toBe(true);
  });
});

describe('classifyArrivalDistance', () => {
  const radiusMeters = 150;

  it('calls a fix inside the radius within', () => {
    expect(classifyArrivalDistance({ distanceMeters: 40, accuracyMeters: 10, radiusMeters })).toBe(
      'within',
    );
  });

  it('calls a fix confidently beyond the radius outside', () => {
    expect(classifyArrivalDistance({ distanceMeters: 2000, accuracyMeters: 15, radiusMeters })).toBe(
      'outside',
    );
  });

  /**
   * THE ANTI-STRANDING RULE, and the reason this is not a boolean. 200 m
   * measured with a 90 m error bar could be 110 m, which is inside. An Auntie
   * standing in a kitchen under a metal roof gets the benefit of the doubt.
   */
  it('does NOT refuse a reading whose error bar reaches back inside the radius', () => {
    expect(classifyArrivalDistance({ distanceMeters: 200, accuracyMeters: 90, radiusMeters })).toBe(
      'within',
    );
  });

  it('refuses once the error bar no longer reaches the radius', () => {
    expect(classifyArrivalDistance({ distanceMeters: 300, accuracyMeters: 90, radiusMeters })).toBe(
      'outside',
    );
  });

  it('treats a missing distance as unverified, never as a pass or a refusal', () => {
    expect(classifyArrivalDistance({ radiusMeters })).toBe('unverified');
    expect(classifyArrivalDistance({ distanceMeters: null, radiusMeters })).toBe('unverified');
    expect(
      classifyArrivalDistance({ distanceMeters: Number.NaN, radiusMeters }),
    ).toBe('unverified');
  });

  /**
   * A 5 km error bar subtracted from any distance passes everything. A check
   * that always says yes reads like a verification and is not one, so it is
   * recorded as no evidence instead.
   */
  it('treats a hopelessly imprecise fix as unverified rather than as a pass', () => {
    expect(
      classifyArrivalDistance({
        distanceMeters: 4000,
        accuracyMeters: MAX_USEFUL_ACCURACY_METERS + 1,
        radiusMeters,
      }),
    ).toBe('unverified');
  });

  it('still uses a fix right at the accuracy ceiling', () => {
    expect(
      classifyArrivalDistance({
        distanceMeters: 4000,
        accuracyMeters: MAX_USEFUL_ACCURACY_METERS,
        radiusMeters,
      }),
    ).toBe('outside');
  });

  it('treats an absent or nonsense accuracy as no slack rather than as infinite slack', () => {
    expect(classifyArrivalDistance({ distanceMeters: 200, radiusMeters })).toBe('outside');
    expect(classifyArrivalDistance({ distanceMeters: 200, accuracyMeters: -5, radiusMeters })).toBe(
      'outside',
    );
  });

  it('is unverified when the radius itself is not a usable number', () => {
    expect(classifyArrivalDistance({ distanceMeters: 10, radiusMeters: 0 })).toBe('unverified');
    expect(classifyArrivalDistance({ distanceMeters: 10, radiusMeters: Number.NaN })).toBe(
      'unverified',
    );
  });

  it('counts the radius boundary itself as within', () => {
    expect(classifyArrivalDistance({ distanceMeters: 150, accuracyMeters: 0, radiusMeters })).toBe(
      'within',
    );
  });
});

describe('formatDistance', () => {
  it('reads in metres below a kilometre', () => {
    expect(formatDistance(43.6)).toBe('44 m');
  });
  it('reads in kilometres above one', () => {
    expect(formatDistance(1234)).toBe('1.2 km');
  });
  it('says so rather than printing NaN', () => {
    expect(formatDistance(Number.NaN)).toBe('an unknown distance');
  });
});
