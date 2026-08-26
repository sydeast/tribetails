import { collection, onSnapshot } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { firestore } from './firebase';
import type { RoutePoint } from '@tribetails/geo';

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
 * TWO WRITERS, TWO SHAPES, and until issue #607 this module read only one of
 * them. Android's `LocationPoint` (`data/model/LocationModels.kt`) writes
 * `latitude` / `longitude` / `timestamp: Long`; the wasm web client, retired in
 * #513, wrote `lat` / `lng` / `timestamp: String`. Reading the short pair alone
 * meant every point from an Android Auntie came back with both coordinates null
 * and was dropped -- which, with the wasm client gone, is every point of every
 * current visit. A household watching a live visit saw an empty map and no
 * error, because an empty route and a discarded route render identically.
 *
 * Both shapes are on live documents, so this accepts both rather than asking
 * for a migration. `auntieos-admin/src/lib/breadcrumbs.ts#normalizeBreadcrumb`
 * is the same function for the operator's side, and
 * `GitliveFirestoreClient#decodeBreadcrumb` is the same function again for the
 * Kotlin clients. Three copies because the readers are in three languages; they
 * are kept semantically identical on purpose, and each has a test naming both
 * shapes.
 *
 * `lat`/`lng` is preferred over `latitude`/`longitude` only because a document
 * carrying both was written by something that meant the short pair; no writer
 * in the tree emits both today, so the order is a tiebreak that should never
 * fire rather than a rule.
 *
 * `timestamp` is accepted as a number (Android's epoch millis) or a string (the
 * older ISO writes), and a point whose timestamp is neither still counts: it
 * has a real location, and the map does not draw the clock. Dropping it would
 * put a hole in the polyline over a field nothing renders.
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
/**
 * Chronological, on the NORMALIZED millisecond value.
 *
 * Firestore sorts a mixed-type field by type group first, so a server
 * `orderBy('timestamp')` would return every Android ping before every web one
 * regardless of when they were taken. That is a second reason this query
 * carries no `orderBy`, alongside the index it would need.
 *
 * A point with no usable timestamp sorts to the front rather than being
 * dropped, which is the `?? 0` this module has always used.
 */
export function orderBreadcrumbs(points: RoutePoint[]): RoutePoint[] {
  return [...points].sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
}
/**
 * Realtime GPS pings for one in-progress visit, ported from
 * GitliveFirestoreClient.breadcrumbsStream. Path is
 * `kin_care_sessions/{sessionId}/breadcrumbs`; firestore.rules gate reads to
 * the session's own kinfolkId. No `orderBy` in the query (would need an
 * index) — sort client-side by timestamp instead, same as Kotlin.
 */
export function subscribeBreadcrumbs(
  sessionId: string,
  onUpdate: (points: RoutePoint[]) => void,
  onError?: (err: unknown) => void,
): () => void {
  const ref = collection(firestore, 'kin_care_sessions', sessionId, 'breadcrumbs');
  return onSnapshot(
    ref,
    (snapshot) => {
      const points = orderBreadcrumbs(
        snapshot.docs
          .map((doc) => normalizeBreadcrumb(doc.data() as BreadcrumbWire))
          .filter((p): p is RoutePoint => p !== null),
      );
      onUpdate(points);
    },
    // There was no error callback here, so a permission-denied or transport
    // failure left `points` at [] forever and Schedule rendered "Waiting for the
    // first GPS ping..." indefinitely: a dead subscription presented as a live
    // one. Its sibling lib/messagesListener.ts always passed one.
    (err) => {
      console.error('[breadcrumbs] subscription failed for session', sessionId, err);
      onError?.(err);
    },
  );
}

export interface BreadcrumbsState {
  points: RoutePoint[];
  /** Non-null when the subscription itself failed. Distinct from "no pings yet". */
  error: string | null;
}

/**
 * React hook wrapper: live breadcrumb list for `sessionId`.
 *
 * Returns `error` alongside the points because "no pings yet" and "the
 * subscription is dead" are different states that used to render identically:
 * the caller only received an array, so a permission-denied looked exactly like
 * a visit that had not started moving.
 */
export function useBreadcrumbs(sessionId: string | null): BreadcrumbsState {
  const [points, setPoints] = useState<RoutePoint[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setPoints([]);
      setError(null);
      return;
    }
    setPoints([]);
    setError(null);
    return subscribeBreadcrumbs(sessionId, setPoints, (err) => {
      setError(err instanceof Error ? err.message : 'Live tracking is unavailable right now.');
    });
  }, [sessionId]);

  return { points, error };
}
