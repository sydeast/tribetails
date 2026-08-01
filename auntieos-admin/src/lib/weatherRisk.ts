/**
 * W16 / W17 dog-safety maths over the raw NWS conditions `getLocalWeather`
 * returns. A transcription of android's `ui/home/WeatherRisk.kt`, which is
 * itself the mirror of the Compose one: same thresholds, same regression, same
 * null handling, so a phone and a browser looking at one reading can never show
 * two different verdicts.
 *
 * The server deliberately does not decide any of this. It fetches conditions;
 * the risk level is derived here so both clients derive it identically and so
 * every threshold is unit-testable without a network.
 */

/** Four levels, worst last. Both cards render the same four. */
export type WeatherRisk = 'ok' | 'caution' | 'high' | 'danger';

/** How a level reads on the card. */
export const WEATHER_RISK_LABEL: Readonly<Record<WeatherRisk, string>> = {
  ok: 'OK',
  caution: 'Caution',
  high: 'High',
  danger: 'Danger',
};

/**
 * W16 paw-burn risk from air temperature.
 *
 * Asphalt in direct sun runs roughly 40 to 60F hotter than the air, so ~77F air
 * is about 125F underfoot (burns possible) and ~87F is about 143F (burns in
 * seconds). Read conservatively: 85F and up is High, 77F and up is Caution.
 *
 * A null temperature answers `ok` rather than throwing, matching android. The
 * card never shows a bare level: it shows the temperature beside it, and a
 * missing temperature renders as the words "no reading", so an "OK" beside it
 * cannot be mistaken for a measured all-clear.
 */
export function pawBurnRisk(tempF: number | null): WeatherRisk {
  if (tempF === null || !Number.isFinite(tempF)) return 'ok';
  if (tempF >= 85) return 'high';
  if (tempF >= 77) return 'caution';
  return 'ok';
}

/**
 * The NWS Rothfusz heat-index regression, in F against relative humidity %.
 *
 * Below about 80F or about 40% humidity the apparent temperature is the air
 * temperature, so that is what comes back rather than a regression run outside
 * the range it was fitted for. Null temperature answers null (nothing to
 * compute); null humidity answers the air temperature (the honest floor).
 */
export function heatIndexF(tempF: number | null, humidityPct: number | null): number | null {
  if (tempF === null || !Number.isFinite(tempF)) return null;
  if (humidityPct === null || !Number.isFinite(humidityPct)) return tempF;
  if (tempF < 80 || humidityPct < 40) return tempF;

  const t = tempF;
  const r = humidityPct;
  const hi =
    -42.379 +
    2.04901523 * t +
    10.14333127 * r -
    0.22475541 * t * r -
    0.00683783 * t * t -
    0.05481717 * r * r +
    0.00122874 * t * t * r +
    0.00085282 * t * r * r -
    0.00000199 * t * t * r * r;
  return Math.round(hi);
}

/**
 * W17 canine heat-stroke risk from the heat index, mapping the NWS human
 * heat-index bands read conservatively for dogs: 104 and up Danger, 90 and up
 * High, 80 and up Caution.
 */
export function canineHeatRisk(heatIndex: number | null): WeatherRisk {
  if (heatIndex === null || !Number.isFinite(heatIndex)) return 'ok';
  if (heatIndex >= 104) return 'danger';
  if (heatIndex >= 90) return 'high';
  if (heatIndex >= 80) return 'caution';
  return 'ok';
}

/**
 * The failed-weather message the card shows, in the operator's words.
 *
 * `weather_location_not_set` is not a fault, it is a setting nobody has filled
 * in, so it gets a sentence naming where to fix it instead of a raw error code.
 * Everything else is passed through verbatim: an unrecognised failure is
 * reported, never smoothed over. Android's `WeatherWidgetBody` does the same
 * with the same two branches.
 */
export function weatherErrorText(message: string): string {
  if (message.includes('weather_location_not_set')) {
    return 'Set your weather area (city, metro, or ZIP) in Settings to turn this card on.';
  }
  const trimmed = message.trim();
  return `Couldn't load weather: ${trimmed === '' ? 'unknown error' : trimmed}`;
}

/** "72°F", or a placeholder when nothing was reported. Never renders "null°F". */
export function formatTempF(tempF: number | null): string {
  return tempF === null || !Number.isFinite(tempF) ? 'no reading' : `${Math.round(tempF)}°F`;
}
