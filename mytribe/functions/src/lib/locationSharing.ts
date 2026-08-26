import type { Firestore } from 'firebase-admin/firestore';

/**
 * ISSUE #519: the operator's "Let kinfolk see visit locations" switch,
 * `business_settings.allowClientLocationSharing`.
 *
 * The field has existed on three admin models since the settings unification,
 * carrying the comment "Whether clients can see any location data", and has been
 * read by nothing at all. Every kinfolk-facing surface served coordinates
 * whatever it said.
 *
 * ENFORCED WHERE THE DATA IS SERVED, not where it is drawn. A portal that hides
 * a map is not enforcement: the coordinates already crossed the wire and any
 * client can read them. So the check lives in the two callables that project
 * route data (`getMyVisits`, `getMyKinTales`) and, for the live-tracking path
 * that bypasses callables entirely, in the Firestore rule guarding the
 * `breadcrumbs` subcollection.
 *
 * WHAT IT WITHHOLDS IS COORDINATES, NOT THE VISIT. Distance and duration stay:
 * "your Auntie walked 1.2 miles with Rufus" is the fact of the visit, and the
 * switch is about WHERE, not whether. Withholding the whole summary would strip
 * a kinfolk of the record that their dog was walked, which nobody asked for.
 *
 * ABSENT MEANS ON. Every model defaults it `true`, and no settings document
 * written before this change carries the key, so reading a missing value as
 * `false` would dark-launch a lockout: every kinfolk's route would vanish on the
 * deploy that made the switch real, with no operator having chosen it. Only an
 * explicit `false` withholds. This is the same rule `enableConflictDetection`
 * (#517) and `enableAutoReminder24h` (#519) follow.
 *
 * A READ FAILURE LEAVES SHARING ON. The failure mode of guessing wrong here is
 * a kinfolk briefly seeing a route their operator already agreed to show them,
 * against a kinfolk losing the map on a Firestore blip. Neither is good; the
 * first is the one that matches what the operator last chose.
 *
 * THE KNOWN LIMIT IS CLOSED (#584, 2026-08-25). This comment used to end by
 * admitting that a kinfolk could read their own `kin_care_sessions/{id}`
 * document directly, `gpsSummary` and all, and that rules are all-or-nothing per
 * document so nothing here could mask one field. That was accurate about rules
 * and wrong about the cost: the assumption was that denying the document would
 * "break the portal outright", and it does not. Neither shipping portal client
 * ever read a session document directly - both load visits through
 * `getMyVisits`, which is this projection - so the grant was reachable rather
 * than used, and `firestore.rules` now drops its kinfolk branch on that
 * collection. The document-level hole is gone; what remains here is the
 * field-level policy, which is still the only place it can live.
 *
 * ONE COLLECTION OVER IS STILL OPEN. `kin_care_reports` keeps its kinfolk read
 * branch, and a report document carries the `gpsRoute` that `getMyKinTales`
 * below strips - so the same document-level hole exists there, for KinTale
 * routes instead of visit routes. It is not fixed here because it is not the
 * same collection and not the same portal surface. Tracked as #602, with the
 * same inventory method and test shape this change used.
 */

/** The unified settings doc every client writes (`business_settings/business_settings`). */
const BUSINESS_SETTINGS_DOC = 'business_settings/business_settings';

export async function isClientLocationSharingEnabled(firestore: Firestore): Promise<boolean> {
  try {
    const snap = await firestore.doc(BUSINESS_SETTINGS_DOC).get();
    return snap.data()?.allowClientLocationSharing !== false;
  } catch {
    return true;
  }
}

/** The coordinate-bearing keys of a `gpsSummary`. Distance and duration are deliberately absent. */
const COORDINATE_KEYS = ['startLat', 'startLng', 'endLat', 'endLng', 'route'] as const;

/**
 * A `gpsSummary` with every coordinate removed, keeping the non-locating facts.
 *
 * Returns undefined when nothing survives, so a caller can drop the key
 * entirely rather than serving an empty object a client has to special-case.
 */
export function withoutCoordinates<T extends object>(summary: T | undefined): T | undefined {
  if (!summary) return undefined;
  const out = { ...(summary as Record<string, unknown>) };
  for (const key of COORDINATE_KEYS) delete out[key];
  return Object.keys(out).length > 0 ? (out as unknown as T) : undefined;
}
