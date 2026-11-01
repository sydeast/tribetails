/**
 * Shared constants and pure helpers for the two-way pet (Kin) mirror bridge
 * between the canonical MyTribe record `families/{kinfolkId}/kin/{kinId}` and
 * the AuntieOS flat `kin/{docId}` collection.
 *
 * ONE WRITER PER FIELD
 *   parent (kinfolk) owns: name, species, breed, photoUrl, ageYears, status,
 *                          and the care-instruction block.
 *   staff (AuntieOS)  owns: the_411 AI summary, plus AuntieOS-only flat-doc
 *                          fields (routine, officeNotes, etc). Those staff-only
 *                          fields never travel to the family doc (#1335): see
 *                          lib/kinStaffFields.ts.
 *
 * The family side is canonical, so the reverse trigger (`onFlatKinWrite`) is
 * NOT allowed to write any parent-owned field back into the family doc, doing
 * so would let a stale staff edit clobber what the parent just typed.
 */

/** Marker value written into `_mirrorOrigin` by the family -> flat mirror. */
export const MIRROR_ORIGIN_FAMILY = 'family';
/** Marker value written into `_mirrorOrigin` by the flat -> family mirror. */
export const MIRROR_ORIGIN_FLAT = 'flat';

/**
 * Fields the parent owns. These are EXCLUDED from the flat -> family reverse
 * mirror so a staff write can never clobber them.
 *
 * `status` (the memorial toggle) is here because `portal/kinWrites.ts`, a
 * kinfolk-facing callable, is its only writer. It must never travel flat ->
 * family: AuntieOS writes `archived` straight onto the flat doc, and letting
 * that ride back would un-memorialize a pet the family just said goodbye to,
 * in a spelling the portal contract does not even have.
 */
export const PARENT_OWNED_FIELDS: readonly string[] = [
  'name',
  'species',
  'breed',
  'photoUrl',
  'ageYears',
  'status',
  'feedingInstructions',
  'walkingInstructions',
  'medications',
  'allergies',
  'emergencyNotes',
  'sitterNotes',
];

/**
 * Fields BOTH sides edit: the descriptive pet facts the admin has always kept
 * on the flat doc (sex, weight, markings, fixed flag, vet) and the household can
 * now edit in the portal (#1310). They are deliberately NOT in
 * PARENT_OWNED_FIELDS, so the flat -> family reverse mirror keeps carrying them
 * (they are in STAFF_EDITABLE_FIELDS), and ARE in FLAT_MIRROR_FIELDS, so a
 * household edit reaches the admin. Last writer wins; each direction only fires
 * when that side's copy actually changed, and the echo guards end the bounce.
 *
 * Everything else staff keeps (routine, officeNotes, reactive, vaccinations,
 * the_411, dossiers) stays staff-only, on the flat doc, and never reaches the
 * family doc at all (#1335).
 */
export const HOUSEHOLD_SHARED_FIELDS: readonly string[] = [
  'sex',
  'weight',
  'colorMarkings',
  'spayedNeutered',
  'vetInfo',
];
/**
 * The subset of parent-owned fields copied VERBATIM family -> flat, plus the
 * shared descriptive fields above.
 *
 * `status` is deliberately not copied: the two collections speak different
 * status vocabularies (portal `active`/`noLongerWithUs`, flat
 * `active`/`inactive`/`archived`), so `mirrorFamilyKinToFlat` translates it on
 * the create/archive/restore paths instead of leaking the portal spelling into
 * the flat doc or resetting a staff `archived` on every unrelated parent edit.
 */
export const FLAT_MIRROR_FIELDS: readonly string[] = [
  ...PARENT_OWNED_FIELDS.filter((f) => f !== 'status'),
  ...HOUSEHOLD_SHARED_FIELDS,
];

/**
 * Staff-editable fields that flow flat -> family: ONLY the descriptive pet facts
 * the household sees in the portal (sex, weight, colorMarkings, spayedNeutered,
 * vetInfo). The family doc is readable by every active household member, so
 * nothing staff-only may ever be listed here (#1335). `routine`, `officeNotes`,
 * `reactive`, `vaccinations` and the rest stay on the flat doc, which only staff
 * can read; STAFF_ONLY_KIN_FIELDS names them, and `onFlatKinWrite` strips that
 * list from its payload as a second guard.
 *
 * The_411 AI summary is intentionally NOT here either; getMyKin joins that
 * collection directly via legacyKinId, so it never needs to live on the family
 * doc and is never written by either mirror.
 */
export const STAFF_EDITABLE_FIELDS: readonly string[] = HOUSEHOLD_SHARED_FIELDS;
export { STAFF_ONLY_KIN_FIELDS } from '../lib/kinStaffFields';

/** Returns a new object with only the listed keys that are not undefined. */
export function pickDefined(
  source: Record<string, unknown> | undefined,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!source) return out;
  for (const k of keys) {
    if (source[k] !== undefined) out[k] = source[k];
  }
  return out;
}

/** Returns a new object with the listed keys removed. */
export function omitKeys(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...source };
  for (const k of keys) delete out[k];
  return out;
}

/** Shallow value-equality good enough for Firestore scalar/string fields. */
function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // Treat undefined and null as the same "absent" value to avoid spurious diffs.
  if (a == null && b == null) return true;
  return false;
}

/**
 * True when at least one of `keys` differs between before and after. Used as
 * the real-change guard so an echo write (which re-fires the trigger but leaves
 * the projected fields untouched) produces no further mirror write.
 */
export function projectChanged(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  for (const k of keys) {
    if (!shallowEqual(before?.[k], after[k])) return true;
  }
  return false;
}
