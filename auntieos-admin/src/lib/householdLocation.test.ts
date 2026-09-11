import { describe, expect, it } from 'vitest';
import { readHouseholdPoint } from './householdLocation';

/**
 * The purple house marker's coordinate (#760), read off a raw household
 * document the way Firestore hands it back.
 *
 * `kinfolk/{id}.serviceLocation` is written by the server
 * (`mytribe/functions/src/lib/householdLocation.ts`) and is absent on more
 * households than it is present on: every record whose address predates the
 * feature and every address Mapbox could not match. So "no coordinate" is the
 * ordinary case, and every one of these asserts the same thing about it, which
 * is that it produces no marker rather than a marker somewhere wrong.
 */

const GOOD = {
  serviceLocation: {
    lat: 34.2712,
    lng: -119.2264,
    geocodedFrom: '12 Alder St, Ventura CA',
    geocodedAt: '2026-08-25T10:00:00.000Z',
    provider: 'mapbox',
  },
};

describe('readHouseholdPoint', () => {
  it('reads a stored coordinate and the address it came from', () => {
    expect(readHouseholdPoint(GOOD)).toEqual({
      lat: 34.2712,
      lng: -119.2264,
      geocodedFrom: '12 Alder St, Ventura CA',
    });
  });

  it('keeps the coordinate when the provenance fields are missing', () => {
    // A record written before `geocodedFrom` existed still knows where the
    // house is, and dropping the marker over a missing audit field would hide
    // a fact the office can check with its own eyes.
    expect(readHouseholdPoint({ serviceLocation: { lat: 34.2712, lng: -119.2264 } })).toEqual({
      lat: 34.2712,
      lng: -119.2264,
      geocodedFrom: '',
    });
  });

  it.each([
    ['no document at all', undefined],
    ['a document with no serviceLocation', { serviceAddress: '12 Alder St' }],
    ['an explicit null', { serviceLocation: null }],
    ['a string where the object should be', { serviceLocation: '34.2712,-119.2264' }],
    ['a half-written point', { serviceLocation: { lat: 34.2712 } }],
    ['strings instead of numbers', { serviceLocation: { lat: '34.2712', lng: '-119.2264' } }],
    ['NaN', { serviceLocation: { lat: Number.NaN, lng: -119.2264 } }],
    ['a latitude off the globe', { serviceLocation: { lat: 134.2, lng: -119.2 } }],
    ['a longitude off the globe', { serviceLocation: { lat: 34.2, lng: -1119.2 } }],
  ])('draws no marker for %s', (_label, data) => {
    expect(readHouseholdPoint(data)).toBeNull();
  });

  /**
   * NULL ISLAND IS THE ONE THAT LOOKS VALID. `0, 0` is a real coordinate in the
   * Gulf of Guinea and it is also what a half-written document holds. A house
   * marker three thousand miles off the route would read to the office as a
   * tracking failure rather than as a missing field, and it would drag the
   * camera's bounds across an ocean with it.
   */
  it('refuses 0,0, which is a missing field wearing a valid coordinate', () => {
    expect(readHouseholdPoint({ serviceLocation: { lat: 0, lng: 0 } })).toBeNull();
  });

  it('keeps a genuine coordinate that has one zero component', () => {
    // The prime meridian and the equator are places. Only the pair is suspect.
    expect(readHouseholdPoint({ serviceLocation: { lat: 51.4779, lng: 0 } })).toMatchObject({
      lat: 51.4779,
      lng: 0,
    });
  });
});
