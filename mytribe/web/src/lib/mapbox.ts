import type { Map as MapboxMap, MapOptions } from 'mapbox-gl';

/**
 * Mapbox GL access for the Kinfolk portal's route map (#520, spec
 * docs/superpowers/specs/2026-08-21-kinfolk-real-map-design.md).
 *
 * Wired exactly like VITE_SENTRY_DSN (lib/sentry.ts): a VITE_-prefixed build
 * time variable read from mytribe/web/.env.local, inlined by Vite into the
 * bundle. There is no server process to inject a runtime secret into, and a
 * public `pk.*` Mapbox token is a client credential by design: read-only,
 * scoped to styles/tiles/fonts, and URL-restricted to the portal's domain.
 * Blast radius, not secrecy, is what makes it safe to ship.
 *
 * Nothing here throws or logs on a missing token. RouteMap treats "no token"
 * as an ordinary state and draws the SVG polyline it has always drawn, so a
 * kinfolk never sees a map error, only the older, plainer map.
 */

/** The style the route is drawn over: streets, so a kinfolk sees street names. */
export const MAPBOX_STYLE_URL = 'mapbox://styles/mapbox/streets-v12';

/**
 * The configured public token, or '' when none is set. Read at call time (not
 * at module load) so tests can stub the env, matching lib/sentry.ts.
 */
export function mapboxToken(): string {
  return (import.meta.env.VITE_MAPBOX_PUBLIC_TOKEN ?? '').trim();
}

/**
 * True when this environment can host a WebGL map at all: a token exists and
 * there is a real DOM. The second half covers SSR and node, including the
 * plain `node` vitest environment most specs in this app run under, where
 * mapbox-gl must never be imported.
 */
export function canRenderMapboxMap(): boolean {
  return mapboxToken() !== '' && typeof window !== 'undefined' && typeof document !== 'undefined';
}

/**
 * Construct a Map, loading mapbox-gl through a DYNAMIC import.
 *
 * The import must stay dynamic: mapbox-gl is ~800KB of JS plus its CSS, and
 * most portal screens never show a route. A static import would put all of it
 * in the initial chunk every kinfolk downloads before the schedule paints.
 * Rolldown gives it a chunk of its own, `mapbox-gl-<hash>.js` plus its
 * stylesheet, and vite.config.ts keeps both out of the service worker's
 * precache, since otherwise the worker would download on install what the
 * dynamic import exists to defer.
 *
 * Throws whatever mapbox-gl throws (no WebGL, bad container, blocked chunk).
 * The caller's catch is the fallback path.
 */
export async function createMapboxMap(options: MapOptions): Promise<MapboxMap> {
  const [{ Map }] = await Promise.all([
    import('mapbox-gl'),
    // Positioning/attribution styles for the canvas. Imported here rather than
    // at the top of a component so it rides the same lazy chunk.
    import('mapbox-gl/dist/mapbox-gl.css'),
  ]);
  return new Map(options);
}
