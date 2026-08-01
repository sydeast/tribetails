// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { invalidateSharedLoad } from '../../lib/useSharedOneShot';
import type { LocalWeather } from '../../api/weather';

const { getLocalWeather } = vi.hoisted(() => ({ getLocalWeather: vi.fn() }));
vi.mock('../../api/weather', () => ({ getLocalWeather }));

import { HeatIndexWidget, WeatherWatchdogWidget } from './WeatherWidgets';

/**
 * W16 and W17. Beyond the usual three states, this suite pins the thing that
 * makes twelve new cards affordable: the two weather widgets mounted together
 * make ONE request, not two.
 */

function weather(over: Partial<LocalWeather> = {}): LocalWeather {
  return {
    city: 'Raleigh',
    state: 'NC',
    tempF: 88,
    humidityPct: 70,
    shortForecast: 'Sunny',
    isDaytime: true,
    alerts: [],
    observedAtMs: 1_700_000_000_000,
    cached: false,
    ...over,
  };
}

beforeEach(() => {
  getLocalWeather.mockReset();
  invalidateSharedLoad();
});

describe('WeatherWatchdogWidget', () => {
  it('shows the place, the reading and the paw-burn verdict', async () => {
    getLocalWeather.mockResolvedValue(weather());
    render(<WeatherWatchdogWidget />);

    expect(await screen.findByText('Raleigh, NC')).toBeInTheDocument();
    expect(screen.getByText('88°F')).toBeInTheDocument();
    expect(screen.getByText('Sunny')).toBeInTheDocument();
    // 88F air is 85 or over, so High.
    expect(screen.getByText('High')).toBeInTheDocument();
  });

  it('says the sky is quiet when there are no alerts', async () => {
    getLocalWeather.mockResolvedValue(weather());
    render(<WeatherWatchdogWidget />);
    expect(await screen.findByText('No active NWS alerts.')).toBeInTheDocument();
  });

  it('lists active alerts instead of the quiet line', async () => {
    getLocalWeather.mockResolvedValue(
      weather({
        alerts: [
          { event: 'Heat Advisory', severity: 'Moderate', headline: '' },
          { event: 'Air Quality Alert', severity: 'Minor', headline: '' },
        ],
      }),
    );
    render(<WeatherWatchdogWidget />);

    expect(await screen.findByText(/Heat Advisory/)).toBeInTheDocument();
    expect(screen.getByText(/Air Quality Alert/)).toBeInTheDocument();
    expect(screen.queryByText('No active NWS alerts.')).not.toBeInTheDocument();
  });

  it('says "no reading" rather than inventing a temperature', async () => {
    getLocalWeather.mockResolvedValue(weather({ tempF: null }));
    render(<WeatherWatchdogWidget />);
    expect(await screen.findByText('no reading')).toBeInTheDocument();
  });

  it('points the operator at Settings when no weather area is configured', async () => {
    getLocalWeather.mockRejectedValue(new Error('weather_location_not_set'));
    render(<WeatherWatchdogWidget />);

    expect(await screen.findByText(/Set your weather area/i)).toBeInTheDocument();
    // Not a raw error code, and not a silent blank card.
    expect(screen.queryByText(/weather_location_not_set/)).not.toBeInTheDocument();
  });

  it('reports any other failure verbatim, with a working Retry', async () => {
    getLocalWeather.mockRejectedValueOnce(new Error('nws_503'));
    getLocalWeather.mockResolvedValue(weather());
    render(<WeatherWatchdogWidget />);

    expect(await screen.findByText(/nws_503/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    // Retry drops the shared entry, so it reaches the callable again rather
    // than replaying the cached rejection.
    expect(await screen.findByText('Raleigh, NC')).toBeInTheDocument();
    expect(getLocalWeather).toHaveBeenCalledTimes(2);
  });
});

describe('HeatIndexWidget', () => {
  it('shows the apparent temperature and the canine risk band', async () => {
    getLocalWeather.mockResolvedValue(weather({ tempF: 90, humidityPct: 70 }));
    render(<HeatIndexWidget />);

    // 90F at 70% RH is about 106F apparent, which is Danger for a dog.
    expect(await screen.findByText('106°F')).toBeInTheDocument();
    expect(screen.getByText('Danger')).toBeInTheDocument();
  });

  it('falls back to the air temperature when humidity was not reported', async () => {
    getLocalWeather.mockResolvedValue(weather({ tempF: 85, humidityPct: null }));
    render(<HeatIndexWidget />);
    expect(await screen.findAllByText('85°F')).toHaveLength(2);
  });

  it('fails loud rather than showing a calm "OK" over an unreadable forecast', async () => {
    getLocalWeather.mockRejectedValue(new Error('nws_503'));
    render(<HeatIndexWidget />);

    expect(await screen.findByText(/nws_503/)).toBeInTheDocument();
    expect(screen.queryByText('OK')).not.toBeInTheDocument();
  });
});

describe('the two weather cards together', () => {
  it('make ONE getLocalWeather request, not one each', async () => {
    // The whole reason `lib/useSharedOneShot.ts` exists. Both cards are on the
    // board at once for anyone who adds them, and paying twice for one reading
    // is the cost this port was told not to hand-wave.
    getLocalWeather.mockResolvedValue(weather());
    render(
      <>
        <WeatherWatchdogWidget />
        <HeatIndexWidget />
      </>,
    );

    await waitFor(() => expect(screen.getAllByText('Raleigh, NC')).toHaveLength(2));
    expect(getLocalWeather).toHaveBeenCalledTimes(1);
  });

  it('both fail together on one failure, rather than one card retrying behind the other', async () => {
    getLocalWeather.mockRejectedValue(new Error('nws_503'));
    render(
      <>
        <WeatherWatchdogWidget />
        <HeatIndexWidget />
      </>,
    );

    await waitFor(() => expect(screen.getAllByText(/nws_503/)).toHaveLength(2));
    expect(getLocalWeather).toHaveBeenCalledTimes(1);
  });
});
