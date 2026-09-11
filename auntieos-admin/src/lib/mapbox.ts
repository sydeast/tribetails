import type { Map as MapboxMap, MapOptions } from 'mapbox-gl';

/**
 * Mapbox GL access for the admin's Kin Care route map (#760).
 *
 * Ported from `mytribe/web/src/lib/mapbox.ts` rather than shared, and the
 * reason is in the one line that differs: the style. The portal draws a
 * kinfolk's walk over STREETS, because a household reading it wants the street
 * names their Kin was walked down. The operator's reference report for this
 * screen is SATELLITE, because what the office checks is whether the Auntie was
 * at the house, and a roof and a driveway answer that where a street label does
 * not. The rest of this file is the portal's, deliberately unchanged, so the
 * two apps fail the same way.
 *
 * The `@tribetails/geo` math IS shared, and that is where sharing pays: the
 * projection and the formatters have no opinion about basemaps.
 *
 * Wired exactly like VITE_SENTRY_DSN (lib/sentry.ts): a VITE_-prefixed build
 * time variable, inlined by Vite into the bundle. A release fills it from
 * Google Secret Manager (ADMIN_WEB_MAPBOX_PUBLIC_TOKEN, declared in
 * scripts/client-secrets.mjs) before it builds; auntieos-admin/.env.local is
 * the local fallback for a machine with no gcloud.
 *
 * THE ADMIN GETS ITS OWN SECRET NAME even though the value may be the portal's
 * token, for the same reason the two apps hold two Sentry DSNs: one name per
 * app is what lets the operator rotate or restrict one without reading the
 * other's build to find out what broke.
 *
 * A public `pk.*` Mapbox token is a client credential by design: read-only,
 * scoped to styles/tiles/fonts, and URL-restricted to the site's domain. Blast
 * radius, not secrecy, is what makes it safe to ship. This app's other Mapbox
 * reach, `api/mapbox.ts`, proxies ADDRESS SEARCH through a callable and still
 * must: that path uses a token with search scopes, which is a different token
 * and stays off the browser.
 *
 * Nothing here throws or logs on a missing token. RouteMap treats "no token" as
 * an ordinary state and draws the SVG polyline it has always drawn, so the
 * office never sees a map error, only the older, plainer map.
 */

/**
 * The style the route is drawn over: satellite with street labels on top.
 *
 * Operator ruling 2026-09-11, with the previous system's visit report as the
 * reference: "this is what the map looks like and is usually listed under the
 * arrival departure times". Satellite is what that report shows.
 */
export const MAPBOX_STYLE_URL = 'mapbox://styles/mapbox/satellite-streets-v12';

/**
 * The configured public token, or '' when none is set. Read at call time (not
 * at module load) so tests can stub the env, matching lib/sentry.ts.
 */
export function mapboxToken(): string {
  return (import.meta.env.VITE_MAPBOX_PUBLIC_TOKEN ?? '').trim();
}

/**
 * True when this environment can host a WebGL map at all: a token exists and
 * there is a real DOM. The second half covers SSR and node, including the plain
 * `node` vitest environment most specs in this app run under, where mapbox-gl
 * must never be imported.
 */
export function canRenderMapboxMap(): boolean {
  return mapboxToken() !== '' && typeof window !== 'undefined' && typeof document !== 'undefined';
}

/**
 * Construct a Map with its zoom control attached, loading mapbox-gl through a
 * DYNAMIC import.
 *
 * The import must stay dynamic: mapbox-gl is ~800KB of JS plus its CSS, and one
 * screen in this whole admin shows a route. A static import would put all of it
 * in the initial chunk the operator downloads before the dashboard paints.
 *
 * The zoom control is added here rather than by the caller because it needs the
 * same lazily-imported module object the Map came from, and reaching for a
 * second dynamic import at the call site would be a second chunk boundary for
 * one button pair.
 *
 * Throws whatever mapbox-gl throws (no WebGL, bad container, blocked chunk).
 * The caller's catch is the fallback path.
 */
export async function createMapboxMap(options: MapOptions): Promise<MapboxMap> {
  const [gl] = await Promise.all([
    import('mapbox-gl'),
    // Positioning/attribution styles for the canvas, and the zoom control's own
    // chrome. Imported here rather than at the top of a component so it rides
    // the same lazy chunk.
    import('mapbox-gl/dist/mapbox-gl.css'),
  ]);
  const map = new gl.Map(options);
  // No compass: this map never rotates, and a compass that cannot be turned is
  // a control that answers a question nobody asked.
  map.addControl(new gl.NavigationControl({ showCompass: false }), 'top-right');
  return map;
}
