import {
  durationFromPoints,
  formatDistance,
  formatDuration,
  totalDistanceMeters,
  type RoutePoint,
} from '@tribetails/geo';
import type { SessionGpsSummary } from '../api/sessions';

/**
 * The GPS block the KinTale composer shows: the route the visit actually took,
 * read off the PARENT `kin_care_sessions` doc.
 *
 * READ-ONLY, and that is the reference behaviour rather than a corner cut.
 * Android's composer does `gpsRoute = session.gpsSummary?.route.orEmpty()`
 * (`KinTaleReportViewModel.kt:324`) and renders it; the Compose desktop streams
 * the `breadcrumbs` subcollection and renders that (`KinTaleComposeScreen.kt:
 * 832-844`). NEITHER writes a coordinate onto the `kin_care_reports` doc. The
 * only writer of a report's `gpsRoute`/`gpsSummary` anywhere in the monorepo is
 * the legacy importer `mytribe/functions/src/admin/ingestKinTale.ts:57-58`.
 *
 * So a natively-composed KinTale carries no route, on any platform, and the
 * household's KinTale card shows no map for it. That is a real gap, but closing
 * it means putting coordinates on a kinfolk-visible document, which issue #519
 * already treated as an operator decision (that is what `shareLocations`
 * gates). It is named in the PR for issue #397 item L20 as a question for the
 * operator, not decided here.
 *
 * Android's source is used rather than the desktop's breadcrumb stream: the
 * summary is baked onto the session when DEPARTED fires (`Models.kt:769`), and
 * every session this composer can open is DEPARTED or COMPLETED, so the baked
 * summary is always the finished one. It also costs no second listener and no
 * composite index.
 */

/** What the block needs to render. `null` when the visit has no usable route. */
export interface KinTaleGpsBlock {
  route: RoutePoint[];
  /** e.g. "1.2 km" */
  distanceLabel: string;
  /** e.g. "25m 0s". `@tribetails/geo`'s own placeholder when no duration is known. */
  durationLabel: string;
}

/**
 * Turn a session's stored `gpsSummary` into the block, or `null` to render
 * nothing at all.
 *
 * Nothing is rendered for a route of fewer than two points. One ping is a
 * location, not a route: drawing it would show the household a dot where their
 * Kin stood and imply a walk that was never recorded.
 *
 * `t` is dropped when it is `0`, because Android's `GpsPoint.t` documents `0` as
 * UNKNOWN (`LocationModels.kt:31`) while `@tribetails/geo`'s `RoutePoint.t`
 * treats a present number as a real epoch instant. Passing the sentinel through
 * would have `durationFromPoints` read 1970 as the walk's start.
 *
 * Distance and duration come from the STORED summary when it has them, matching
 * the portal's own renderer (`RouteMap` takes both as props), and are computed
 * from the points only as a fallback. The stored values were computed against
 * the full breadcrumb trail before it was down-sampled to fit the document, so
 * they are the more accurate pair.
 */
export function kinTaleGpsBlock(summary: SessionGpsSummary | undefined): KinTaleGpsBlock | null {
  const route = routePointsFrom(summary);
  if (route.length < 2) return null;

  const storedDistance = numberOrNull(summary?.distanceMeters);
  const storedDuration = numberOrNull(summary?.durationSeconds);

  return {
    route,
    distanceLabel: formatDistance(storedDistance ?? totalDistanceMeters(route)),
    durationLabel: formatDuration(storedDuration ?? durationFromPoints(route)),
  };
}

/** The coordinate list alone, defensively decoded. Exported for the block's own tests. */
export function routePointsFrom(summary: SessionGpsSummary | undefined): RoutePoint[] {
  const raw = summary?.route;
  if (!Array.isArray(raw)) return [];
  const out: RoutePoint[] = [];
  for (const p of raw) {
    if (p === null || typeof p !== 'object') continue;
    const lat = numberOrNull((p as { lat?: unknown }).lat);
    const lng = numberOrNull((p as { lng?: unknown }).lng);
    if (lat === null || lng === null) continue;
    const t = numberOrNull((p as { t?: unknown }).t);
    out.push(t === null || t === 0 ? { lat, lng } : { lat, lng, t });
  }
  return out;
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
