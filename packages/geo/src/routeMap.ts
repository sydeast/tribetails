/**
 * Pure math for the GPS route replay map. Ports
 * src/commonMain/kotlin/com/kinfolk/portal/components/RouteMap.kt verbatim
 * (bounding-box fit with a latitude-correcting longitude scale, haversine
 * distance, duration-from-timestamps) so the web replay matches Android's
 * rendering and stats exactly. No map SDK — plain SVG, same as Kotlin's
 * plain Canvas.
 */

export interface RoutePoint {
  lat: number;
  lng: number;
  /** Epoch millis. Undefined means unknown. */
  t?: number;
}

export interface ProjectedPoint {
  x: number;
  y: number;
}

/**
 * Fits `route` into a `width`x`height` box with `pad` px of margin,
 * correcting longitude for latitude distortion. Mirrors RouteMap.kt's
 * `project()` closure exactly, including the y-axis flip (north = up).
 */
export function projectRoute(route: RoutePoint[], width: number, height: number, pad = 16): ProjectedPoint[] {
  const w = width - pad * 2;
  const h = height - pad * 2;
  if (route.length === 0 || w <= 0 || h <= 0) return [];

  let minLat = route[0]!.lat;
  let maxLat = minLat;
  let minLng = route[0]!.lng;
  let maxLng = minLng;
  for (const p of route) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng);
    maxLng = Math.max(maxLng, p.lng);
  }
  const dLat = Math.max(maxLat - minLat, 1e-6);
  const dLng = Math.max(maxLng - minLng, 1e-6);
  const midLat = (minLat + maxLat) / 2;
  const lngScale = Math.cos((midLat * Math.PI) / 180);
  const effDLng = dLng * lngScale;
  const scale = Math.min(w / effDLng, h / dLat);
  const drawnW = effDLng * scale;
  const drawnH = dLat * scale;
  const xOff = pad + (w - drawnW) / 2;
  const yOff = pad + (h - drawnH) / 2;

  return route.map((p) => ({
    x: (p.lng - minLng) * lngScale * scale + xOff,
    y: drawnH - (p.lat - minLat) * scale + yOff,
  }));
}

const EARTH_RADIUS_METERS = 6_371_000;

function haversineMeters(a: RoutePoint, b: RoutePoint): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const h = s1 * s1 + Math.cos(lat1) * Math.cos(lat2) * s2 * s2;
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function totalDistanceMeters(route: RoutePoint[]): number {
  if (route.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < route.length; i++) total += haversineMeters(route[i - 1]!, route[i]!);
  return total;
}

export function durationFromPoints(route: RoutePoint[]): number {
  const first = route[0]?.t;
  const last = route[route.length - 1]?.t;
  if (first === undefined || last === undefined) return 0;
  return Math.max(0, Math.round((last - first) / 1000));
}

export function formatDistance(meters: number): string {
  if (meters < 1) return '0 m';
  if (meters < 1_000) return `${Math.trunc(meters)} m`;
  const km = meters / 1_000;
  return `${Math.trunc(km * 10) / 10} km`;
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return '—';
  const h = Math.trunc(seconds / 3_600);
  const m = Math.trunc((seconds % 3_600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
