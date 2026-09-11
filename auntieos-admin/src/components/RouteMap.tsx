import { useEffect, useRef, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import {
  durationFromPoints,
  formatDistance,
  formatDuration,
  projectRoute,
  totalDistanceMeters,
  type RoutePoint,
} from '@tribetails/geo';
import { MAPBOX_STYLE_URL, canRenderMapboxMap, createMapboxMap, mapboxToken } from '../lib/mapbox';
import { routeHeaderStrip } from '../lib/routeHeader';
import type { HouseholdPoint } from '../lib/householdLocation';
import { reportError } from '../lib/sentry';
import './RouteMap.css';

const WIDTH = 400;
const HEIGHT = 180;

const SOURCE_ID = 'kincare-route';
const LINE_LAYER_ID = 'kincare-route-line';
const ARRIVAL_LAYER_ID = 'kincare-route-arrival';
const DEPARTURE_LAYER_ID = 'kincare-route-departure';
const HOUSE_LAYER_ID = 'kincare-route-house';

/**
 * The four marks, as literal hexes, because Mapbox paint properties are read by
 * the GL renderer and a var() reference here would paint nothing.
 *
 * These are NOT the app's surface tokens and are not meant to be. They sit on
 * aerial imagery, where the palette that reads on cream or navy does not, and
 * they are the operator's reference report's own colours: green where the
 * Auntie arrived, red where she left, purple on the house, blue for the trail
 * between them. The green matches `RouteViewerScreen.kt`'s ARRIVAL checkpoint
 * hex exactly, so one visit reads the same on the phone and on the desk. The
 * red and the purple are the brand's --tt-snuggle-coral and --tt-family-purple
 * by value; keep them in step with tokens.css.
 */
const ARRIVAL_GREEN = '#3CB371';
const DEPARTURE_RED = '#D5535A';
const HOUSE_PURPLE = '#74538A';
const TRAIL_BLUE = '#4C9AFF';

const FIT_OPTIONS = { padding: 32, maxZoom: 17, duration: 0 };

export interface RouteMapProps {
  route: RoutePoint[];
  /** Draws the live indicator on the last point. True only while ARRIVED. */
  live?: boolean;
  /** From `gpsSummary` when it has one; otherwise computed from the points. */
  distanceMeters?: number | undefined;
  durationSeconds?: number | undefined;
  /** `kin_care_sessions.arrivedAt`, for the header strip. */
  arrivedAt?: string | undefined;
  /** `kin_care_sessions.departedAt`, for the header strip. */
  departedAt?: string | undefined;
  /**
   * The household's stored coordinate, for the purple house marker. Absent
   * draws no marker: see `lib/householdLocation.ts` for why that is ordinary.
   */
  house?: HouseholdPoint | null | undefined;
}

/**
 * The visit route, drawn over a Mapbox satellite basemap, with the visit's
 * times and distance on a strip above it.
 *
 * THERE IS A BASEMAP NOW, AND THAT IS THE RULING. This header used to say the
 * opposite and to defend it: "NO BASEMAP, AND THAT IS PARITY RATHER THAN A
 * SHORTCUT", on the grounds that Android's `ui/components/RouteMap.kt` is a
 * plain Compose Canvas polyline, and that a basemap here would be a token
 * decision and a dependency decision smuggled in under a parity ticket. The
 * operator settled it on 2026-09-11 (#760) by showing the previous system's
 * visit report and saying "this is what the map looks like and is usually
 * listed under the arrival departure times": a satellite map with a green
 * arrival pin, a red departure pin, a purple marker on the house and a blue
 * breadcrumb trail. The token and dependency questions were answered with it
 * rather than dodged. `auntieos-admin` now carries `mapbox-gl` and declares
 * VITE_MAPBOX_PUBLIC_TOKEN, the Android Kin Care detail carries the same map
 * through the Mapbox SDK `RouteViewerScreen.kt` already used, and the
 * kincare-detail mock carries the panel.
 *
 * THE SVG POLYLINE IS NOT GONE. It is the fallback, and it is the safety story
 * of the whole change. Three real conditions land on it, and none of them shows
 * the office an error:
 *
 *   - no VITE_MAPBOX_PUBLIC_TOKEN configured,
 *   - no DOM (a spec running in vitest's `node` environment),
 *   - mapbox-gl failing: chunk blocked, no WebGL, style or tiles rejected
 *     before the map's first paint. A token whose URL restrictions do not name
 *     this host lands here, which is why the operator step in #760 is to add
 *     auntie.tribetails.com to them.
 *
 * Each of those degrades to exactly what the office sees today rather than to a
 * blank panel. The header strip renders in BOTH phases: the times and the
 * distance are facts about the visit, not decoration on the basemap.
 *
 * An empty route renders NOTHING, deliberately: the caller owns the empty copy,
 * because "waiting for the first ping" and "no route was ever recorded" are
 * different sentences and only the caller knows which visit it is looking at.
 * The same split Android's `RouteMap(points, live)` makes with its `live` flag.
 */
export function RouteMap(props: RouteMapProps) {
  // Kept ahead of RouteMapBody's hooks so an empty route mounts nothing at all.
  if (props.route.length === 0) return null;
  return <RouteMapBody {...props} />;
}

/** loading: mapbox-gl is on its way. ready: tiles are up. fallback: the SVG. */
type MapPhase = 'loading' | 'ready' | 'fallback';

function RouteMapBody({
  route,
  live = false,
  distanceMeters,
  durationSeconds,
  arrivedAt,
  departedAt,
  house,
}: RouteMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  // The live view re-renders on every breadcrumb ping. The map is built once
  // and fed afterwards, so the load handler reads the route through a ref
  // rather than closing over the array it was mounted with.
  const routeRef = useRef(route);
  routeRef.current = route;
  const housePoint = house ?? null;
  const houseRef = useRef(housePoint);
  houseRef.current = housePoint;
  // What the map is currently showing. drawRoute() puts the first one on at
  // 'load'; without this the update effect below would immediately re-push and
  // re-fit the same data when `phase` flips to ready.
  const drawnRef = useRef<{ route: RoutePoint[]; house: HouseholdPoint | null } | null>(null);

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
          // Mapbox and OpenStreetMap credit, bottom right. Required by the
          // terms the tiles are served under, and the reference report has it.
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
            drawRoute(created, routeRef.current, houseRef.current);
            drawnRef.current = { route: routeRef.current, house: houseRef.current };
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

  // New pings, and a household coordinate that resolved after the map was
  // built, go into the map that already exists.
  useEffect(() => {
    const map = mapRef.current;
    if (phase !== 'ready' || !map) return;
    const drawn = drawnRef.current;
    if (drawn && drawn.route === route && drawn.house === housePoint) return;
    try {
      drawnRef.current = { route, house: housePoint };
      const source = map.getSource(SOURCE_ID) as { setData?: (data: unknown) => void } | undefined;
      source?.setData?.(routeCollection(route, housePoint));
      const bounds = routeBounds(route, housePoint);
      if (bounds) map.fitBounds(bounds, FIT_OPTIONS);
    } catch (err) {
      // A ping that cannot be pushed is not worth tearing the map down for:
      // the last good route stays on screen.
      reportError(err, 'RouteMap.mapbox.update');
    }
  }, [route, housePoint, phase]);

  const distance = distanceMeters ?? totalDistanceMeters(route);
  const duration = durationSeconds ?? durationFromPoints(route);
  const header = routeHeaderStrip({
    arrivedAt,
    departedAt,
    distanceMeters: distance,
    durationSeconds: duration,
  });

  const showFallback = phase !== 'ready';
  const points = showFallback ? projectRoute(route, WIDTH, HEIGHT) : [];
  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const start = points[0];
  const end = points.length >= 2 ? points[points.length - 1] : undefined;
  const head = points[points.length - 1];
  const label = live ? 'Live visit route' : 'Visit route';
  const hasStrip = header.lead !== '' || header.detail !== '' || header.age !== '';

  return (
    <div className="routemap">
      <div className="routemap__stage">
        {hasStrip && (
          <div className="routemap__strip">
            <p className="routemap__strip-facts">
              {header.lead !== '' && <span className="routemap__strip-lead">{header.lead}</span>}
              {header.lead !== '' && header.detail !== '' && (
                <span className="routemap__strip-sep" aria-hidden="true">
                  |
                </span>
              )}
              {header.detail !== '' && <span>{header.detail}</span>}
            </p>
            {header.age !== '' && <p className="routemap__strip-age">{header.age}</p>}
          </div>
        )}
        {phase !== 'fallback' && (
          // Mounted while loading so mapbox-gl has a sized container to build
          // into, but kept out of the accessibility tree until it has tiles, so
          // exactly one element is ever named "Visit route".
          <div
            ref={containerRef}
            className="routemap__map"
            data-testid="routemap-map"
            role="img"
            aria-label={label}
            aria-hidden={phase !== 'ready'}
          />
        )}
        {showFallback && (
          <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="routemap__canvas" role="img" aria-label={label}>
            {points.length >= 2 && (
              <path
                d={pathD}
                fill="none"
                stroke="var(--color-accent)"
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
            {start && (
              <circle
                cx={start.x}
                cy={start.y}
                r={5}
                fill="var(--color-primary)"
                stroke="var(--color-surface)"
                strokeWidth={1.5}
              />
            )}
            {end && (
              <circle
                cx={end.x}
                cy={end.y}
                r={5}
                fill="var(--color-secondary)"
                stroke="var(--color-surface)"
                strokeWidth={1.5}
              />
            )}
            {/* The pulsing head Android draws while a visit is in flight. Only
                while ARRIVED: a DEPARTED route is a replay, and a pulse on it
                would say the Auntie is still moving. */}
            {live && head && (
              <circle cx={head.x} cy={head.y} r={9} className="routemap__pulse" fill="var(--color-accent)" />
            )}
          </svg>
        )}
      </div>
      <dl className="routemap__stats">
        <div className="routemap__stat">
          <dt>Distance</dt>
          <dd>{formatDistance(distance)}</dd>
        </div>
        <div className="routemap__stat">
          <dt>Duration</dt>
          <dd>{formatDuration(duration)}</dd>
        </div>
        <div className="routemap__stat">
          <dt>Pings</dt>
          <dd>{route.length}</dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * One source for all four marks: the trail, the arrival, the departure and the
 * house. Cheaper than mapboxgl.Marker DOM pins, and one setData call updates
 * every one of them when a live ping arrives.
 *
 * ARRIVAL AND DEPARTURE COME OFF THE ROUTE, not off `arrivedAt`/`departedAt`.
 * Those two fields record when somebody pressed a button; the first and last
 * breadcrumb record where the phone actually was. A pin placed from a timestamp
 * would have to guess a coordinate, and the guess is only right when GPS had
 * already settled at the moment of the press.
 *
 * A one-ping route gets an arrival and NO departure. Drawing both on one
 * coordinate would stack a red disc over a green one and report a visit that
 * began and ended in the same instant.
 */
export function routeCollection(route: RoutePoint[], house: HouseholdPoint | null) {
  const coordinates = route.map((p) => [p.lng, p.lat]);
  const first = coordinates[0];
  const last = coordinates.length >= 2 ? coordinates[coordinates.length - 1] : undefined;
  const features: Record<string, unknown>[] = [
    { type: 'Feature', properties: { role: 'line' }, geometry: { type: 'LineString', coordinates } },
  ];
  if (first) {
    features.push({ type: 'Feature', properties: { role: 'arrival' }, geometry: { type: 'Point', coordinates: first } });
  }
  if (last) {
    features.push({ type: 'Feature', properties: { role: 'departure' }, geometry: { type: 'Point', coordinates: last } });
  }
  if (house) {
    features.push({
      type: 'Feature',
      properties: { role: 'house' },
      geometry: { type: 'Point', coordinates: [house.lng, house.lat] },
    });
  }
  return { type: 'FeatureCollection', features };
}

/**
 * [[west, south], [east, north]] over the route AND the house, or null for an
 * empty route.
 *
 * The house is inside the box on purpose. How far the walk ran from the home it
 * belongs to is the thing this panel is read for, and a camera fitted to the
 * trail alone would crop the house out of frame exactly when it was furthest
 * away, which is the case worth seeing.
 */
export function routeBounds(
  route: RoutePoint[],
  house: HouseholdPoint | null = null,
): [[number, number], [number, number]] | null {
  const first = route[0];
  if (!first) return null;
  let west = first.lng;
  let east = first.lng;
  let south = first.lat;
  let north = first.lat;
  const consider = (lat: number, lng: number) => {
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  };
  for (const p of route) consider(p.lat, p.lng);
  if (house) consider(house.lat, house.lng);
  return [
    [west, south],
    [east, north],
  ];
}

/**
 * Route as GL layers, once the style is up. `maxZoom` in FIT_OPTIONS matters:
 * a visit's first ping is a single point, whose bounds are degenerate, and an
 * unbounded fit to that lands the camera at a zoom level with nothing on it.
 *
 * Layer order is drawing order: the trail first, then the house UNDER the two
 * end pins, so a household whose coordinate lands on its own driveway does not
 * cover the arrival the office came here to check.
 */
function drawRoute(map: MapboxMap, route: RoutePoint[], house: HouseholdPoint | null): void {
  map.addSource(SOURCE_ID, { type: 'geojson', data: routeCollection(route, house) });
  map.addLayer({
    id: LINE_LAYER_ID,
    type: 'line',
    source: SOURCE_ID,
    filter: ['==', ['get', 'role'], 'line'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': TRAIL_BLUE, 'line-width': 4 },
  });
  map.addLayer({
    id: HOUSE_LAYER_ID,
    type: 'circle',
    source: SOURCE_ID,
    filter: ['==', ['get', 'role'], 'house'],
    paint: {
      'circle-radius': 8,
      'circle-color': HOUSE_PURPLE,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 2,
    },
  });
  map.addLayer({
    id: ARRIVAL_LAYER_ID,
    type: 'circle',
    source: SOURCE_ID,
    filter: ['==', ['get', 'role'], 'arrival'],
    paint: {
      'circle-radius': 6,
      'circle-color': ARRIVAL_GREEN,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 2,
    },
  });
  map.addLayer({
    id: DEPARTURE_LAYER_ID,
    type: 'circle',
    source: SOURCE_ID,
    filter: ['==', ['get', 'role'], 'departure'],
    paint: {
      'circle-radius': 6,
      'circle-color': DEPARTURE_RED,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 2,
    },
  });
  const bounds = routeBounds(route, house);
  if (bounds) map.fitBounds(bounds, FIT_OPTIONS);
}
