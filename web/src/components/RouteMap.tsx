import { durationFromPoints, formatDistance, formatDuration, projectRoute, totalDistanceMeters, type RoutePoint } from '../lib/routeMap';

const WIDTH = 400;
const HEIGHT = 180;

/**
 * GPS route replay: SVG polyline fit to a bounding box (see lib/routeMap.ts),
 * ported from RouteMap.kt's plain Canvas renderer — no map SDK, no token.
 */
export function RouteMap(props: { route: RoutePoint[]; distanceMeters?: number | undefined; durationSeconds?: number | undefined }) {
  const { route } = props;
  if (route.length === 0) return null;

  const points = projectRoute(route, WIDTH, HEIGHT);
  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const start = points[0];
  const end = points.length >= 2 ? points[points.length - 1] : undefined;

  const distance = props.distanceMeters ?? totalDistanceMeters(route);
  const duration = props.durationSeconds ?? durationFromPoints(route);

  return (
    <div className="routemap">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="routemap-canvas" role="img" aria-label="Visit route map">
        {points.length >= 2 && <path d={pathD} fill="none" stroke="var(--teal)" strokeWidth={2.5} />}
        {start && <circle cx={start.x} cy={start.y} r={5} fill="var(--orange)" stroke="#fff" strokeWidth={1.5} />}
        {end && <circle cx={end.x} cy={end.y} r={5} fill="var(--pink)" stroke="#fff" strokeWidth={1.5} />}
      </svg>
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
