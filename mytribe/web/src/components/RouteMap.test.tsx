// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import type { RoutePoint } from '@tribetails/geo';
import { RouteMap } from './RouteMap';

/**
 * RouteMap's contract after #520: a real Mapbox basemap when a token is
 * configured, and the SVG polyline on every path where it is not. Never a
 * blank frame, never an error.
 *
 * mapbox-gl is mocked outright. Nothing here may touch the network: a spec
 * that reached api.mapbox.com would be billing the operator's token to run
 * CI, and would fail on a runner with no egress.
 */

const TOKEN = 'pk.test-token-not-a-real-credential';

const ROUTE: RoutePoint[] = [
  { lat: 34.2746, lng: -119.2290, t: 1_700_000_000_000 },
  { lat: 34.2760, lng: -119.2305, t: 1_700_000_180_000 },
  { lat: 34.2781, lng: -119.2331, t: 1_700_000_420_000 },
];

interface FakeSource {
  type: string;
  data: unknown;
  setData: (data: unknown) => void;
}

/** Records what RouteMap asked the SDK to do, and lets a spec fire its events. */
class FakeMap {
  static instances: FakeMap[] = [];
  static throwOnConstruct: Error | null = null;

  readonly options: Record<string, unknown>;
  readonly handlers = new Map<string, (event?: unknown) => void>();
  readonly sources = new Map<string, FakeSource>();
  readonly layers: Record<string, unknown>[] = [];
  readonly fitBoundsCalls: { bounds: unknown; options: unknown }[] = [];
  removed = false;

  constructor(options: Record<string, unknown>) {
    if (FakeMap.throwOnConstruct) throw FakeMap.throwOnConstruct;
    this.options = options;
    FakeMap.instances.push(this);
  }

  on(type: string, handler: (event?: unknown) => void): void {
    this.handlers.set(type, handler);
  }

  addSource(id: string, source: { type: string; data: unknown }): void {
    this.sources.set(id, { ...source, setData: vi.fn() });
  }

  getSource(id: string): FakeSource | undefined {
    return this.sources.get(id);
  }

  addLayer(layer: Record<string, unknown>): void {
    this.layers.push(layer);
  }

  fitBounds(bounds: unknown, options: unknown): void {
    this.fitBoundsCalls.push({ bounds, options });
  }

  remove(): void {
    this.removed = true;
  }

  /** Fire a map event the way the SDK would, inside act() so state settles. */
  fire(type: string, event?: unknown): void {
    act(() => {
      this.handlers.get(type)?.(event);
    });
  }
}

vi.mock('mapbox-gl', () => ({ Map: FakeMap, default: { Map: FakeMap } }));
// The lazy chunk carries the SDK's stylesheet; Vitest's CSS handling is not
// something this spec should depend on either way.
vi.mock('mapbox-gl/dist/mapbox-gl.css', () => ({}));
vi.mock('../lib/sentry', () => ({ reportError: vi.fn() }));

const { reportError } = await import('../lib/sentry');

function fallbackSvg(container: HTMLElement): SVGSVGElement | null {
  return container.querySelector('svg.routemap-canvas');
}

function mapContainer(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-testid="routemap-map"]');
}

/** Renders and waits for the map to exist and finish loading. */
async function renderLoaded(route: RoutePoint[] = ROUTE) {
  const view = render(<RouteMap route={route} />);
  await waitFor(() => expect(FakeMap.instances).toHaveLength(1));
  const map = FakeMap.instances[0]!;
  map.fire('load');
  await waitFor(() => expect(mapContainer(view.container)?.getAttribute('aria-hidden')).toBe('false'));
  return { ...view, map };
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  FakeMap.instances = [];
  FakeMap.throwOnConstruct = null;
  // Any tile request would go through fetch. Assert it never happens rather
  // than trusting the mock to be complete.
  fetchSpy = vi.fn(() => Promise.reject(new Error('no network in tests')));
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('RouteMap without a token', () => {
  beforeEach(() => vi.stubEnv('VITE_MAPBOX_PUBLIC_TOKEN', ''));

  it('draws the SVG polyline and never loads mapbox-gl at all', async () => {
    const { container } = render(<RouteMap route={ROUTE} />);

    const svg = fallbackSvg(container);
    expect(svg).not.toBeNull();
    expect(svg?.querySelector('path')?.getAttribute('d')).toMatch(/^M[\d.]+,[\d.]+ L/);
    expect(mapContainer(container)).toBeNull();

    // Give a stray dynamic import a turn of the loop to happen. It must not.
    await act(async () => {
      await Promise.resolve();
    });
    expect(FakeMap.instances).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still shows the distance, duration and ping statistics', () => {
    const { getByText } = render(<RouteMap route={ROUTE} distanceMeters={1200} durationSeconds={420} />);
    expect(getByText('Pings')).toBeInTheDocument();
    expect(getByText('3')).toBeInTheDocument();
  });

  it('renders nothing at all for an empty route', () => {
    const { container } = render(<RouteMap route={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('RouteMap with a token', () => {
  beforeEach(() => vi.stubEnv('VITE_MAPBOX_PUBLIC_TOKEN', TOKEN));

  it('builds a Mapbox map with the configured token, into the mounted container', async () => {
    const { container } = render(<RouteMap route={ROUTE} />);

    await waitFor(() => expect(FakeMap.instances).toHaveLength(1));
    const map = FakeMap.instances[0]!;
    expect(map.options['accessToken']).toBe(TOKEN);
    expect(map.options['style']).toBe('mapbox://styles/mapbox/streets-v12');
    expect(map.options['container']).toBe(mapContainer(container));
  });

  it('keeps the polyline on screen until the tiles are actually up', async () => {
    const { container } = render(<RouteMap route={ROUTE} />);
    await waitFor(() => expect(FakeMap.instances).toHaveLength(1));

    // Map constructed, style not loaded: a kinfolk still sees a route, and
    // the empty map frame is out of the accessibility tree.
    expect(fallbackSvg(container)).not.toBeNull();
    expect(mapContainer(container)?.getAttribute('aria-hidden')).toBe('true');
  });

  it('draws the route as a GeoJSON LineString with start and end markers, and fits the camera to it', async () => {
    const { container, map } = await renderLoaded();

    expect(fallbackSvg(container)).toBeNull();

    const source = map.getSource('kincare-route');
    expect(source?.type).toBe('geojson');
    const features = (source?.data as { features: { properties: { role: string }; geometry: { type: string; coordinates: unknown } }[] }).features;
    const line = features.find((f) => f.properties.role === 'line');
    expect(line?.geometry.type).toBe('LineString');
    // GeoJSON order is [lng, lat], and getting that backwards puts the route
    // in the Indian Ocean.
    expect(line?.geometry.coordinates).toEqual([
      [-119.229, 34.2746],
      [-119.2305, 34.276],
      [-119.2331, 34.2781],
    ]);
    expect(features.find((f) => f.properties.role === 'start')?.geometry.coordinates).toEqual([-119.229, 34.2746]);
    expect(features.find((f) => f.properties.role === 'end')?.geometry.coordinates).toEqual([-119.2331, 34.2781]);

    expect(map.layers.map((l) => l['id'])).toEqual(['kincare-route-line', 'kincare-route-start', 'kincare-route-end']);
    expect(map.layers[0]?.['type']).toBe('line');

    expect(map.fitBoundsCalls).toHaveLength(1);
    expect(map.fitBoundsCalls[0]?.bounds).toEqual([
      [-119.2331, 34.2746],
      [-119.229, 34.2781],
    ]);
    // maxZoom is what keeps a one-ping visit from fitting to a degenerate box.
    expect(map.fitBoundsCalls[0]?.options).toMatchObject({ maxZoom: 16, padding: 32 });
  });

  it('never fetches a tile: no request leaves this spec', async () => {
    await renderLoaded();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('feeds new live pings into the existing map instead of rebuilding it', async () => {
    const { rerender, map } = await renderLoaded();

    const grown = [...ROUTE, { lat: 34.2801, lng: -119.2360, t: 1_700_000_600_000 }];
    rerender(<RouteMap route={grown} />);

    await waitFor(() => expect(map.getSource('kincare-route')?.setData).toHaveBeenCalledTimes(1));
    // One map for the whole visit. Rebuilding it per breadcrumb would flash
    // and re-fetch tiles on the live screen this change exists for.
    expect(FakeMap.instances).toHaveLength(1);
    expect(map.removed).toBe(false);

    const pushed = vi.mocked(map.getSource('kincare-route')!.setData).mock.calls[0]?.[0] as {
      features: { properties: { role: string }; geometry: { coordinates: number[][] } }[];
    };
    expect(pushed.features.find((f) => f.properties.role === 'line')?.geometry.coordinates).toHaveLength(4);
    expect(map.fitBoundsCalls).toHaveLength(2);
  });
});

describe('RouteMap when the map fails', () => {
  beforeEach(() => vi.stubEnv('VITE_MAPBOX_PUBLIC_TOKEN', TOKEN));

  it('degrades to the polyline when mapbox-gl throws (no WebGL, blocked chunk)', async () => {
    FakeMap.throwOnConstruct = new Error('Failed to initialize WebGL');

    const { container } = render(<RouteMap route={ROUTE} />);

    await waitFor(() => expect(mapContainer(container)).toBeNull());
    expect(fallbackSvg(container)).not.toBeNull();
    expect(fallbackSvg(container)?.querySelector('path')).not.toBeNull();
    // Logged for us, never surfaced to a kinfolk.
    expect(reportError).toHaveBeenCalledWith(FakeMap.throwOnConstruct, 'RouteMap.mapbox');
    expect(container.textContent).not.toMatch(/error|failed|unavailable/i);
  });

  it('degrades to the polyline when the style or tiles fail before the first paint', async () => {
    const { container } = render(<RouteMap route={ROUTE} />);
    await waitFor(() => expect(FakeMap.instances).toHaveLength(1));
    const map = FakeMap.instances[0]!;

    const failure = new Error('Unauthorized: invalid access token');
    map.fire('error', { error: failure });

    await waitFor(() => expect(mapContainer(container)).toBeNull());
    expect(fallbackSvg(container)).not.toBeNull();
    expect(map.removed).toBe(true);
    expect(reportError).toHaveBeenCalledWith(failure, 'RouteMap.mapbox');
  });

  it('keeps a loaded map when a single tile fails afterwards', async () => {
    const { container, map } = await renderLoaded();

    map.fire('error', { error: new Error('one tile 503') });

    expect(map.removed).toBe(false);
    expect(mapContainer(container)).not.toBeNull();
    expect(fallbackSvg(container)).toBeNull();
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), 'RouteMap.mapbox.tiles');
  });

  it('tears the map down on unmount so a live view does not leak GL contexts', async () => {
    const { unmount, map } = await renderLoaded();
    unmount();
    expect(map.removed).toBe(true);
  });
});
