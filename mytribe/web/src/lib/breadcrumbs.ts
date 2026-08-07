import { collection, onSnapshot } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { firestore } from './firebase';
import type { RoutePoint } from '@tribetails/geo';

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
      const points: RoutePoint[] = snapshot.docs
        .map((doc): RoutePoint | null => {
          const data = doc.data() as { lat?: unknown; lng?: unknown; timestamp?: unknown };
          const lat = typeof data.lat === 'number' ? data.lat : null;
          const lng = typeof data.lng === 'number' ? data.lng : null;
          if (lat === null || lng === null) return null;
          const parsed = typeof data.timestamp === 'string' ? Date.parse(data.timestamp) : NaN;
          return Number.isNaN(parsed) ? { lat, lng } : { lat, lng, t: parsed };
        })
        .filter((p): p is RoutePoint => p !== null)
        .sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
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
