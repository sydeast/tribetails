import { describe, it, expect } from 'vitest';
import {
  canineHeatRisk,
  formatTempF,
  heatIndexF,
  pawBurnRisk,
  weatherErrorText,
} from './weatherRisk';

/**
 * The thresholds, pinned at their boundaries. These are safety verdicts about
 * an animal, so every band edge is asserted on both sides rather than sampled
 * in the middle: an off-by-one here is the difference between "walk her" and
 * "do not".
 */

describe('pawBurnRisk', () => {
  it('holds the two boundaries android holds', () => {
    expect(pawBurnRisk(76)).toBe('ok');
    expect(pawBurnRisk(77)).toBe('caution');
    expect(pawBurnRisk(84)).toBe('caution');
    expect(pawBurnRisk(85)).toBe('high');
  });

  it('answers ok for a missing reading, which the card labels as no reading', () => {
    expect(pawBurnRisk(null)).toBe('ok');
    expect(pawBurnRisk(Number.NaN)).toBe('ok');
  });
});

describe('heatIndexF', () => {
  it('is the air temperature below the range the regression was fitted for', () => {
    expect(heatIndexF(79, 90)).toBe(79);
    expect(heatIndexF(95, 39)).toBe(95);
  });

  it('runs the Rothfusz regression inside the range', () => {
    // 90F at 70% RH is about 106F apparent, the published NWS chart value.
    expect(heatIndexF(90, 70)).toBe(106);
  });

  it('answers null with no temperature, and the air temp with no humidity', () => {
    expect(heatIndexF(null, 70)).toBeNull();
    expect(heatIndexF(88, null)).toBe(88);
  });
});

describe('canineHeatRisk', () => {
  it('holds all three boundaries', () => {
    expect(canineHeatRisk(79)).toBe('ok');
    expect(canineHeatRisk(80)).toBe('caution');
    expect(canineHeatRisk(89)).toBe('caution');
    expect(canineHeatRisk(90)).toBe('high');
    expect(canineHeatRisk(103)).toBe('high');
    expect(canineHeatRisk(104)).toBe('danger');
  });

  it('answers ok for a missing heat index', () => {
    expect(canineHeatRisk(null)).toBe('ok');
  });
});

describe('weatherErrorText', () => {
  it('turns the unset-location failure into something the operator can act on', () => {
    expect(weatherErrorText('getLocalWeather failed: weather_location_not_set')).toMatch(
      /Settings/,
    );
  });

  it('passes any other failure through verbatim rather than smoothing it over', () => {
    expect(weatherErrorText('nws_503')).toBe("Couldn't load weather: nws_503");
  });

  it('says "unknown error" rather than trailing off on a blank message', () => {
    expect(weatherErrorText('   ')).toBe("Couldn't load weather: unknown error");
  });
});

describe('formatTempF', () => {
  it('renders a reading, and says so when there is none', () => {
    expect(formatTempF(72)).toBe('72°F');
    expect(formatTempF(72.4)).toBe('72°F');
    expect(formatTempF(null)).toBe('no reading');
  });
});
