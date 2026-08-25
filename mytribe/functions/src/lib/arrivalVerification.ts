import type { Firestore } from 'firebase-admin/firestore';

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
 * WHAT THIS IS NOT. It does not check WHERE the operator was. Distance-based
 * verification (`VisitRoute.visitVerified`, the 50m/100m geofence in
 * `LocationTrackingService.checkLocationEvents`) is unreachable for a separate
 * reason: no household coordinate is stored anywhere, `serviceAddress` is free
 * text, and the geofence's `homeLocation` is null on every real start path. The
 * server-side geocoder that could supply one exists (`admin/optimizeRoute.ts`,
 * on the `MAPBOX_ACCESS_TOKEN` secret already in use), so it is buildable, but
 * capturing and storing a household's coordinates is a product decision with a
 * privacy dimension that has not been made. It is named in the PR as a
 * follow-up rather than half-built here.
 */

/** The unified settings doc every client writes (`business_settings/business_settings`). */
const BUSINESS_SETTINGS_DOC = 'business_settings/business_settings';

/** Machine-readable `details.code` on the refusal, so a client branches on it rather than the message. */
export const ARRIVAL_VERIFICATION_CODE = 'arrival_verification_required';

/**
 * Is the operator requiring arrival and departure before a visit may be
 * completed? Only an explicit `true` turns it on; see the header for why this
 * gate reads the opposite way round from the others.
 */
export async function isArrivalVerificationRequired(firestore: Firestore): Promise<boolean> {
  try {
    const snap = await firestore.doc(BUSINESS_SETTINGS_DOC).get();
    return snap.data()?.requireArrivalDepartureVerification === true;
  } catch {
    // A settings read that failed is not an operator asking for a restriction.
    return false;
  }
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
