import { useEffect, useRef, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { durationFromPoints, formatDistance, formatDuration, projectRoute, totalDistanceMeters, type RoutePoint } from '@tribetails/geo';
import { MAPBOX_STYLE_URL, canRenderMapboxMap, createMapboxMap, mapboxToken } from '../lib/mapbox';
import { reportError } from '../lib/sentry';

const WIDTH = 400;
const HEIGHT = 180;

const SOURCE_ID = 'kincare-route';
const LINE_LAYER_ID = 'kincare-route-line';
const START_LAYER_ID = 'kincare-route-start';
const END_LAYER_ID = 'kincare-route-end';

// tokens.css's --teal / --orange / --pink, by value. Mapbox paint properties
// are read by the GL renderer, not by CSS, so a var() reference here would
// paint nothing. Keep these in step with tokens.css.
const TEAL = '#0A8595';
const ORANGE = '#DF8431';
const PINK = '#D55C87';

const FIT_OPTIONS = { padding: 32, maxZoom: 16, duration: 0 };

/**
 * GPS route replay for a KinCare visit: the route drawn over a real Mapbox
 * basemap, so a kinfolk sees the streets their Kin was walked down (#520,
 * operator ruling 2026-08-21).
 *
 * The SVG polyline this component used to be is NOT gone. It is the fallback,
 * and it is the safety story of the whole change. Three real conditions land
 * on it, and none of them shows a kinfolk an error:
 *
 *   - no VITE_MAPBOX_PUBLIC_TOKEN configured,
 *   - no DOM (SSR, or a spec running in vitest's `node` environment),
 *   - mapbox-gl failing: chunk blocked, no WebGL, style or tiles rejected
 *     before the map's first paint.
 *
 * Each of those degrades to exactly what kinfolk see today rather than to a
 * blank box, which is the failure this change exists to remove.
 *
 * `@tribetails/geo` (projectRoute, totalDistanceMeters, durationFromPoints)
 * still backs the fallback and the statistics, unchanged.
 */
export function RouteMap(props: { route: RoutePoint[]; distanceMeters?: number | undefined; durationSeconds?: number | undefined }) {
  // Unchanged: no pings, no map, no stats, no empty frame. Kept ahead of
  // RouteMapBody's hooks so an empty route mounts nothing at all.
  if (props.route.length === 0) return null;
  return <RouteMapBody {...props} />;
}

/** loading: mapbox-gl is on its way. ready: tiles are up. fallback: the SVG. */
type MapPhase = 'loading' | 'ready' | 'fallback';

function RouteMapBody(props: { route: RoutePoint[]; distanceMeters?: number | undefined; durationSeconds?: number | undefined }) {
  const { route } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  // The live view re-renders on every breadcrumb ping. The map is built once
  // and fed afterwards, so the load handler reads the route through a ref
  // rather than closing over the array it was mounted with.
  const routeRef = useRef(route);
  routeRef.current = route;
  // The route the map is currently showing. drawRoute() puts the first one on
  // at 'load'; without this the update effect below would immediately re-push
  // and re-fit the same data when `phase` flips to ready.
  const drawnRouteRef = useRef<RoutePoint[] | null>(null);

  const [phase, setPhase] = useState<MapPhase>(() => (canRenderMapboxMap() ? 'loading' : 'fallback'));

  // Map lifecycle. Deliberately mount-only: the token is inlined at build time
  // and cannot change during a session, and rebuilding the map on every ping
  // would flash and re-fetch tiles on the one screen this ruling is about.
  useEffect(() => {
    if (!canRenderMapboxMap()) return;
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let loaded = false;
    let map: MapboxMap | null = null;

    /** Any failure before the map is useful: log it, show the polyline. */
    const degrade = (err: unknown) => {
      reportError(err, 'RouteMap.mapbox');
      if (cancelled) return;
      mapRef.current = null;
      try {
        map?.remove();
      } catch {
        // Tearing down a half-built map must not become the crash.
      }
      map = null;
      setPhase('fallback');
    };

    void (async () => {
      try {
        const created = await createMapboxMap({
          container,
          style: MAPBOX_STYLE_URL,
          accessToken: mapboxToken(),
          // This map sits inside a scrolling page. Without this, a scroll over
          // it zooms the map instead of moving the page.
          cooperativeGestures: true,
          attributionControl: true,
        });
        if (cancelled) {
          created.remove();
          return;
        }
        map = created;
        mapRef.current = created;

        created.on('error', (event: { error?: unknown }) => {
          if (loaded) {
            // The map is already drawn and useful; one bad tile is not worth
            // throwing the whole basemap away.
            reportError(event?.error ?? event, 'RouteMap.mapbox.tiles');
            return;
          }
          degrade(event?.error ?? event);
        });

        created.on('load', () => {
          if (cancelled) return;
          try {
            drawRoute(created, routeRef.current);
            drawnRouteRef.current = routeRef.current;
            loaded = true;
            setPhase('ready');
          } catch (err) {
            degrade(err);
          }
        });
      } catch (err) {
        degrade(err);
      }
    })();

    return () => {
      cancelled = true;
      mapRef.current = null;
      try {
        map?.remove();
      } catch {
        // Same reason as above: unmount must not throw.
      }
    };
  }, []);

  // New pings go into the map that already exists.
  useEffect(() => {
    const map = mapRef.current;
    if (phase !== 'ready' || !map) return;
    if (drawnRouteRef.current === route) return;
    try {
      drawnRouteRef.current = route;
      const source = map.getSource(SOURCE_ID) as { setData?: (data: unknown) => void } | undefined;
      source?.setData?.(routeCollection(route));
      const bounds = routeBounds(route);
      if (bounds) map.fitBounds(bounds, FIT_OPTIONS);
    } catch (err) {
      // A ping that cannot be pushed is not worth tearing the map down for:
      // the last good route stays on screen.
      reportError(err, 'RouteMap.mapbox.update');
    }
  }, [route, phase]);

  const distance = props.distanceMeters ?? totalDistanceMeters(route);
  const duration = props.durationSeconds ?? durationFromPoints(route);

  const showFallback = phase !== 'ready';
  const points = showFallback ? projectRoute(route, WIDTH, HEIGHT) : [];
  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const start = points[0];
  const end = points.length >= 2 ? points[points.length - 1] : undefined;

  return (
    <div className="routemap">
      <div className="routemap-stage">
        {phase !== 'fallback' && (
          // Mounted while loading so mapbox-gl has a sized container to build
          // into, but kept out of the accessibility tree until it has tiles, so
          // exactly one element is ever named "Visit route map".
          <div
            ref={containerRef}
            className="routemap-map"
            data-testid="routemap-map"
            role="img"
            aria-label="Visit route map"
            aria-hidden={phase !== 'ready'}
          />
        )}
        {showFallback && (
          <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="routemap-canvas" role="img" aria-label="Visit route map">
            {points.length >= 2 && <path d={pathD} fill="none" stroke="var(--teal)" strokeWidth={2.5} />}
            {start && <circle cx={start.x} cy={start.y} r={5} fill="var(--orange)" stroke="#fff" strokeWidth={1.5} />}
            {end && <circle cx={end.x} cy={end.y} r={5} fill="var(--pink)" stroke="#fff" strokeWidth={1.5} />}
          </svg>
        )}
      </div>
      <div className="routemap-stats">
        <div className="routemap-stat">
          <span className="k">Distance</span>
          <span className="v">{formatDistance(distance)}</span>
        </div>
        <div className="routemap-stat">
          <span className="k">Duration</span>
          <span className="v">{formatDuration(duration)}</span>
        </div>
        <div className="routemap-stat">
          <span className="k">Pings</span>
          <span className="v">{route.length}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * One source for all three marks: the line, plus a start and an end point.
 * Cheaper than mapboxgl.Marker DOM pins, and one setData call updates all of
 * them when a live ping arrives.
 */
function routeCollection(route: RoutePoint[]) {
  const coordinates = route.map((p) => [p.lng, p.lat]);
  const first = coordinates[0];
  const last = coordinates.length >= 2 ? coordinates[coordinates.length - 1] : undefined;
  const features: Record<string, unknown>[] = [
    { type: 'Feature', properties: { role: 'line' }, geometry: { type: 'LineString', coordinates } },
  ];
  if (first) features.push({ type: 'Feature', properties: { role: 'start' }, geometry: { type: 'Point', coordinates: first } });
  if (last) features.push({ type: 'Feature', properties: { role: 'end' }, geometry: { type: 'Point', coordinates: last } });
  return { type: 'FeatureCollection', features };
}

/** [[west, south], [east, north]], or null for an empty route. */
function routeBounds(route: RoutePoint[]): [[number, number], [number, number]] | null {
  const first = route[0];
  if (!first) return null;
  let west = first.lng;
  let east = first.lng;
  let south = first.lat;
  let north = first.lat;
  for (const p of route) {
    if (p.lng < west) west = p.lng;
    if (p.lng > east) east = p.lng;
    if (p.lat < south) south = p.lat;
    if (p.lat > north) north = p.lat;
  }
  return [
    [west, south],
    [east, north],
  ];
}

/**
 * Route as GL layers, once the style is up. `maxZoom` in FIT_OPTIONS matters:
 * a visit's first ping is a single point, whose bounds are degenerate, and an
 * unbounded fit to that lands the camera at a zoom level with nothing on it.
 */
function drawRoute(map: MapboxMap, route: RoutePoint[]): void {
  map.addSource(SOURCE_ID, { type: 'geojson', data: routeCollection(route) });
  map.addLayer({
    id: LINE_LAYER_ID,
    type: 'line',
    source: SOURCE_ID,
    filter: ['==', ['get', 'role'], 'line'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': TEAL, 'line-width': 4 },
  });
  map.addLayer({
    id: START_LAYER_ID,
    type: 'circle',
    source: SOURCE_ID,
    filter: ['==', ['get', 'role'], 'start'],
    paint: { 'circle-radius': 6, 'circle-color': ORANGE, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 },
  });
  map.addLayer({
    id: END_LAYER_ID,
    type: 'circle',
    source: SOURCE_ID,
    filter: ['==', ['get', 'role'], 'end'],
    paint: { 'circle-radius': 6, 'circle-color': PINK, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 },
  });
  const bounds = routeBounds(route);
  if (bounds) map.fitBounds(bounds, FIT_OPTIONS);
}
