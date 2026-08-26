/**
 * ISSUE #582: the arithmetic behind "was the Auntie actually at the household",
 * kept in one dependency-free file so it can be tested without Firestore, Mapbox
 * or a callable around it.
 *
 * Nothing here decides policy. `haversineMeters` answers how far apart two
 * points are; `classifyArrivalDistance` turns that plus a GPS error bar and the
 * operator's radius into one of three verdicts. Which verdict refuses a COMPLETE
 * is `arrivalVerification.ts`'s business, and where the numbers came from is
 * `verifyVisitArrival.ts`'s.
 */

/** A point on the earth, in the order every Firestore document here stores it. */
export interface LatLng {
  lat: number;
  lng: number;
}

/** Mean earth radius (IUGG), metres. */
const EARTH_RADIUS_M = 6_371_008.8;

const toRadians = (deg: number): number => (deg * Math.PI) / 180;

/** Is this a real coordinate, in range, and not a NaN that arithmetic would carry? */
export function isValidLatLng(p: Partial<LatLng> | null | undefined): p is LatLng {
  if (!p) return false;
  const { lat, lng } = p as LatLng;
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/**
 * Great-circle distance between two points, in metres.
 *
 * A sphere, not an ellipsoid: at the scale this is used for — tens to a few
 * hundred metres — the spherical model is within a fraction of a metre of
 * Vincenty, which is far inside the GPS error bar it is compared against. A
 * more precise formula would be false precision.
 */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * A fix this vague is not evidence of anything.
 *
 * A phone indoors regularly reports a 30-60m accuracy radius, which is normal
 * and usable. A fix derived from a cell tower or a coarse network lookup can
 * report a kilometre or more, and at that size `distance - accuracy` is negative
 * against any sane radius, so the visit would pass the check while nothing was
 * actually verified. A verification that always says yes is worse than no
 * verification, because it reads as one. Above this, the fix is recorded as
 * UNVERIFIED rather than as a pass.
 */
export const MAX_USEFUL_ACCURACY_METERS = 1000;

export type ArrivalDistanceVerdict = 'within' | 'outside' | 'unverified';

export interface ArrivalDistanceInput {
  /** Metres between the recorded fix and the household. Absent when no fix was taken. */
  distanceMeters?: number | null;
  /** The fix's own error radius in metres, as the device reported it. */
  accuracyMeters?: number | null;
  /** The operator's "how close counts as arrived" setting, in metres. */
  radiusMeters: number;
}

/**
 * Where a recorded arrival falls against the operator's radius.
 *
 * THE ERROR BAR IS SPENT IN THE AUNTIE'S FAVOUR. The comparison is
 * `distance - accuracy > radius`, not `distance > radius`, so a visit is only
 * called out-of-range when the fix is confidently outside: a 200m reading with a
 * 90m error bar against a 150m radius is 110m at best, which is inside, and is
 * NOT refused. The asymmetry is deliberate and is the whole reason this returns
 * three values instead of a boolean. Stranding an Auntie who is standing in the
 * kitchen because the roof blocked the sky is a worse failure than letting a
 * genuinely absent one close a visit, and the second failure is exactly where
 * this feature started.
 */
export function classifyArrivalDistance(input: ArrivalDistanceInput): ArrivalDistanceVerdict {
  const { distanceMeters, accuracyMeters, radiusMeters } = input;
  if (typeof distanceMeters !== 'number' || !Number.isFinite(distanceMeters)) return 'unverified';
  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) return 'unverified';

  const accuracy =
    typeof accuracyMeters === 'number' && Number.isFinite(accuracyMeters) && accuracyMeters > 0
      ? accuracyMeters
      : 0;
  if (accuracy > MAX_USEFUL_ACCURACY_METERS) return 'unverified';

  return distanceMeters - accuracy > radiusMeters ? 'outside' : 'within';
}

/** Metres as an operator reads them: `40 m`, `1.2 km`. */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return 'an unknown distance';
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}
