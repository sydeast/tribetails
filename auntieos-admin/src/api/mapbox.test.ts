import { describe, it, expect, vi, beforeEach } from 'vitest';

const { callMock } = vi.hoisted(() => ({ callMock: vi.fn() }));
vi.mock('../lib/fns', () => ({ call: callMock }));

import { mapboxSuggest, mapboxRetrieve, newMapboxSessionToken } from './mapbox';

beforeEach(() => {
  callMock.mockReset();
});

describe('newMapboxSessionToken', () => {
  it('is 32 lowercase hex characters (the Search Box session shape)', () => {
    expect(newMapboxSessionToken()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('gives a different token each call, so a rotation is observable', () => {
    const tokens = new Set(Array.from({ length: 20 }, () => newMapboxSessionToken()));
    expect(tokens.size).toBe(20);
  });
});

describe('mapboxSuggest', () => {
  it('calls the mapboxSearch callable with the query and the session token', async () => {
    callMock.mockResolvedValue({ suggestions: [], signedBy: 'mapboxSearch' });
    await mapboxSuggest('123 Mill', 'a'.repeat(32));
    expect(callMock).toHaveBeenCalledWith('mapboxSearch', {
      query: '123 Mill',
      sessionToken: 'a'.repeat(32),
      limit: 5,
      country: 'us',
    });
  });

  it('maps the wire shape to camelCase suggestions', async () => {
    callMock.mockResolvedValue({
      suggestions: [
        { name: 'Mill House', full_address: '1 Mill St, Austin TX', mapbox_id: 'id-1', place_formatted: 'Austin TX' },
      ],
      signedBy: 'mapboxSearch',
    });
    const out = await mapboxSuggest('mill', 'b'.repeat(32));
    expect(out).toEqual([
      { name: 'Mill House', fullAddress: '1 Mill St, Austin TX', mapboxId: 'id-1', placeFormatted: 'Austin TX' },
    ]);
  });

  it('tolerates a response with no suggestions array rather than throwing', async () => {
    callMock.mockResolvedValue({ signedBy: 'mapboxSearch' });
    await expect(mapboxSuggest('mill', 'c'.repeat(32))).resolves.toEqual([]);
  });

  it('lets a callable failure propagate, so the caller can fail loud', async () => {
    callMock.mockRejectedValue(new Error('mapbox_502'));
    await expect(mapboxSuggest('mill', 'd'.repeat(32))).rejects.toThrow('mapbox_502');
  });
});

describe('mapboxRetrieve', () => {
  it('calls the mapboxRetrieve callable with the SAME session token', async () => {
    callMock.mockResolvedValue({ feature: { properties: { full_address: '1 Mill St' } }, signedBy: 'mapboxRetrieve' });
    await mapboxRetrieve('id-1', 'e'.repeat(32));
    expect(callMock).toHaveBeenCalledWith('mapboxRetrieve', {
      mapboxId: 'id-1',
      sessionToken: 'e'.repeat(32),
    });
  });

  it('reads the resolved address out of the GeoJSON feature properties', async () => {
    callMock.mockResolvedValue({
      feature: {
        properties: { name: 'Mill House', full_address: '1 Mill St, Austin TX 78701', place_formatted: 'Austin TX' },
      },
      signedBy: 'mapboxRetrieve',
    });
    await expect(mapboxRetrieve('id-1', 'f'.repeat(32))).resolves.toBe('1 Mill St, Austin TX 78701');
  });

  it('falls back to the feature name when full_address is blank', async () => {
    callMock.mockResolvedValue({ feature: { properties: { name: 'Mill House', full_address: '' } } });
    await expect(mapboxRetrieve('id-1', 'f'.repeat(32))).resolves.toBe('Mill House');
  });

  /**
   * A null feature is a Mapbox id we cannot resolve. Returning '' would blank the
   * operator's typed address, so this throws and the field keeps what they typed.
   */
  it('throws on a null feature instead of resolving to an empty address', async () => {
    callMock.mockResolvedValue({ feature: null, signedBy: 'mapboxRetrieve' });
    await expect(mapboxRetrieve('id-1', 'f'.repeat(32))).rejects.toThrow(/no address/i);
  });

  it('throws when the feature carries neither a full address nor a name', async () => {
    callMock.mockResolvedValue({ feature: { properties: {} } });
    await expect(mapboxRetrieve('id-1', 'f'.repeat(32))).rejects.toThrow(/no address/i);
  });
});
