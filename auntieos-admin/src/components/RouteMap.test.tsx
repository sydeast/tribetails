// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { RoutePoint } from '@tribetails/geo';
import { RouteMap, routeBounds, routeCollection } from './RouteMap';

/**
 * RouteMap's contract after #760: a Mapbox SATELLITE basemap when a token is
 * configured, with four marks on it, and the SVG polyline on every path where
 * it is not. Never a blank panel, never an error shown to the office.
 *
 * mapbox-gl is mocked outright, the way the portal's own RouteMap.test.tsx does
 * it. Nothing here may touch the network: a spec that reached api.mapbox.com
 * would be billing the operator's token to run CI, and would fail on a runner
 * with no egress.
 */

const TOKEN = 'pk.test-token-not-a-real-credential';

const ROUTE: RoutePoint[] = [
  { lat: 34.2746, lng: -119.229, t: 1_700_000_000_000 },
  { lat: 34.276, lng: -119.2305, t: 1_700_000_180_000 },
  { lat: 34.2781, lng: -119.2331, t: 1_700_000_420_000 },
];

const HOUSE = { lat: 34.2712, lng: -119.2264, geocodedFrom: '12 Alder St' };

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
  readonly controls: { control: unknown; position: unknown }[] = [];
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

  addControl(control: unknown, position?: unknown): void {
    this.controls.push({ control, position });
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

/** The zoom control, so a spec can prove one was attached and how. */
class FakeNavigationControl {
  constructor(readonly options: Record<string, unknown>) {}
}

vi.mock('mapbox-gl', () => ({
  Map: FakeMap,
  NavigationControl: FakeNavigationControl,
  default: { Map: FakeMap, NavigationControl: FakeNavigationControl },
}));
// The lazy chunk carries the SDK's stylesheet; Vitest's CSS handling is not
// something this spec should depend on either way.
vi.mock('mapbox-gl/dist/mapbox-gl.css', () => ({}));
vi.mock('../lib/sentry', () => ({ reportError: vi.fn() }));

const { reportError } = await import('../lib/sentry');

function fallbackSvg(container: HTMLElement): SVGSVGElement | null {
  return container.querySelector('svg.routemap__canvas');
}

function mapContainer(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-testid="routemap-map"]');
}

function layerIds(map: FakeMap): unknown[] {
  return map.layers.map((l) => l['id']);
}

function featuresOf(source: FakeSource | undefined) {
  return (source?.data as { features: { properties: { role: string }; geometry: { type: string; coordinates: number[] | number[][] } }[] })
    .features;
}

/** Renders and waits for the map to exist and finish loading. */
async function renderLoaded(element: ReactElement) {
  const view = render(element);
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

  /**
   * THE PANEL NEVER GOES BLANK, and the strip is part of that. An admin with no
   * token still gets the visit's length, its two clock times and its distance;
   * those are facts about the visit, not decoration on a basemap.
   */
  it('still writes the header strip over the fallback', () => {
    const { getByText } = render(
      <RouteMap
        route={ROUTE}
        arrivedAt="2026-08-11T12:05:00"
        departedAt="2026-08-11T13:09:00"
        distanceMeters={200}
        durationSeconds={3852}
      />,
    );
    expect(getByText('Completed in 1:04')).toBeInTheDocument();
    expect(getByText('Arrived at 12:05pm - Departed at 1:09pm - 0.1 miles')).toBeInTheDocument();
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

  it('builds a SATELLITE map with the configured token, into the mounted container', async () => {
    const { container } = render(<RouteMap route={ROUTE} />);

    await waitFor(() => expect(FakeMap.instances).toHaveLength(1));
    const map = FakeMap.instances[0]!;
    expect(map.options['accessToken']).toBe(TOKEN);
    // Satellite, not the portal's streets: the office is checking whether the
    // Auntie was at the house, and a roof answers that where a street label
    // does not (operator ruling 2026-09-11).
    expect(map.options['style']).toBe('mapbox://styles/mapbox/satellite-streets-v12');
    expect(map.options['container']).toBe(mapContainer(container));
    // Mapbox and OpenStreetMap credit. Required by the tile terms, not optional.
    expect(map.options['attributionControl']).toBe(true);
  });

  it('attaches a zoom control, with no compass on a map that never rotates', async () => {
    const { map } = await renderLoaded(<RouteMap route={ROUTE} />);
    expect(map.controls).toHaveLength(1);
    expect(map.controls[0]?.control).toBeInstanceOf(FakeNavigationControl);
    expect((map.controls[0]?.control as FakeNavigationControl).options).toEqual({ showCompass: false });
    expect(map.controls[0]?.position).toBe('top-right');
  });

  it('keeps the polyline on screen until the tiles are actually up', async () => {
    const { container } = render(<RouteMap route={ROUTE} />);
    await waitFor(() => expect(FakeMap.instances).toHaveLength(1));

    // Map constructed, style not loaded: the office still sees a route, and
    // the empty map frame is out of the accessibility tree.
    expect(fallbackSvg(container)).not.toBeNull();
    expect(mapContainer(container)?.getAttribute('aria-hidden')).toBe('true');
  });

  it('draws the trail, the arrival and the departure, and fits the camera to them', async () => {
    const { container, map } = await renderLoaded(<RouteMap route={ROUTE} />);

    expect(fallbackSvg(container)).toBeNull();

    const source = map.getSource('kincare-route');
    expect(source?.type).toBe('geojson');
    const features = featuresOf(source);
    const line = features.find((f) => f.properties.role === 'line');
    expect(line?.geometry.type).toBe('LineString');
    // GeoJSON order is [lng, lat], and getting that backwards puts the route
    // in the Indian Ocean.
    expect(line?.geometry.coordinates).toEqual([
      [-119.229, 34.2746],
      [-119.2305, 34.276],
      [-119.2331, 34.2781],
    ]);
    expect(features.find((f) => f.properties.role === 'arrival')?.geometry.coordinates).toEqual([-119.229, 34.2746]);
    expect(features.find((f) => f.properties.role === 'departure')?.geometry.coordinates).toEqual([-119.2331, 34.2781]);

    expect(layerIds(map)).toEqual([
      'kincare-route-line',
      'kincare-route-house',
      'kincare-route-arrival',
      'kincare-route-departure',
    ]);
    expect(map.layers[0]?.['type']).toBe('line');

    expect(map.fitBoundsCalls).toHaveLength(1);
    expect(map.fitBoundsCalls[0]?.bounds).toEqual([
      [-119.2331, 34.2746],
      [-119.229, 34.2781],
    ]);
    // maxZoom is what keeps a one-ping visit from fitting to a degenerate box.
    expect(map.fitBoundsCalls[0]?.options).toMatchObject({ maxZoom: 17, padding: 32 });
  });

  it('paints the four marks in the reference report colours', async () => {
    const { map } = await renderLoaded(<RouteMap route={ROUTE} house={HOUSE} />);
    const paintOf = (id: string) =>
      map.layers.find((l) => l['id'] === id)?.['paint'] as Record<string, unknown> | undefined;

    expect(paintOf('kincare-route-line')?.['line-color']).toBe('#4C9AFF');
    expect(paintOf('kincare-route-arrival')?.['circle-color']).toBe('#3CB371');
    expect(paintOf('kincare-route-departure')?.['circle-color']).toBe('#D5535A');
    expect(paintOf('kincare-route-house')?.['circle-color']).toBe('#74538A');
  });

  it('marks the household and widens the camera to keep it in frame', async () => {
    const { map } = await renderLoaded(<RouteMap route={ROUTE} house={HOUSE} />);

    const house = featuresOf(map.getSource('kincare-route')).find((f) => f.properties.role === 'house');
    expect(house?.geometry.coordinates).toEqual([-119.2264, 34.2712]);
    // The house is south-east of every ping, so both of those corners move to
    // it. A camera fitted to the trail alone would crop out the one comparison
    // this panel is read for.
    expect(map.fitBoundsCalls[0]?.bounds).toEqual([
      [-119.2331, 34.2712],
      [-119.2264, 34.2781],
    ]);
  });

  it('draws no house marker when the household has no stored coordinate', async () => {
    const { map } = await renderLoaded(<RouteMap route={ROUTE} house={null} />);
    const roles = featuresOf(map.getSource('kincare-route')).map((f) => f.properties.role);
    expect(roles).not.toContain('house');
    // The LAYER is still declared. It filters to nothing, which is what lets a
    // coordinate that resolves a moment later appear with one setData call
    // instead of a rebuilt style.
    expect(layerIds(map)).toContain('kincare-route-house');
  });

  it('never fetches a tile: no request leaves this spec', async () => {
    await renderLoaded(<RouteMap route={ROUTE} />);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('feeds new live pings into the existing map instead of rebuilding it', async () => {
    const { rerender, map } = await renderLoaded(<RouteMap route={ROUTE} />);

    const grown = [...ROUTE, { lat: 34.2801, lng: -119.236, t: 1_700_000_600_000 }];
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

  // The household document is a separate subscription and can settle after the
  // map has already been built. The marker must appear without a rebuild.
  it('adds the house marker when the household coordinate resolves after the map', async () => {
    const { rerender, map } = await renderLoaded(<RouteMap route={ROUTE} house={null} />);

    rerender(<RouteMap route={ROUTE} house={HOUSE} />);

    await waitFor(() => expect(map.getSource('kincare-route')?.setData).toHaveBeenCalledTimes(1));
    const pushed = vi.mocked(map.getSource('kincare-route')!.setData).mock.calls[0]?.[0] as {
      features: { properties: { role: string } }[];
    };
    expect(pushed.features.map((f) => f.properties.role)).toContain('house');
    expect(FakeMap.instances).toHaveLength(1);
  });

  it('keeps the header strip over the basemap too', async () => {
    const { getByText } = await renderLoaded(
      <RouteMap
        route={ROUTE}
        arrivedAt="2026-08-11T09:01:00"
        departedAt="2026-08-11T09:34:00"
        distanceMeters={1610}
        durationSeconds={1980}
      />,
    );
    expect(getByText('Completed in 0:33')).toBeInTheDocument();
    expect(getByText('Arrived at 9:01am - Departed at 9:34am - 1.0 miles')).toBeInTheDocument();
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
    // Logged for us, never surfaced to the office.
    expect(reportError).toHaveBeenCalledWith(FakeMap.throwOnConstruct, 'RouteMap.mapbox');
    expect(container.textContent).not.toMatch(/error|failed|unavailable/i);
  });

  /**
   * THE URL-RESTRICTION CASE, which is the one #760's operator step exists for.
   * A token whose referrer list does not name auntie.tribetails.com is rejected
   * by the style endpoint before the first paint, and this is what the office
   * sees when that happens: the older, plainer map and no error at all.
   */
  it('degrades to the polyline when the style or tiles are refused before the first paint', async () => {
    const { container } = render(<RouteMap route={ROUTE} />);
    await waitFor(() => expect(FakeMap.instances).toHaveLength(1));
    const map = FakeMap.instances[0]!;

    const failure = new Error('Unauthorized: invalid access token');
    map.fire('error', { error: failure });

    await waitFor(() => expect(mapContainer(container)).toBeNull());
    expect(fallbackSvg(container)).not.toBeNull();
    expect(map.removed).toBe(true);
    expect(reportError).toHaveBeenCalledWith(failure, 'RouteMap.mapbox');
    expect(container.textContent).not.toMatch(/error|failed|unavailable/i);
  });

  it('keeps a loaded map when a single tile fails afterwards', async () => {
    const { container, map } = await renderLoaded(<RouteMap route={ROUTE} />);

    map.fire('error', { error: new Error('one tile 503') });

    expect(map.removed).toBe(false);
    expect(mapContainer(container)).not.toBeNull();
    expect(fallbackSvg(container)).toBeNull();
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), 'RouteMap.mapbox.tiles');
  });

  it('tears the map down on unmount so a live view does not leak GL contexts', async () => {
    const { unmount, map } = await renderLoaded(<RouteMap route={ROUTE} />);
    unmount();
    expect(map.removed).toBe(true);
  });
});

/**
 * The feature and bounds builders, driven straight rather than through a map.
 * These are the two places a coordinate can be silently transposed, and a spec
 * that only rendered would prove the renderer agreed with itself.
 */
describe('route feature building', () => {
  it('gives a one-ping route an arrival and no departure', () => {
    const roles = routeCollection([ROUTE[0]!], null).features.map(
      (f) => (f['properties'] as { role: string }).role,
    );
    // A red disc stacked on a green one would report a visit that began and
    // ended in the same instant.
    expect(roles).toEqual(['line', 'arrival']);
  });

  it('returns no bounds for an empty route, rather than a box around nowhere', () => {
    expect(routeBounds([], HOUSE)).toBeNull();
  });

  it('grows the bounds around a house that sits outside the trail', () => {
    expect(routeBounds(ROUTE, { lat: 34.30, lng: -119.20, geocodedFrom: '' })).toEqual([
      [-119.2331, 34.2746],
      [-119.2, 34.3],
    ]);
  });
});
