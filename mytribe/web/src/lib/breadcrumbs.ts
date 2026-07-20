import { collection, onSnapshot } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { firestore } from './firebase';
import type { RoutePoint } from './routeMap';

/**
 * Realtime GPS pings for one in-progress visit, ported from
 * GitliveFirestoreClient.breadcrumbsStream. Path is
 * `kin_care_sessions/{sessionId}/breadcrumbs`; firestore.rules gate reads to
 * the session's own kinfolkId. No `orderBy` in the query (would need an
 * index) — sort client-side by timestamp instead, same as Kotlin.
 */
export function subscribeBreadcrumbs(sessionId: string, onUpdate: (points: RoutePoint[]) => void): () => void {
  const ref = collection(firestore, 'kin_care_sessions', sessionId, 'breadcrumbs');
  return onSnapshot(ref, (snapshot) => {
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
  });
}

/** React hook wrapper: live breadcrumb list for `sessionId`, empty until the first ping (or if null). */
export function useBreadcrumbs(sessionId: string | null): RoutePoint[] {
  const [points, setPoints] = useState<RoutePoint[]>([]);

  useEffect(() => {
    if (!sessionId) {
      setPoints([]);
      return;
    }
    setPoints([]);
    return subscribeBreadcrumbs(sessionId, setPoints);
  }, [sessionId]);

  return points;
}
