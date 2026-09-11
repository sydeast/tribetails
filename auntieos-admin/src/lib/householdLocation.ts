import { useMemo } from 'react';
import { useDocById } from './firestore';

/**
 * The household's geocoded point, for the purple house marker on the Kin Care
 * route map (#760).
 *
 * READ ONLY, AND NEVER GEOCODED HERE. The coordinate is written server-side by
 * `mytribe/functions/src/lib/householdLocation.ts`: `onKinfolkAddressWrite`
 * geocodes the address when it changes, and `verifyVisitArrival` tops it up
 * lazily for a household whose record predates the feature. That file's header
 * states where it lives, `kinfolk/{kinfolkId}.serviceLocation`, and why the
 * collection is staff-only. This module reads that stored field and nothing
 * else. A browser that geocoded an address for a marker would spend a Mapbox
 * call per page view on a fact the server already owns, and would hand two
 * surfaces two different answers the day one of them was rate limited.
 *
 * ABSENT IS AN ORDINARY ANSWER. A household with no address, or an address
 * Mapbox could not match, gets `serviceLocationError` and no coordinate. The
 * map draws no house marker and says nothing about it: "we do not know where
 * this house is" is not news the office needs shouted over a route.
 */

export interface HouseholdPoint {
  lat: number;
  lng: number;
  /** The address string the coordinate was derived from, or `''`. */
  geocodedFrom: string;
}

/**
 * Is this a usable point on Earth? Same check as the functions-side
 * `isValidLatLng`, repeated rather than imported because `mytribe/functions` is
 * deliberately not a workspace member and this app cannot reach it.
 *
 * `0, 0` is rejected on purpose. It is a real coordinate in the Gulf of Guinea
 * and it is also what a half-written document holds, and a house marker 3,000
 * miles off the route would read as a tracking failure rather than as a missing
 * field.
 */
function isUsablePoint(lat: unknown, lng: unknown): lat is number {
  if (typeof lat !== 'number' || typeof lng !== 'number') return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  return !(lat === 0 && lng === 0);
}

/**
 * `serviceLocation` off a raw household document, or null when it is absent or
 * unusable. Pure, so the shape can be driven from a spec without Firestore.
 */
export function readHouseholdPoint(data: unknown): HouseholdPoint | null {
  if (!data || typeof data !== 'object') return null;
  const raw = (data as Record<string, unknown>)['serviceLocation'];
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const lat = rec['lat'];
  const lng = rec['lng'];
  if (!isUsablePoint(lat, lng)) return null;
  return {
    lat: lat as number,
    lng: lng as number,
    geocodedFrom: typeof rec['geocodedFrom'] === 'string' ? rec['geocodedFrom'] : '',
  };
}

/**
 * Live subscription to one household's stored coordinate.
 *
 * `useDocById` rather than a one-shot read, for its own stated reason: the
 * address can be edited from the Kinfolk profile in another tab, and a frozen
 * copy would leave the house marker on the old street until someone reloaded.
 *
 * Returns null for a blank id, a document that does not exist, a read the
 * sandbox suppresses, and a permission denial, all of which `useDocById`
 * already settles to `ready` with no data. The caller draws no marker for every
 * one of them, which is the correct behaviour for all four.
 */
export function useHouseholdLocation(kinfolkId: string | null | undefined): HouseholdPoint | null {
  const doc = useDocById<Record<string, unknown>>('kinfolk', kinfolkId);
  const data = doc.status === 'ready' ? doc.data : null;
  return useMemo(() => readHouseholdPoint(data), [data]);
}
