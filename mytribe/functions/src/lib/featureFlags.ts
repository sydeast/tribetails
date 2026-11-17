import { db } from './firestoreAdmin';

/**
 * Feature flags as the SERVER reads them.
 *
 * The flags live in one doc, `business_settings/feature_flags`, written by the
 * admin Feature Flags screen through `setFeatureFlags`. A tester may carry
 * overrides on `clients/{uid}.featureFlags`. `getFeatureFlags` hands the
 * merged map to a client, which decides what to draw from it.
 *
 * A flag that only a client reads is a suggestion: an older installed build,
 * or a caller that is not one of our apps, never asked. So a flag that changes
 * what a callable STORES is resolved here, by the callable, with the same
 * merge the client was given. The screen and the write then cannot disagree.
 */

/**
 * Choosing specific Kin for a visit (operator ruling 2026-11-12, #1822 /
 * #1862). OFF, the default: every visit covers every Kin in the home, no app
 * shows a Kin picker, and a booking writer stores the whole active roster
 * whatever it was sent. ON: both booking wizards, New visit and the visit's
 * own Kin editor let the Kin be chosen, and the writers keep the choice.
 *
 * One key for the admin apps, the desktop console and both portal apps. See
 * `lib/kinRoster.ts#kinRosterForNewVisit` for the rule it switches.
 */
export const KEY_VISITS_CHOOSE_KIN = 'auntieos.visits.chooseKin';

/** Keeps only boolean-valued entries from an arbitrary object. */
function boolMap(v: unknown): Record<string, boolean> {
  if (!v || typeof v !== 'object') return {};
  const out: Record<string, boolean> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'boolean') out[k] = val;
  }
  return out;
}

/**
 * The flags set for this caller. Two layers, per-tester wins:
 *   - global:   business_settings/feature_flags  (a `{ flags: {...} }` doc, or a
 *               flat `{ key: bool }` doc, both accepted)
 *   - perUser:  clients/{uid}.featureFlags        (a `{ key: bool }` map)
 *
 * Only flags set somewhere appear. A key that is absent is at its default,
 * which the reader supplies.
 */
export async function resolveFeatureFlags(uid: string): Promise<Record<string, boolean>> {
  const [globalSnap, clientSnap] = await Promise.all([
    db().collection('business_settings').doc('feature_flags').get(),
    db().collection('clients').doc(uid).get(),
  ]);
  const globalData = (globalSnap.data() ?? {}) as Record<string, unknown>;
  const global = boolMap(globalData['flags'] ?? globalData);
  const perUser = boolMap(((clientSnap.data() ?? {}) as Record<string, unknown>)['featureFlags']);
  return { ...global, ...perUser };
}

/**
 * Whether this caller may choose specific Kin for a visit. Off unless the
 * flag is set to `true`.
 *
 * A failed read answers off, never an error: the flag picks between two
 * working behaviours, and the default one must not be what stops a visit from
 * being booked.
 */
export async function chooseKinEnabled(uid: string): Promise<boolean> {
  try {
    return (await resolveFeatureFlags(uid))[KEY_VISITS_CHOOSE_KIN] === true;
  } catch {
    return false;
  }
}
