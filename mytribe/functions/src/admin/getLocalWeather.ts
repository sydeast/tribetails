import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';

/**
 * A8 / Home widgets W16 (Weather Watchdog) + W17 (Heat Stroke Index): one thin server
 * fetch of the local forecast for the operator's service area. Uses the US National
 * Weather Service API (api.weather.gov), KEYLESS + free, so there is no external
 * secret to defer on; US-only, which fits TribeTails (America/New_York). NWS requires
 * a descriptive User-Agent and does not do browser CORS, so the call lives here.
 *
 * Returns RAW conditions (temp, humidity, forecast, active alerts). The dog-specific
 * risk maths (paw-burn level, canine heat index) live in tested client helpers so
 * web + android derive identical levels, this function never fabricates a risk verdict.
 *
 * Location: geocode business_settings.weatherLocation, a service-AREA place name (city
 * / metro / ZIP), NOT a street address, so the operator never exposes their home/business
 * address. Cached alongside the forecast so we re-geocode only when it changes. Fail-loud:
 * a blank location or a geocode/NWS failure returns an error the widget shows verbatim.
 */

const MAPBOX_ACCESS_TOKEN = 'MAPBOX_ACCESS_TOKEN';
const CACHE_DOC = 'weather_cache/current';
const CACHE_TTL_MS = 30 * 60 * 1000; // NWS forecasts refresh hourly; 30 min is plenty.
// NWS asks every client to identify itself with a contact. App id + operator email;
// this is a courtesy contact string, not a credential.
const NWS_USER_AGENT = 'AuntieOS/1.0 (neesdees@gmail.com)';

export interface WeatherAlert {
  event: string;
  severity: string;
  headline: string;
}

export interface LocalWeatherResult {
  ok: true;
  city: string;
  state: string;
  tempF: number | null;
  humidityPct: number | null;
  shortForecast: string;
  isDaytime: boolean;
  alerts: WeatherAlert[];
  observedAtMs: number;
  source: 'NWS';
  cached: boolean;
}

async function fetchJson(url: string): Promise<any> {
  const resp = await fetch(url, { headers: { 'User-Agent': NWS_USER_AGENT, Accept: 'application/geo+json' } });
  if (!resp.ok) throw new HttpsError('unavailable', `nws_${resp.status}`);
  return resp.json();
}

/** Mapbox v6 forward geocode → [lon, lat]. Throws failed-precondition on no match. */
async function geocodeAddress(address: string, token: string): Promise<{ lat: number; lon: number }> {
  const params = new URLSearchParams({ q: address, limit: '1', country: 'us', access_token: token });
  const resp = await fetch(`https://api.mapbox.com/search/geocode/v6/forward?${params}`);
  if (!resp.ok) throw new HttpsError('unavailable', `mapbox_${resp.status}`);
  const body: any = await resp.json();
  const coords = body?.features?.[0]?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) {
    throw new HttpsError('failed-precondition', 'geocode_failed');
  }
  return { lon: Number(coords[0]), lat: Number(coords[1]) };
}

export async function getLocalWeatherHandler(
  req: CallableRequest<unknown>,
): Promise<LocalWeatherResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const nowMs = Date.now();
  const cacheRef = db().doc(CACHE_DOC);
  const cacheSnap = await cacheRef.get();
  const cache = cacheSnap.exists ? (cacheSnap.data() as any) : null;

  // The forecast location is a service-AREA place name (city / metro / ZIP), NOT a
  // street address, the operator should never have to expose their home/business
  // address to get weather. For a metro the centre point is representative: temp +
  // humidity are metro-uniform for paw-burn / heat-index, and NWS heat advisories are
  // issued metro-wide, so the centre captures the dog-relevant alerts.
  const bizSnap = await db().doc('business_settings/business_settings').get();
  const location = String((bizSnap.data() as any)?.weatherLocation ?? '').trim();
  if (!location) throw new HttpsError('failed-precondition', 'weather_location_not_set');

  // Fresh cache for the same location → return as-is (no geocode, no NWS).
  if (cache && cache.geoAddress === location && typeof cache.observedAtMs === 'number'
      && nowMs - cache.observedAtMs < CACHE_TTL_MS) {
    return { ...(cache.payload as LocalWeatherResult), cached: true, observedAtMs: cache.observedAtMs };
  }

  // Reuse cached coordinates when the location is unchanged; else geocode.
  let lat: number;
  let lon: number;
  if (cache && cache.geoAddress === location && typeof cache.lat === 'number' && typeof cache.lon === 'number') {
    lat = cache.lat;
    lon = cache.lon;
  } else {
    const token = (process.env.MAPBOX_ACCESS_TOKEN ?? '').trim();
    if (!token) throw new HttpsError('failed-precondition', 'mapbox_not_configured');
    const geo = await geocodeAddress(location, token);
    lat = geo.lat;
    lon = geo.lon;
  }

  // NWS: points → forecast + hourly (humidity) + active alerts.
  const points = await fetchJson(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`);
  const props = points?.properties ?? {};
  const rel = props?.relativeLocation?.properties ?? {};
  const forecastUrl: string = props?.forecast ?? '';
  const hourlyUrl: string = props?.forecastHourly ?? '';
  if (!forecastUrl) throw new HttpsError('unavailable', 'nws_no_forecast_url');

  const forecast = await fetchJson(forecastUrl);
  const period = forecast?.properties?.periods?.[0] ?? {};
  const tempF: number | null = typeof period.temperature === 'number' ? period.temperature : null;

  let humidityPct: number | null = null;
  if (hourlyUrl) {
    try {
      const hourly = await fetchJson(hourlyUrl);
      const h = hourly?.properties?.periods?.[0] ?? {};
      const rh = h?.relativeHumidity?.value;
      if (typeof rh === 'number') humidityPct = Math.round(rh);
    } catch {
      humidityPct = null; // hourly is a bonus; don't fail the whole widget for it
    }
  }

  const alerts: WeatherAlert[] = [];
  try {
    const al = await fetchJson(`https://api.weather.gov/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`);
    for (const f of al?.features ?? []) {
      const p = f?.properties ?? {};
      if (p.event) alerts.push({ event: String(p.event), severity: String(p.severity ?? ''), headline: String(p.headline ?? '') });
    }
  } catch {
    // alerts are best-effort; an outage there shouldn't blank the temperature.
  }

  const payload: LocalWeatherResult = {
    ok: true,
    city: String(rel.city ?? ''),
    state: String(rel.state ?? ''),
    tempF,
    humidityPct,
    shortForecast: String(period.shortForecast ?? ''),
    isDaytime: Boolean(period.isDaytime),
    alerts,
    observedAtMs: nowMs,
    source: 'NWS',
    cached: false,
  };

  await cacheRef.set({ geoAddress: location, lat, lon, observedAtMs: nowMs, payload, updatedBy: uid }, { merge: true });

  logEvent({
    severity: 'info',
    function: 'getLocalWeather',
    event: 'weather.fetched',
    uid,
    extra: { city: payload.city, state: payload.state, tempF, alerts: alerts.length },
  });

  return payload;
}

export const getLocalWeather = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', MAPBOX_ACCESS_TOKEN] },
  wrapAdminCallable('getLocalWeather', getLocalWeatherHandler),
);
