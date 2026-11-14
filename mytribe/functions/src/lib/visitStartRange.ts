import type { Firestore } from 'firebase-admin/firestore';
import { classifyArrivalDistance, formatDistance, haversineMeters } from './geo';
import { resolveHouseholdLocation } from './householdLocation';

/**
 * ISSUE #2279, operator ruling 2026-11-14: "cant start visit until within range
 * of the property. if they cant start, then they cant complete. only admin
 * auntie can complete visits outside of ranges".
 *
 * With "Verify arrival and departure" on, an Auntie's On my way and Arrived are
 * refused unless she is inside the operator's range of the household. The owner
 * may start from anywhere, and a start measured outside the range is recorded.
 *
 * THERE IS ONE RANGE. It is `business_settings.arrivalRadiusMeters`, read by
 * `readArrivalSettings`, measured by `classifyArrivalDistance` against the
 * coordinate `resolveHouseholdLocation` keeps. This file adds no second number
 * and no second way of measuring; it decides who may start on a given verdict.
 *
 * THE FIX IS NEVER KEPT. As in `verifyVisitArrival`, the coordinate is measured
 * and dropped: only a distance reaches the session, the audit and the log.
 */

/** `details.code` on the refusal when she is measured outside the range. */
export const VISIT_START_RANGE_CODE = 'visit_start_outside_range';
/** `details.code` when her position could not be used to tell either way. */
export const VISIT_START_LOCATION_CODE = 'visit_start_location_needed';

/** The device's fix, as a start tap sends it. */
export interface StartFix {
  lat: number;
  lng: number;
  accuracyMeters?: number | undefined;
}

/** What one fix measured against one household. Shared with `verifyVisitArrival`. */
export interface ArrivalMeasurement {
  status: 'within' | 'outside' | 'unverified' | 'household_location_unknown';
  /** Metres from the household. Null when there is no household coordinate. */
  distanceMeters: number | null;
  /** Why there is no usable distance, when there is none. */
  reason: string | null;
  /** True when this lookup geocoded the household for the first time. */
  geocodedNow: boolean;
}

/**
 * Measure one fix against the household's coordinate. The same arithmetic and
 * the same verdicts `verifyVisitArrival` has always returned; lifted here so
 * the start gate cannot measure a second, slightly different way.
 */
export async function measureArrival(
  firestore: Firestore,
  args: { kinfolkId: string; fix: StartFix; radiusMeters: number; mapboxToken: string },
): Promise<ArrivalMeasurement> {
  const lookup = await resolveHouseholdLocation(firestore, args.kinfolkId, args.mapboxToken);
  if (!lookup.found) {
    return {
      status: 'household_location_unknown',
      distanceMeters: null,
      reason: lookup.reason,
      geocodedNow: false,
    };
  }
  const distanceMeters =
    Math.round(haversineMeters({ lat: args.fix.lat, lng: args.fix.lng }, lookup.location) * 10) / 10;
  const status = classifyArrivalDistance({
    distanceMeters,
    accuracyMeters: args.fix.accuracyMeters ?? null,
    radiusMeters: args.radiusMeters,
  });
  return {
    status,
    distanceMeters,
    reason: status === 'unverified' ? 'fix_too_imprecise' : null,
    geocodedNow: lookup.geocodedNow,
  };
}

/** What the gate knows when an Auntie taps a start step. `no_fix` is a tap that sent no position. */
export type StartRangeFinding = ArrivalMeasurement | { status: 'no_fix' };

export type AuntieStartDecision =
  | { allow: true; /** Started with no range check, which the Activity Log says. */ unchecked: boolean }
  | { allow: false; code: string; message: string; /** For the Activity Log line. */ why: string };

/**
 * THE POLICY, IN ONE PLACE: may an Auntie start on this finding?
 *
 *   within                       yes.
 *   outside                      no. This is the ruling.
 *   no_fix, unverified           no. The ruling says she starts once she is
 *                                within range, and a tap that sends no position
 *                                (location switched off or refused) or one too
 *                                rough to place her shows nothing about where
 *                                she is. Allowing these would let the check be
 *                                skipped by refusing the location prompt.
 *   household_location_unknown   yes, recorded as unchecked. The household has
 *                                no address we can place on a map, so there is
 *                                no range to be inside, and nothing she can do
 *                                at the door would change that.
 *
 * The ruling's words cover `outside` only. The other three rows are this
 * build's reading, kept in this one function so a different ruling changes one
 * place. `test/visitStartRange.test.ts` pins every row.
 */
export function auntieStartDecision(finding: StartRangeFinding): AuntieStartDecision {
  switch (finding.status) {
    case 'within':
      return { allow: true, unchecked: false };
    case 'household_location_unknown':
      return { allow: true, unchecked: true };
    case 'outside':
      return {
        allow: false,
        code: VISIT_START_RANGE_CODE,
        message: startOutsideRangeMessage(finding.distanceMeters ?? 0),
        why: `the Auntie was ${formatDistance(finding.distanceMeters ?? 0)} from the household`,
      };
    case 'unverified':
      return {
        allow: false,
        code: VISIT_START_LOCATION_CODE,
        message: START_LOCATION_ROUGH_MESSAGE,
        why: "the Auntie's location was too rough to check",
      };
    case 'no_fix':
      return {
        allow: false,
        code: VISIT_START_LOCATION_CODE,
        message: START_LOCATION_MISSING_MESSAGE,
        why: 'no location came with the tap',
      };
  }
}

/**
 * What she reads when she is too far away. It says how far, what she has to
 * do, and who else can start the visit. It never names Settings (she has
 * none) or the range's size (that is the operator's number).
 *
 * This is `HttpsError.message`, so an installed build that knows nothing about
 * the code still shows these words.
 */
export function startOutsideRangeMessage(distanceMeters: number): string {
  return (
    `You are ${formatDistance(distanceMeters)} from this household. You need to be at the ` +
    'property to start this visit. The owner can start it if you cannot get there.'
  );
}

export const START_LOCATION_MISSING_MESSAGE =
  'We could not get your location, so we cannot tell that you are at the property. Turn on ' +
  'location for this app and try again. The owner can also start this visit.';

export const START_LOCATION_ROUGH_MESSAGE =
  'Your location is too rough to tell that you are at the property. Try again where your ' +
  'phone has a clearer signal. The owner can also start this visit.';

/**
 * What a direct write the rules refused reads as. `firestore.rules` refuses an
 * Auntie's own start write while the rule is on, and a rules refusal carries no
 * words, so each client says this for it.
 */
export const START_NEEDS_PROPERTY_MESSAGE =
  'You need to be at the property to start this visit. The owner can start it if you cannot get there.';
