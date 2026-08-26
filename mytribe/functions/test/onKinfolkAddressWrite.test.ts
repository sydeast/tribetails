import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), logEventFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));

import { onKinfolkAddressWriteHandler } from '../src/triggers/onKinfolkAddressWrite';
import { planHouseholdGeocode } from '../src/lib/householdLocation';

/**
 * ISSUE #582: the trigger that keeps a household's coordinate in step with its
 * address.
 *
 * The behaviour worth pinning is that this trigger writes back to the document
 * that fires it. Every branch has to reach a state the next fire skips, and the
 * failure branch is the one that would otherwise spend a Mapbox call per
 * iteration forever.
 */

function event(after: Record<string, unknown> | undefined) {
  return {
    params: { kinfolkId: 'kf1' },
    data: { after: after === undefined ? undefined : { data: () => after } },
  };
}

function geocoderReturning(coords: [number, number]) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ features: [{ geometry: { coordinates: coords } }] }),
  }));
}

describe('onKinfolkAddressWrite', () => {
  beforeEach(() => {
    mocks.dbFn.mockReset();
    mocks.logEventFn.mockReset();
    process.env.MAPBOX_ACCESS_TOKEN = 'tok';
  });
  afterEach(() => vi.unstubAllGlobals());

  it('geocodes a new address and stores the coordinate with its provenance', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    vi.stubGlobal('fetch', geocoderReturning([-118.24, 34.05]));

    await onKinfolkAddressWriteHandler(event({ serviceAddress: '12 Oak St' }));

    const write = ctx.writes.find((w) => w.path === 'kinfolk/kf1');
    expect(write?.merge).toBe(true);
    expect(write?.data.serviceLocation).toMatchObject({
      lat: 34.05,
      lng: -118.24,
      geocodedFrom: '12 Oak St',
      provider: 'mapbox',
    });
    // A success clears any previous failure record.
    expect(write?.data.serviceLocationError).toBeNull();
  });

  /**
   * THE LOOP GUARD, success side. The write above lands on the same document
   * and fires this trigger again; that pass must not call Mapbox.
   */
  it('does nothing on the fire caused by its own successful write', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await onKinfolkAddressWriteHandler(
      event({
        serviceAddress: '12 Oak St',
        serviceLocation: { lat: 34.05, lng: -118.24, geocodedFrom: '12 Oak St', geocodedAt: 'T' },
      }),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ctx.writes).toHaveLength(0);
  });

  it('records a failure rather than throwing, so a bad address never blocks anything', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ features: [] }) })));

    await onKinfolkAddressWriteHandler(event({ serviceAddress: 'not a place' }));

    const write = ctx.writes.find((w) => w.path === 'kinfolk/kf1');
    expect(write?.data.serviceLocationError).toMatchObject({
      address: 'not a place',
      reason: 'no_match',
    });
    expect(write?.data.serviceLocation).toBeUndefined();
  });

  /**
   * THE LOOP GUARD, FAILURE side — the expensive one. The error record carries
   * a fresh `at` on every write, so a guard that only checked for a missing
   * coordinate would retrigger, call Mapbox, fail, write, and spin.
   */
  it('does not call Mapbox again on the fire caused by its own failure write', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await onKinfolkAddressWriteHandler(
      event({
        serviceAddress: 'not a place',
        serviceLocationError: { address: 'not a place', reason: 'no_match', at: 'T' },
      }),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ctx.writes).toHaveLength(0);
  });

  it('re-geocodes when the address is edited under a stored coordinate', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    vi.stubGlobal('fetch', geocoderReturning([-118.3, 34.09]));

    await onKinfolkAddressWriteHandler(
      event({
        serviceAddress: '14 Oak St',
        serviceLocation: { lat: 34.05, lng: -118.24, geocodedFrom: '12 Oak St', geocodedAt: 'T' },
      }),
    );

    const write = ctx.writes.find((w) => w.path === 'kinfolk/kf1');
    expect(write?.data.serviceLocation).toMatchObject({ geocodedFrom: '14 Oak St', lat: 34.09 });
  });

  /** A coordinate for an address the record no longer carries is stale evidence. */
  it('clears the coordinate when the address is removed, and settles on the next fire', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await onKinfolkAddressWriteHandler(
      event({
        serviceLocation: { lat: 34.05, lng: -118.24, geocodedFrom: '12 Oak St', geocodedAt: 'T' },
      }),
    );

    expect(ctx.writes[0]?.data).toEqual({ serviceLocation: null, serviceLocationError: null });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(planHouseholdGeocode({})).toMatchObject({ action: 'skip' });
  });

  it('ignores a deleted household and a test-data one', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await onKinfolkAddressWriteHandler(event(undefined));
    await onKinfolkAddressWriteHandler(event({ serviceAddress: '12 Oak St', isTestData: true }));

    expect(ctx.writes).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('records the failure without leaking the address into the log line', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    vi.stubGlobal('fetch', geocoderReturning([-118.24, 34.05]));

    await onKinfolkAddressWriteHandler(event({ serviceAddress: '12 Oak St' }));

    const logged = JSON.stringify(mocks.logEventFn.mock.calls);
    expect(logged).toContain('household.geocode.stored');
    expect(logged).not.toContain('12 Oak St');
    expect(logged).not.toContain('34.05');
  });
});
