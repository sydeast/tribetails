import { useEffect, useState } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from './firebase';
import type { RoutePoint } from '@tribetails/geo';

/**
 * The operator's live GPS read for one visit: `kin_care_sessions/{id}/breadcrumbs`.
 *
 * WHOSE POLICY APPLIES HERE, because there are two and they are easy to
 * confuse. `allowClientLocationSharing` -- the operator's "Let kinfolk see
 * visit locations" switch (#519) -- governs what a HOUSEHOLD sees, and nothing
 * else. `functions/src/lib/locationSharing.ts` is explicit that it is enforced
 * in the two callables that project route data to a kinfolk (`getMyVisits`,
 * `getMyKinTales`) and in the kinfolk branch of the breadcrumbs rule; and
 * `mytribe/firestore.rules`'s own comment on that rule says "An auntie's own
 * read is untouched." This module is the auntie's own read. The switch does not
 * gate it, must not gate it, and a surface that hid an operator's route because
 * the operator had chosen not to publish it to households would be answering a
 * different question from the one that was asked.
 *
 * A DEDICATED LISTENER RATHER THAN `useCollection`, for two reasons that are
 * both about the `timestamp` field:
 *
 *   1. TWO WRITERS, TWO SHAPES, and the mismatch is real rather than
 *      theoretical. Android's `LocationPoint` (`data/model/LocationModels.kt`)
 *      serializes `latitude` / `longitude` / `timestamp: Long`, which is what
 *      `KinCareRepository#addBreadcrumb` writes today. The older wasm web
 *      client wrote `lat` / `lng` / `timestamp: String`, which is the shape the
 *      portal's own `lib/breadcrumbs.ts` still reads and the ONLY shape it
 *      reads -- a point written by Android comes back with both coordinates
 *      null there and is dropped. Both shapes are on live documents, so this
 *      reader accepts both and normalizes; see `normalizeBreadcrumb`.
 *   2. A SERVER `orderBy('timestamp')` WOULD ORDER THEM WRONGLY. Firestore
 *      sorts mixed-type fields by type GROUP first (numbers before strings), so
 *      a session with both shapes would come back with every Android ping
 *      before every web one regardless of when they were taken. `useCollection`
 *      requires a server `order`, so the honest read is a plain subscription
 *      sorted client-side on the normalized millisecond value -- which is what
 *      the portal does, and what Android's own `breadcrumbsOrderedByTimestamp`
 *      does after its query.
 *
 * The sandbox scope `useCollection` applies centrally is not lost by going
 * around it: `lib/testScope.ts` has no entry for this subcollection (a
 * breadcrumb carries no `kinfolkId` to scope by), and the Firestore rule
 * already gates a test admin on the PARENT session's `kinfolkId` matching their
 * scope, which is a check no client-side predicate could make anyway.
 */

/** One breadcrumb document, as either writer may have left it. */
interface BreadcrumbWire {
  lat?: unknown;
  lng?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  timestamp?: unknown;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * One breadcrumb as a `RoutePoint`, or null when it carries no usable
 * coordinate pair.
 *
 * `lat`/`lng` is preferred over `latitude`/`longitude` only because a document
 * carrying both is a document written by something that meant the short pair;
 * no writer in the tree emits both today, so the order is a tiebreak that
 * should never fire rather than a rule.
 *
 * `timestamp` is accepted as a number (Android's epoch millis) or a string
 * (the older ISO writes), and a point whose timestamp is neither still counts:
 * it has a real location, and dropping it would put a hole in the polyline over
 * a field the map does not draw. Such a point sorts to the front, the same
 * `?? 0` the portal uses.
 */
export function normalizeBreadcrumb(data: BreadcrumbWire): RoutePoint | null {
  const lat = num(data.lat) ?? num(data.latitude);
  const lng = num(data.lng) ?? num(data.longitude);
  if (lat === null || lng === null) return null;

  const raw = data.timestamp;
  const t =
    typeof raw === 'number' && Number.isFinite(raw)
      ? raw
      : typeof raw === 'string'
        ? Date.parse(raw)
        : NaN;
  return Number.isNaN(t) ? { lat, lng } : { lat, lng, t };
}

/** Chronological, on the normalized millisecond value. See the header. */
export function orderBreadcrumbs(points: RoutePoint[]): RoutePoint[] {
  return [...points].sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
}

export interface BreadcrumbsState {
  points: RoutePoint[];
  /** Non-null when the subscription itself failed. Distinct from "no pings yet". */
  error: string | null;
  /** False until the first snapshot lands, so "loading" never renders as "no route". */
  ready: boolean;
}

/**
 * Live breadcrumbs for `sessionId`, or a settled empty when it is null.
 *
 * `error` rides alongside the points because "no pings yet" and "the
 * subscription is dead" are different facts that render identically if the
 * caller only receives an array -- the exact defect the portal's own hook
 * documents fixing, where a permission-denied left "Waiting for the first GPS
 * ping…" on screen forever.
 */
export function useBreadcrumbs(sessionId: string | null): BreadcrumbsState {
  const [state, setState] = useState<BreadcrumbsState>({
    points: [],
    error: null,
    ready: sessionId === null,
  });

  useEffect(() => {
    if (sessionId === null || sessionId.trim() === '') {
      setState({ points: [], error: null, ready: true });
      return;
    }
    setState({ points: [], error: null, ready: false });

    let ref;
    try {
      ref = collection(db, 'kin_care_sessions', sessionId, 'breadcrumbs');
    } catch (err) {
      setState({
        points: [],
        error: err instanceof Error ? err.message : 'Invalid session id.',
        ready: true,
      });
      return;
    }

    return onSnapshot(
      ref,
      (snap) => {
        const points = orderBreadcrumbs(
          snap.docs
            .map((d) => normalizeBreadcrumb(d.data() as BreadcrumbWire))
            .filter((p): p is RoutePoint => p !== null),
        );
        setState({ points, error: null, ready: true });
      },
      (err) => {
        setState({
          points: [],
          error: err.message === '' ? 'Live tracking is unavailable right now.' : err.message,
          ready: true,
        });
      },
    );
  }, [sessionId]);

  return state;
}

/**
 * The DURABLE copy of a route, off the session document's own `gpsSummary`.
 * THE ONLY summary normalizer in this app; `lib/kinTaleGps.ts` imports it.
 *
 * WHY A SECOND SOURCE EXISTS AT ALL. `scheduled/purgeOldVisitRoutes.ts` deletes
 * breadcrumbs past the operator's retention window, and the summary is what
 * survives: `LocationTrackingService#saveRoute` bakes it onto the session when
 * tracking stops, down-sampled to fit Firestore's per-doc cap. A GPS panel that
 * read breadcrumbs alone would therefore be blank on exactly the finished
 * visits an operator goes back to look at.
 *
 * The summary's own points are `{ lat, lng, t }` (`GpsPoint`, the shape
 * `getMyVisits.ts` projects), NOT the breadcrumb subcollection's two shapes,
 * which is why this is a different function from `normalizeBreadcrumb` above
 * rather than the same one twice.
 *
 * `t === 0` IS DROPPED, NOT READ AS 1970 (issue #610). `GpsPoint` documents the
 * sentinel in as many words -- "Epoch millis. 0 if unknown"
 * (`LocationModels.kt`) -- and a summary can carry it: `GpsPoint.t` defaults to
 * `0L` when a stored point has no `t`, and the desktop writer's ISO parser
 * returns `0L` on any string it cannot read. Passed through, a zero at either
 * END of the route reaches `RouteMap`'s `durationFromPoints` fallback and spans
 * 1970 to the real ping: about 56 years, rendered as a five-figure hour count.
 *
 * NO SORT, AND THAT IS THE FIX RATHER THAN AN OMISSION. A summary's points
 * arrive in walked order: both writers map over an already-ordered list
 * (`LocationTrackingService#downsamplePoints`, and the desktop's `downsample`),
 * and Android's own composer renders `gpsSummary.route` as-is
 * (`KinTaleReportViewModel.kt:324`). Sorting on `t ?? 0` was not preserving
 * that order, it was overriding it -- and it placed every unknown-clock point
 * at the FRONT, moving the start of the drawn polyline. `orderBreadcrumbs`
 * remains for the breadcrumbs SUBcollection, which genuinely arrives unordered.
 */
export function routePointsFromGpsSummary(summary: unknown): RoutePoint[] {
  if (summary === null || typeof summary !== 'object') return [];
  const route = (summary as { route?: unknown }).route;
  if (!Array.isArray(route)) return [];
  const points: RoutePoint[] = [];
  for (const raw of route) {
    if (raw === null || typeof raw !== 'object') continue;
    const p = raw as { lat?: unknown; lng?: unknown; t?: unknown };
    const lat = num(p.lat);
    const lng = num(p.lng);
    if (lat === null || lng === null) continue;
    const t = num(p.t);
    points.push(t === null || t === 0 ? { lat, lng } : { lat, lng, t });
  }
  return points;
}
