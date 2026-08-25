import {
  durationFromPoints,
  formatDistance,
  formatDuration,
  projectRoute,
  totalDistanceMeters,
  type RoutePoint,
} from '@tribetails/geo';
import './RouteMap.css';

const WIDTH = 400;
const HEIGHT = 180;

export interface RouteMapProps {
  route: RoutePoint[];
  /** Draws the live indicator on the last point. True only while ARRIVED. */
  live?: boolean;
  /** From `gpsSummary` when it has one; otherwise computed from the points. */
  distanceMeters?: number | undefined;
  durationSeconds?: number | undefined;
}

/**
 * The visit route, drawn as a projected polyline with distance / duration /
 * ping counts beneath it.
 *
 * NO BASEMAP, AND THAT IS PARITY RATHER THAN A SHORTCUT. The Android reference
 * for this surface, `ui/components/RouteMap.kt`, is a plain Compose `Canvas`
 * polyline over a flat panel -- no Mapbox, no tiles -- and it is what Auntie
 * Time's in-flight card and the operator's live-tracking screen both draw. The
 * portal's `RouteMap.tsx` does mount a real Mapbox map, and it can, because
 * `mytribe/web` carries `mapbox-gl` and a `VITE_MAPBOX_PUBLIC_TOKEN`; this app
 * carries neither. Its ONLY Mapbox reach is `api/mapbox.ts`, which proxies
 * address search through a callable precisely so "the browser NEVER holds a
 * Mapbox key". Adding a basemap here is a token decision and a dependency
 * decision, not a drawing decision, so it is not smuggled in under a parity
 * ticket. The projection maths is the shared `@tribetails/geo` both other
 * renderers already use, so a basemap can be added later without redrawing
 * anything.
 *
 * An empty route renders NOTHING, deliberately: the caller owns the empty copy,
 * because "waiting for the first ping" and "no route was ever recorded" are
 * different sentences and only the caller knows which visit it is looking at.
 * The same split Android's `RouteMap(points, live)` makes with its `live` flag.
 */
export function RouteMap({ route, live = false, distanceMeters, durationSeconds }: RouteMapProps) {
  if (route.length === 0) return null;

  const points = projectRoute(route, WIDTH, HEIGHT);
  const pathD = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(' ');
  const start = points[0];
  const end = points.length >= 2 ? points[points.length - 1] : undefined;
  const head = points[points.length - 1];

  const distance = distanceMeters ?? totalDistanceMeters(route);
  const duration = durationSeconds ?? durationFromPoints(route);

  return (
    <div className="routemap">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="routemap__canvas"
        role="img"
        aria-label={live ? 'Live visit route' : 'Visit route'}
      >
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
