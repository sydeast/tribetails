import { call } from '../lib/fns';

/**
 * W16 Weather Watchdog + W17 Heat Stroke Index. One admin-gated MyTribe
 * callable, `getLocalWeather` (`mytribe/functions/src/admin/getLocalWeather.ts`),
 * already deployed and already read by android. This is the React admin's
 * missing wrapper, not a new backend.
 *
 * The callable returns RAW conditions only: temperature, humidity, the short
 * forecast, and any active National Weather Service alerts. It never decides a
 * risk verdict. The dog-safety maths live in `lib/weatherRisk.ts`, a
 * transcription of android's `WeatherRisk.kt`, so both surfaces derive the same
 * level from the same reading rather than trusting a server opinion.
 *
 * NO EXTERNAL SECRET IS OUTSTANDING. api.weather.gov is keyless, and the one
 * key involved (`MAPBOX_ACCESS_TOKEN`, used to geocode the operator's service
 * AREA once and then cached) is already configured for `optimizeRoute`, which
 * this admin has shipped since AO-35.
 */

/** One active NWS alert for the operator's area. */
export interface WeatherAlert {
  event: string;
  severity: string;
  headline: string;
}

/**
 * The `getLocalWeather` response.
 *
 * `tempF` and `humidityPct` are NULLABLE rather than defaulted, deliberately.
 * NWS's hourly endpoint is a separate fetch the server treats as a bonus, so a
 * reading can genuinely be missing; a zero there would read as a freezing day
 * and swing every risk verdict on the card. Null means "not reported", and the
 * risk helpers in `lib/weatherRisk.ts` take null and answer honestly.
 */
export interface LocalWeather {
  city: string;
  state: string;
  tempF: number | null;
  humidityPct: number | null;
  shortForecast: string;
  isDaytime: boolean;
  alerts: WeatherAlert[];
  /** When the reading was taken, epoch ms. */
  observedAtMs: number;
  /** True when the server answered from its 30-minute cache. */
  cached: boolean;
}

/** A raw alert entry, defaulted field by field so a partial one still renders. */
function readAlert(raw: unknown): WeatherAlert {
  const a = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    event: typeof a['event'] === 'string' ? a['event'] : '',
    severity: typeof a['severity'] === 'string' ? a['severity'] : '',
    headline: typeof a['headline'] === 'string' ? a['headline'] : '',
  };
}

/**
 * `getLocalWeather` (admin-gated): the current conditions for the operator's
 * configured service area.
 *
 * Throws (via `lib/fns.call`) on every failure, including the two the operator
 * can act on: `weather_location_not_set` when Settings has no service area, and
 * `geocode_failed` when the area it holds cannot be placed. Both surface
 * verbatim in the widget's error state rather than being swallowed into a blank
 * card, and `lib/weatherRisk.ts#weatherErrorText` turns the first into a
 * sentence that says what to do about it.
 *
 * A temperature that came back null stays null. Defaulting it to 0 would put
 * "OK, no paw-burn risk" on a card that measured nothing.
 */
export async function getLocalWeather(): Promise<LocalWeather> {
  const res = await call<Record<string, never>, Record<string, unknown>>('getLocalWeather', {});
  return {
    city: typeof res['city'] === 'string' ? res['city'] : '',
    state: typeof res['state'] === 'string' ? res['state'] : '',
    tempF: typeof res['tempF'] === 'number' ? res['tempF'] : null,
    humidityPct: typeof res['humidityPct'] === 'number' ? res['humidityPct'] : null,
    shortForecast: typeof res['shortForecast'] === 'string' ? res['shortForecast'] : '',
    isDaytime: res['isDaytime'] === true,
    alerts: Array.isArray(res['alerts']) ? res['alerts'].map(readAlert) : [],
    observedAtMs: typeof res['observedAtMs'] === 'number' ? res['observedAtMs'] : 0,
    cached: res['cached'] === true,
  };
}
