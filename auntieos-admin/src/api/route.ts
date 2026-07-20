import { call } from '../lib/fns';

/**
 * AO-35 Route Optimizer. One admin-gated MyTribe callable, `optimizeRoute`,
 * which gathers a day's non-cancelled `kin_care_sessions`, resolves each
 * household's service address, and geocodes + optimizes with Mapbox. Shapes are
 * fixed by WIDGET_FANOUT_SPEC.md.
 *
 * FAIL LOUD, per-stop: sessions whose household has no service address are
 * returned in `unroutable` with a reason, never silently dropped from the plan.
 * If the Mapbox key is missing the callable throws (it does not fake a route),
 * and that rejection surfaces in the widget's error state.
 */

/** One optimized stop on the day's route. */
export interface RouteStop {
  order: number;
  sessionId: string;
  kinfolkId: string;
  household: string;
  address: string;
  /** Estimated arrival clock time, `HH:MM`. */
  arrivalEta: string;
}

/** One session that could not be routed (e.g. household has no address on file). */
export interface UnroutableStop {
  sessionId: string;
  household: string;
  reason: string;
}

/** The `optimizeRoute` response: the ordered stops, the totals, and the misses. */
export interface RoutePlan {
  stops: RouteStop[];
  totalMiles: number;
  totalMinutes: number;
  unroutable: UnroutableStop[];
}

/**
 * `optimizeRoute` (admin-gated): the optimized plan for [date] (`YYYY-MM-DD`).
 * Throws (via `lib/fns.call`) on auth/network/Mapbox failure, surfaced fail-loud
 * by the widget. A day with no sessions comes back with empty `stops` +
 * `unroutable` (an honest empty), which the widget renders as the empty state.
 */
export async function optimizeRoute(date: string): Promise<RoutePlan> {
  const res = await call<{ date: string }, Partial<RoutePlan>>('optimizeRoute', { date });
  return {
    stops: res.stops ?? [],
    totalMiles: res.totalMiles ?? 0,
    totalMinutes: res.totalMinutes ?? 0,
    unroutable: res.unroutable ?? [],
  };
}
