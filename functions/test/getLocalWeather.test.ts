import { describe, it, expect, vi, beforeEach } from 'vitest';

const cacheGet = vi.fn();
const cacheSet = vi.fn().mockResolvedValue(undefined);
const bizGet = vi.fn();

vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({
    doc: (path: string) => {
      if (path === 'weather_cache/current') return { get: cacheGet, set: cacheSet };
      if (path === 'business_settings/business_settings') return { get: bizGet };
      return { get: vi.fn(), set: vi.fn() };
    },
  }),
}));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

import { getLocalWeatherHandler } from '../src/admin/getLocalWeather';

/** Route a fake NWS/Mapbox response by URL. */
function fakeFetch(map: Record<string, unknown>) {
  return vi.fn(async (url: string) => {
    const key = Object.keys(map).find((k) => url.includes(k));
    if (!key) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => map[key] };
  });
}

const POINTS = {
  properties: {
    relativeLocation: { properties: { city: 'New York', state: 'NY' } },
    forecast: 'https://api.weather.gov/FORECAST',
    forecastHourly: 'https://api.weather.gov/HOURLY',
  },
};
const FORECAST = { properties: { periods: [{ temperature: 84, temperatureUnit: 'F', shortForecast: 'Sunny', isDaytime: true }] } };
const HOURLY = { properties: { periods: [{ relativeHumidity: { value: 55 } }] } };
const ALERTS = { features: [{ properties: { event: 'Heat Advisory', severity: 'Moderate', headline: 'Heat through evening' } }] };

beforeEach(() => {
  cacheGet.mockReset();
  cacheSet.mockClear();
  bizGet.mockReset();
  process.env.MAPBOX_ACCESS_TOKEN = 'tok';
});

describe('getLocalWeatherHandler', () => {
  it('rejects an unauthenticated caller', async () => {
    await expect(getLocalWeatherHandler({ auth: undefined, data: {} } as never)).rejects.toThrow();
  });

  it('fails loud (no fake data) when the business address is blank', async () => {
    cacheGet.mockResolvedValue({ exists: false });
    bizGet.mockResolvedValue({ data: () => ({ weatherLocation: '   ' }) });
    await expect(
      getLocalWeatherHandler({ auth: { uid: 'a' }, data: {} } as never),
    ).rejects.toThrow(/weather_location_not_set/);
  });

  it('returns the fresh cache without geocoding or calling NWS', async () => {
    const observedAtMs = Date.now() - 1000;
    const payload = { ok: true, city: 'Tampa', state: 'FL', tempF: 90, humidityPct: 60, shortForecast: 'Hot', isDaytime: true, alerts: [], source: 'NWS', cached: false };
    cacheGet.mockResolvedValue({ exists: true, data: () => ({ geoAddress: 'Tampa, FL', observedAtMs, lat: 1, lon: 2, payload }) });
    bizGet.mockResolvedValue({ data: () => ({ weatherLocation: 'Tampa, FL' }) });
    const fetchMock = fakeFetch({});
    vi.stubGlobal('fetch', fetchMock);

    const res = await getLocalWeatherHandler({ auth: { uid: 'a' }, data: {} } as never);

    expect(res.cached).toBe(true);
    expect(res.city).toBe('Tampa');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('geocodes + fetches NWS and shapes raw conditions + alerts, then caches', async () => {
    cacheGet.mockResolvedValue({ exists: false });
    bizGet.mockResolvedValue({ data: () => ({ weatherLocation: 'Austin, TX' }) });
    const fetchMock = fakeFetch({
      'api.mapbox.com': { features: [{ geometry: { coordinates: [-74.006, 40.7128] } }] },
      '/points/': POINTS,
      '/FORECAST': FORECAST,
      '/HOURLY': HOURLY,
      '/alerts/active': ALERTS,
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await getLocalWeatherHandler({ auth: { uid: 'a' }, data: {} } as never);

    expect(res.ok).toBe(true);
    expect(res.city).toBe('New York');
    expect(res.state).toBe('NY');
    expect(res.tempF).toBe(84);
    expect(res.humidityPct).toBe(55);
    expect(res.shortForecast).toBe('Sunny');
    expect(res.alerts).toEqual([{ event: 'Heat Advisory', severity: 'Moderate', headline: 'Heat through evening' }]);
    expect(res.cached).toBe(false);
    expect(cacheSet).toHaveBeenCalledOnce();
    const cached = cacheSet.mock.calls[0][0] as Record<string, unknown>;
    expect(cached.geoAddress).toBe('Austin, TX');
    expect(cached.lat).toBeCloseTo(40.7128);
  });

  it('still returns temperature when the alerts endpoint fails', async () => {
    cacheGet.mockResolvedValue({ exists: false });
    bizGet.mockResolvedValue({ data: () => ({ weatherLocation: 'Austin, TX' }) });
    // No '/alerts/active' key → that fetch 404s and is swallowed.
    const fetchMock = fakeFetch({
      'api.mapbox.com': { features: [{ geometry: { coordinates: [-74, 40.7] } }] },
      '/points/': POINTS,
      '/FORECAST': FORECAST,
      '/HOURLY': HOURLY,
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await getLocalWeatherHandler({ auth: { uid: 'a' }, data: {} } as never);
    expect(res.tempF).toBe(84);
    expect(res.alerts).toEqual([]);
  });
});
