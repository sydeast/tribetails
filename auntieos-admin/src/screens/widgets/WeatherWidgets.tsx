import type { ReactNode } from 'react';
import { DenPanel, EmptyHint, ErrorHint } from '../../components/DenScreenKit';
import { useSharedOneShot } from '../../lib/useSharedOneShot';
import { getLocalWeather, type LocalWeather } from '../../api/weather';
import {
  WEATHER_RISK_LABEL,
  canineHeatRisk,
  formatTempF,
  heatIndexF,
  pawBurnRisk,
  weatherErrorText,
  type WeatherRisk,
} from '../../lib/weatherRisk';
import './widgets.css';

/**
 * W16 Weather Watchdog and W17 Heat Stroke Index, the parity ports of android
 * `HomeScreen.kt`'s two weather panels. They live in one file because they are
 * one reading rendered two ways, and keeping them together is what makes the
 * sharing below hard to undo by accident.
 *
 * ONE CALLABLE, ONE REQUEST, however many of the two cards are on the board.
 * `useSharedOneShot` keys both on `getLocalWeather`, so mounting both costs one
 * POST rather than two for a reading the server would only hand back from its
 * own 30-minute cache anyway. Retry on either card drops the shared entry, so
 * it is a genuine reload for both.
 *
 * THE VERDICTS ARE COMPUTED HERE, NOT SERVED. `getLocalWeather` returns raw
 * conditions and never an opinion; `lib/weatherRisk.ts` turns them into a level
 * using the same thresholds android uses, so the phone and the browser cannot
 * disagree about whether it is safe to walk.
 */

/** The one cache key both cards share. Changing it splits them back into two requests. */
const WEATHER_KEY = 'getLocalWeather';

export function WeatherWatchdogWidget() {
  return (
    <WeatherPanel
      title="Weather Watchdog"
      subtitle="Pavement heat and active weather alerts before you walk."
    >
      {(w) => (
        <>
          <RiskRow label="Pavement / paw risk" risk={pawBurnRisk(w.tempF)} />
          {w.alerts.length === 0 ? (
            <p className="weather__quiet">No active NWS alerts.</p>
          ) : (
            <ul className="weather__alerts">
              {/* Two, matching the phone. A card is a glance; a third alert
                  would push the temperature off the top of a compact cell. */}
              {w.alerts.slice(0, 2).map((a, i) => (
                <li key={`${a.event}-${String(i)}`} className="weather__alert">
                  <span aria-hidden="true">⚠ </span>
                  {a.event}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </WeatherPanel>
  );
}

export function HeatIndexWidget() {
  return (
    <WeatherPanel
      title="Heat Stroke Index"
      subtitle="Temperature and humidity, read as a canine heat-risk level."
    >
      {(w) => {
        const hi = heatIndexF(w.tempF, w.humidityPct);
        return (
          <>
            <div className="weather__kv">
              <span className="weather__kv-label">Feels like</span>
              <span className="weather__kv-value">{formatTempF(hi)}</span>
            </div>
            <RiskRow label="Canine heat risk" risk={canineHeatRisk(hi)} />
          </>
        );
      }}
    </WeatherPanel>
  );
}

interface WeatherPanelProps {
  title: string;
  subtitle: string;
  children: (weather: LocalWeather) => ReactNode;
}

/**
 * The shell both cards sit in: the shared load, the head row (place, forecast,
 * temperature), and the fail-loud branch.
 *
 * The error branch is deliberately NOT `AsyncRegion`. The one failure an
 * operator can act on, `weather_location_not_set`, is a setting nobody has
 * filled in rather than a fault, and it deserves a sentence naming Settings
 * instead of "Couldn't load weather / Weather unavailable while the load is
 * failing". `weatherErrorText` owns that split and passes every other failure
 * through verbatim.
 */
function WeatherPanel({ title, subtitle, children }: WeatherPanelProps) {
  const state = useSharedOneShot(WEATHER_KEY, getLocalWeather, 'getLocalWeather');

  return (
    <DenPanel title={title} subtitle={subtitle} hoverLift>
      {state.status === 'loading' && (
        <div role="status" aria-live="polite">
          <EmptyHint>Loading weather…</EmptyHint>
        </div>
      )}

      {state.status === 'error' && (
        <>
          <ErrorHint>{weatherErrorText(state.message)}</ErrorHint>
          {state.retry && (
            <button type="button" className="async-retry" onClick={state.retry}>
              Retry
            </button>
          )}
        </>
      )}

      {state.status === 'ready' && (
        <div className="dash-widget">
          <div className="weather__head">
            <span className="weather__place">
              {[state.data.city, state.data.state].filter((s) => s !== '').join(', ') || 'Local'}
            </span>
            {state.data.shortForecast !== '' && (
              <span className="weather__forecast">{state.data.shortForecast}</span>
            )}
            <span className="weather__temp">{formatTempF(state.data.tempF)}</span>
          </div>
          {children(state.data)}
        </div>
      )}
    </DenPanel>
  );
}

/** One labelled risk level as a tinted pill. Mirrors android's `WeatherRiskRow`. */
function RiskRow({ label, risk }: { label: string; risk: WeatherRisk }) {
  return (
    <div className="weather__kv">
      <span className="weather__kv-label">{label}</span>
      <span className="weather__risk" data-risk={risk}>
        {WEATHER_RISK_LABEL[risk]}
      </span>
    </div>
  );
}
