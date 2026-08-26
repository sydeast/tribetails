import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import {
  geocodeHouseholdAddress,
  isServiceLocationFresh,
  pickHouseholdAddress,
  planHouseholdGeocode,
  readServiceLocation,
  resolveHouseholdLocation,
} from '../src/lib/householdLocation';

/**
 * ISSUE #582: the household coordinate — where the address comes from, when a
 * geocode is worth doing, and the loop guard, which is the part that would cost
 * real money if it were wrong.
 */

function okResponse(coords: [number, number]) {
  return {
    ok: true,
    json: async () => ({ features: [{ geometry: { coordinates: coords } }] }),
  };
}

describe('pickHouseholdAddress', () => {
  it('prefers serviceAddress, then homeAddress, then address', () => {
    expect(
      pickHouseholdAddress({ serviceAddress: 'A st', homeAddress: 'B st', address: 'C st' }),
    ).toBe('A st');
    expect(pickHouseholdAddress({ homeAddress: 'B st', address: 'C st' })).toBe('B st');
    expect(pickHouseholdAddress({ address: 'C st' })).toBe('C st');
  });

  it('skips a blank field rather than returning it', () => {
    expect(pickHouseholdAddress({ serviceAddress: '   ', homeAddress: 'B st' })).toBe('B st');
  });

  it('is empty when the household has no address at all', () => {
    expect(pickHouseholdAddress({ firstName: 'Ada' })).toBe('');
    expect(pickHouseholdAddress(undefined)).toBe('');
  });

  it('ignores a non-string address rather than coercing it', () => {
    expect(pickHouseholdAddress({ serviceAddress: 12345 })).toBe('');
  });
});

describe('readServiceLocation', () => {
  it('reads a stored coordinate with its provenance', () => {
    const loc = readServiceLocation({
      serviceLocation: { lat: 34.05, lng: -118.24, geocodedFrom: 'A st', geocodedAt: 'T' },
    });
    expect(loc).toMatchObject({ lat: 34.05, lng: -118.24, geocodedFrom: 'A st' });
  });

  it('refuses an out-of-range or half-written coordinate rather than returning a broken one', () => {
    expect(readServiceLocation({ serviceLocation: { lat: 999, lng: 0 } })).toBeNull();
    expect(readServiceLocation({ serviceLocation: { lat: 34 } })).toBeNull();
    expect(readServiceLocation({ serviceLocation: null })).toBeNull();
    expect(readServiceLocation({})).toBeNull();
  });
});

describe('isServiceLocationFresh', () => {
  const stored = {
    serviceLocation: { lat: 34, lng: -118, geocodedFrom: '12 Oak St', geocodedAt: 'T' },
  };

  it('is fresh while the address it was derived from is the address on file', () => {
    expect(isServiceLocationFresh(stored, '12 Oak St')).toBe(true);
  });

  /** A house does not move; an address changing underneath the coordinate is what invalidates it. */
  it('is stale the moment the address changes', () => {
    expect(isServiceLocationFresh(stored, '14 Oak St')).toBe(false);
  });

  it('is never fresh with no address or no coordinate', () => {
    expect(isServiceLocationFresh(stored, '')).toBe(false);
    expect(isServiceLocationFresh({}, '12 Oak St')).toBe(false);
  });
});

describe('planHouseholdGeocode', () => {
  it('geocodes a household whose address has no coordinate yet', () => {
    expect(planHouseholdGeocode({ serviceAddress: '12 Oak St' })).toEqual({
      action: 'geocode',
      address: '12 Oak St',
    });
  });

  it('geocodes again when the address changes under a stored coordinate', () => {
    expect(
      planHouseholdGeocode({
        serviceAddress: '14 Oak St',
        serviceLocation: { lat: 34, lng: -118, geocodedFrom: '12 Oak St', geocodedAt: 'T' },
      }),
    ).toEqual({ action: 'geocode', address: '14 Oak St' });
  });

  /** Loop guard, success branch: the write this trigger makes must not fire itself again. */
  it('skips a household whose coordinate already matches its address', () => {
    expect(
      planHouseholdGeocode({
        serviceAddress: '12 Oak St',
        serviceLocation: { lat: 34, lng: -118, geocodedFrom: '12 Oak St', geocodedAt: 'T' },
      }),
    ).toMatchObject({ action: 'skip', reason: 'already_geocoded' });
  });

  /**
   * Loop guard, FAILURE branch — the one that would spin. The error record
   * carries a fresh `at` on every write, so "retry whenever there is no
   * coordinate" would retrigger, call Mapbox, fail, write, retrigger, forever.
   */
  it('skips an address a previous geocode already failed on', () => {
    expect(
      planHouseholdGeocode({
        serviceAddress: '12 Oak St',
        serviceLocationError: { address: '12 Oak St', reason: 'no_match', at: 'T' },
      }),
    ).toMatchObject({ action: 'skip', reason: 'geocode_already_failed_for_this_address' });
  });

  it('retries once the address is edited to something else', () => {
    expect(
      planHouseholdGeocode({
        serviceAddress: '12 Oak Street',
        serviceLocationError: { address: '12 Oak St', reason: 'no_match', at: 'T' },
      }),
    ).toEqual({ action: 'geocode', address: '12 Oak Street' });
  });

  it('clears a coordinate whose address was removed, then settles', () => {
    const cleared = planHouseholdGeocode({
      serviceLocation: { lat: 34, lng: -118, geocodedFrom: '12 Oak St', geocodedAt: 'T' },
    });
    expect(cleared).toMatchObject({ action: 'clear' });
    // The clear write fires the trigger once more; that pass must settle.
    expect(planHouseholdGeocode({})).toMatchObject({ action: 'skip', reason: 'no_address' });
  });

  it('skips a deleted document and test-data households', () => {
    expect(planHouseholdGeocode(undefined)).toMatchObject({ action: 'skip', reason: 'deleted' });
    expect(
      planHouseholdGeocode({ serviceAddress: '12 Oak St', isTestData: true }),
    ).toMatchObject({ action: 'skip', reason: 'test_data' });
  });
});

describe('geocodeHouseholdAddress', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('turns an address into a coordinate carrying the address it came from', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse([-118.24, 34.05])));
    const out = await geocodeHouseholdAddress('12 Oak St', 'tok', () => '2026-08-25T00:00:00Z');
    expect(out).toEqual({
      ok: true,
      location: {
        lat: 34.05,
        lng: -118.24,
        geocodedFrom: '12 Oak St',
        geocodedAt: '2026-08-25T00:00:00Z',
        provider: 'mapbox',
      },
    });
  });

  it('reports no_match for an address Mapbox cannot place, rather than inventing one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ features: [] }) })));
    expect(await geocodeHouseholdAddress('nowhere', 'tok')).toEqual({ ok: false, reason: 'no_match' });
  });

  /** An outage is a different fact from a bad address, and the operator's remedy differs. */
  it('reports geocoder_unavailable when Mapbox errors, and never throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    expect(await geocodeHouseholdAddress('12 Oak St', 'tok')).toEqual({
      ok: false,
      reason: 'geocoder_unavailable',
    });
  });

  it('reports geocoder_unavailable rather than calling out with no token', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await geocodeHouseholdAddress('12 Oak St', '  ')).toEqual({
      ok: false,
      reason: 'geocoder_unavailable',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports no_address for a blank address without calling out', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await geocodeHouseholdAddress('   ', 'tok')).toEqual({ ok: false, reason: 'no_address' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('resolveHouseholdLocation', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('returns the stored coordinate without calling Mapbox when it is still fresh', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const ctx = buildDbMock({
      docs: {
        'kinfolk/kf1': {
          serviceAddress: '12 Oak St',
          serviceLocation: { lat: 34, lng: -118, geocodedFrom: '12 Oak St', geocodedAt: 'T' },
        },
      },
    });
    const out = await resolveHouseholdLocation(ctx.db as never, 'kf1', 'tok');
    expect(out).toMatchObject({ found: true, geocodedNow: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  /**
   * The lazy top-up. Every household on file when this ships has an address and
   * no coordinate, and nothing will edit those addresses to fire the trigger, so
   * the first arrival pays for the geocode and stores it.
   */
  it('geocodes and STORES a coordinate for a household that has none', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse([-118.24, 34.05])));
    const ctx = buildDbMock({ docs: { 'kinfolk/kf1': { serviceAddress: '12 Oak St' } } });
    const out = await resolveHouseholdLocation(ctx.db as never, 'kf1', 'tok');
    expect(out).toMatchObject({ found: true, geocodedNow: true });
    const write = ctx.writes.find((w) => w.path === 'kinfolk/kf1');
    expect((write?.data.serviceLocation as Record<string, unknown>).geocodedFrom).toBe('12 Oak St');
  });

  it('records the failure and reports it, rather than throwing at the caller', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ features: [] }) })));
    const ctx = buildDbMock({ docs: { 'kinfolk/kf1': { serviceAddress: 'nowhere' } } });
    expect(await resolveHouseholdLocation(ctx.db as never, 'kf1', 'tok')).toEqual({
      found: false,
      reason: 'no_match',
    });
    const write = ctx.writes.find((w) => w.path === 'kinfolk/kf1');
    expect(write?.data.serviceLocationError).toMatchObject({ address: 'nowhere', reason: 'no_match' });
  });

  it('reports no_address for a household with nothing to geocode', async () => {
    const ctx = buildDbMock({ docs: { 'kinfolk/kf1': { firstName: 'Ada' } } });
    expect(await resolveHouseholdLocation(ctx.db as never, 'kf1', 'tok')).toEqual({
      found: false,
      reason: 'no_address',
    });
  });

  it('reports no_household for a blank id or a record that is not there', async () => {
    const ctx = buildDbMock({ docs: {} });
    expect(await resolveHouseholdLocation(ctx.db as never, '', 'tok')).toEqual({
      found: false,
      reason: 'no_household',
    });
    expect(await resolveHouseholdLocation(ctx.db as never, 'missing', 'tok')).toEqual({
      found: false,
      reason: 'no_household',
    });
  });
});
