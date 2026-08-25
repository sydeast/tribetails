import type { Firestore } from 'firebase-admin/firestore';
import { formatDistance } from './geo';

/**
 * ISSUE #519: `business_settings.requireArrivalDepartureVerification`, which had
 * a control on three admin surfaces and no consumer anywhere.
 *
 * WHAT THE SWITCH NOW MEANS. When it is on, a visit cannot be marked COMPLETED
 * until it has actually been arrived at and departed from: both stamps have to
 * be on the session. When it is off, COMPLETE behaves exactly as it did, which
 * is why every existing operator's flow is unchanged unless they ask for this.
 *
 * ENFORCED AT COMPLETE, AND ONLY AT COMPLETE, which is a deliberate choice about
 * WHERE rather than a shortcut. ARRIVED and DEPARTED are written by direct
 * client patch from a phone that is regularly offline between houses, and
 * Firestore's offline write queue is what makes the field app work at all;
 * `KinCareRepository.kt`'s own comment records that as a standing decision, with
 * a test pinning it. Forcing those two through a callable would trade a working
 * offline flow for a check, and that trade is not this issue's to make. COMPLETE
 * is different: it already goes through `transitionBookingStatus`, it is the
 * transition that decides whether a visit HAPPENED and is therefore billable,
 * and it is the last point at which a skipped step can still be caught.
 *
 * So the shape is: the steps are recorded in the field, offline-tolerant, and
 * the requirement is enforced at the one gate the server already owns. An
 * operator who genuinely never arrived cannot quietly close the visit as done.
 *
 * ABSENT MEANS OFF HERE, and this is the one gate in #519 that reads that way
 * round. The other switches were live behaviours with an unread flag, so absent
 * had to mean ON or the deploy would have changed what the product did. This one
 * is a NEW restriction: no existing document carries the key, and reading a
 * missing value as "required" would start refusing COMPLETE on visits that
 * predate the feature, on every install, with no operator having asked for it.
 * A restriction nobody switched on must not switch itself on.
 *
 * WHAT THIS IS NOT — until #582. The original of this file recorded that the
 * check "does not check WHERE the operator was", because no household
 * coordinate was stored anywhere. ISSUE #582 supplies one
 * (`lib/householdLocation.ts`, geocoded from the address already on file), and
 * the second half of this module is the distance gate built on it. The first
 * half — did the steps happen at all — is unchanged.
 *
 * THE TWO GATES ARE SEPARATE AND ORDERED. A visit with no arrival stamp is
 * refused as `arrival_verification_required`, exactly as before. Only a visit
 * that HAS both stamps is then asked how far from the household the arrival was
 * recorded, and that second refusal carries its own code
 * (`arrival_outside_radius`) so a client, an operator and the audit trail can
 * tell "you skipped the step" from "you were a mile away".
 *
 * ABSENT EVIDENCE ALLOWS. A visit with no recorded distance — no GPS fix, an
 * offline arrival, a household whose address will not geocode, an arrival
 * recorded from the desktop console which has no GPS at all — passes the second
 * gate and is audited as unverified. That is deliberate and it is the most
 * important decision in this file: stranding an Auntie who is genuinely on site
 * is a worse failure than the gap this closes, and every one of those cases is
 * indistinguishable, from the server, from an honest Auntie in a basement.
 */

/** The unified settings doc every client writes (`business_settings/business_settings`). */
const BUSINESS_SETTINGS_DOC = 'business_settings/business_settings';

/** Machine-readable `details.code` on the refusal, so a client branches on it rather than the message. */
export const ARRIVAL_VERIFICATION_CODE = 'arrival_verification_required';

/** The same, for the distance gate. Deliberately a DIFFERENT code; see the header. */
export const ARRIVAL_RADIUS_CODE = 'arrival_outside_radius';

/**
 * How close to the household counts as arrived, when the operator has not said.
 *
 * 150 m, and the number is a compromise between two real errors rather than a
 * round guess. Android's dormant geofence constants
 * (`LocationTrackingService.checkLocationEvents`) use 50 m and 100 m, which are
 * fine for a phone with a clear sky and much too tight for the actual job: an
 * Auntie is usually INSIDE the house when she presses the button, and a fix
 * taken indoors drifts by tens of metres before the error bar is even
 * considered. Against that, 150 m is still small enough that the next street
 * over does not pass. Operators with a long driveway, a gated community or an
 * apartment block can raise it; the field exists so they need not accept ours.
 */
export const ARRIVAL_RADIUS_DEFAULT_METERS = 150;

/**
 * The bounds the setting is clamped to, matched exactly by the rules guard
 * (`bsInt('arrivalRadiusMeters', 10, 5000)`) and by the three admin editors.
 *
 * The floor is 10 m because a radius smaller than a consumer GPS fix's own
 * error bar refuses everybody, and an operator who wants the check off has a
 * switch for that. The ceiling is 5 km because a radius larger than that is not
 * a check.
 */
export const ARRIVAL_RADIUS_MIN_METERS = 10;
export const ARRIVAL_RADIUS_MAX_METERS = 5000;

/** The operator's radius off the settings document, clamped, defaulted, never NaN. */
export function readArrivalRadiusMeters(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return ARRIVAL_RADIUS_DEFAULT_METERS;
  const whole = Math.round(raw);
  if (whole < ARRIVAL_RADIUS_MIN_METERS) return ARRIVAL_RADIUS_MIN_METERS;
  if (whole > ARRIVAL_RADIUS_MAX_METERS) return ARRIVAL_RADIUS_MAX_METERS;
  return whole;
}

/** Both halves of the operator's arrival policy, from one settings read. */
export interface ArrivalSettings {
  required: boolean;
  radiusMeters: number;
}

/**
 * The operator's arrival policy. One read, because the COMPLETE gate needs both
 * halves and the settings document is fetched on the hot path of every
 * completion.
 */
export async function readArrivalSettings(firestore: Firestore): Promise<ArrivalSettings> {
  try {
    const snap = await firestore.doc(BUSINESS_SETTINGS_DOC).get();
    const data = snap.data();
    return {
      required: data?.requireArrivalDepartureVerification === true,
      radiusMeters: readArrivalRadiusMeters(data?.arrivalRadiusMeters),
    };
  } catch {
    // A settings read that failed is not an operator asking for a restriction.
    return { required: false, radiusMeters: ARRIVAL_RADIUS_DEFAULT_METERS };
  }
}

/**
 * Is the operator requiring arrival and departure before a visit may be
 * completed? Only an explicit `true` turns it on; see the header for why this
 * gate reads the opposite way round from the others.
 */
export async function isArrivalVerificationRequired(firestore: Firestore): Promise<boolean> {
  return (await readArrivalSettings(firestore)).required;
}

/** The stamps a session carries, as they arrive off the document. */
export interface VisitStamps {
  arrivedAt?: unknown;
  departedAt?: unknown;
}

function stamped(raw: unknown): boolean {
  return typeof raw === 'string' && raw.trim() !== '';
}

/**
 * Which of the two steps this visit is missing, in the order they happen.
 * Empty means the visit is complete-able.
 *
 * Both stamps are plain ISO strings written by the field app, and both default
 * to `""` on the model rather than being absent, so "not stamped" is a blank
 * string at least as often as it is a missing key.
 */
export function missingVisitSteps(session: VisitStamps): string[] {
  const missing: string[] = [];
  if (!stamped(session.arrivedAt)) missing.push('arrival');
  if (!stamped(session.departedAt)) missing.push('departure');
  return missing;
}

/** The refusal an operator reads. Names the steps rather than the field. */
export function arrivalVerificationMessage(missing: readonly string[]): string {
  const steps = missing.length === 2 ? 'arrival and departure' : missing[0];
  return (
    `This visit has no ${steps} recorded, and your settings require ${missing.length === 2 ? 'both' : 'it'} ` +
    'before a visit can be marked complete. Mark it on the visit card first, or turn off ' +
    '"Verify arrival and departure" in Settings.'
  );
}

// ── ISSUE #582: the distance gate ────────────────────────────────────────────

/**
 * The three fields `verifyVisitArrival` stamps on a session, and the ONLY
 * arrival-location state that is stored anywhere.
 *
 * A SCALAR, NOT A POSITION, and that is the privacy decision this feature turns
 * on. Kinfolk can read their own `kin_care_sessions` document directly
 * (`firestore.rules` :405-407), so anything written here is visible to the
 * household. A raw arrival coordinate would therefore hand them the Auntie's
 * actual position — and it is most revealing in exactly the case the check
 * exists to catch, when she was somewhere else entirely. "How far from YOUR
 * house" tells a household nothing it does not already know from `arrivedAt`.
 * The fix itself reaches the server, is measured, and is discarded: it is never
 * persisted, never logged, and never put in an audit payload.
 */
export interface ArrivalLocationEvidence {
  arrivalDistanceMeters?: unknown;
  arrivalAccuracyMeters?: unknown;
  arrivalLocationCheckedAt?: unknown;
}

/** A finite number off a document field, or null. Strings and NaN are not evidence. */
function finiteNumber(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/** The recorded distance and error bar, in the shape `classifyArrivalDistance` takes. */
export function readArrivalEvidence(session: ArrivalLocationEvidence): {
  distanceMeters: number | null;
  accuracyMeters: number | null;
} {
  return {
    distanceMeters: finiteNumber(session.arrivalDistanceMeters),
    accuracyMeters: finiteNumber(session.arrivalAccuracyMeters),
  };
}

/**
 * The refusal an operator reads when the arrival was recorded too far away.
 *
 * Names the measured distance AND the radius, because the two together are the
 * only way the reader can tell a genuine miss from a radius set too tight, and
 * offers both remedies. It does not say where the Auntie was.
 */
export function arrivalRadiusMessage(distanceMeters: number, radiusMeters: number): string {
  return (
    `This visit's arrival was recorded ${formatDistance(distanceMeters)} from the household, and ` +
    `your settings require it within ${formatDistance(radiusMeters)}. Record the arrival again ` +
    'from the household, widen "Arrival must be within" in Settings, or turn off ' +
    '"Verify arrival and departure".'
  );
}
