import { randomUUID } from 'node:crypto';

/**
 * Shared constants and pure helpers for the two-way pet (Kin) mirror bridge
 * between the canonical MyTribe record `families/{kinfolkId}/kin/{kinId}` and
 * the AuntieOS flat `kin/{docId}` collection.
 *
 * THE FIELD TABLE (#1907, #1908, owner rulings 2026-11-11 and 2026-11-12)
 *
 *   household copy key     admin copy key          travels      notes
 *   ---------------------  ----------------------  -----------  -----------------------------
 *   name, species, breed   same                    family>flat  identity, household owns it
 *   photoUrl               profilePictureUrl       family>flat  see buildAdminPortraitStamp
 *   status                 status                  neither      translated on create/archive
 *   ageYears (number)      age (text)              both         translated
 *   medications            medicationHealthNotes   both         ONE field (kin-meds ruling)
 *   sex, weight,           same                    both         #1310
 *   colorMarkings,
 *   spayedNeutered
 *   feedingInstructions,   same                    both         #1908: admin gets a box
 *   walkingInstructions,
 *   allergies,
 *   emergencyNotes,
 *   sitterNotes
 *   staysAs, routine,      same                    both         #1908: household gets a box
 *   trainingCommands,
 *   feedingBrand,
 *   vaccinations
 *   ownVetClinicId         same                    both         '' = the household's vet
 *   vetInfo                same                    both         legacy free text, no longer
 *                                                               an input on either side
 *   officeNotes, reactive, (admin only)            never        staff-only, #1335
 *   tags
 *
 * Text fields are never null on the admin copy: the admin Android and desktop
 * `Kin` models read a missing value as "", and a null crashes an older decoder
 * (#1370). The household copy keeps the null the portal writes.
 *
 * ECHOES. Every mirror write carries `_mirrorOrigin` and a fresh
 * `_mirrorWriteId`. A write is an echo of the other mirror only when that id is
 * NEW on this write. A client write leaves the id as it was, so a flag a mirror
 * left behind on an earlier write can never silence a real edit. It used to:
 * the reverse mirror skipped every flat write whose `_mirrorOrigin` read
 * `family`, and the forward mirror stamps that on every write it makes, so an
 * admin edit to a Kin the household had touched never reached the household.
 *
 * ONLY WHAT CHANGED TRAVELS. Each direction copies the fields that changed on
 * the side that was written, never the whole projection, so an edit to one
 * field cannot carry a stale copy of another one across.
 */

/** Marker value written into `_mirrorOrigin` by the family -> flat mirror. */
export const MIRROR_ORIGIN_FAMILY = 'family';
/** Marker value written into `_mirrorOrigin` by the flat -> family mirror. */
export const MIRROR_ORIGIN_FLAT = 'flat';

type Data = Record<string, unknown>;

/**
 * The stamp every mirror write carries. `_mirrorWriteId` is new on each one,
 * which is what tells its echo apart from a later client write (see above).
 */
export function mirrorStamp(origin: string): { _mirrorOrigin: string; _mirrorWriteId: string } {
  return { _mirrorOrigin: origin, _mirrorWriteId: randomUUID() };
}

/**
 * True when this write was made by the mirror (or a mirror-aware script) that
 * stamps [origin]: the write id is new on it. Same pattern as
 * `isOfficeStatusWrite` in onFamilyKinWrite.ts.
 */
export function isMirrorEcho(before: Data | undefined, after: Data, origin: string): boolean {
  const id = after['_mirrorWriteId'];
  return (
    after['_mirrorOrigin'] === origin &&
    typeof id === 'string' &&
    id !== '' &&
    id !== before?.['_mirrorWriteId']
  );
}

/**
 * Fields the household owns alone: they travel family -> flat and never back,
 * so a stale admin copy can never overwrite them.
 *
 * `status` (the memorial toggle) is here because `portal/kinWrites.ts`, a
 * kinfolk-facing callable, is its only household writer. It must never travel
 * flat -> family: AuntieOS writes `archived` straight onto the flat doc, and
 * letting that ride back would un-memorialize a pet the family just said
 * goodbye to, in a spelling the portal contract does not even have.
 */
export const PARENT_OWNED_FIELDS: readonly string[] = ['name', 'species', 'breed', 'photoUrl', 'status'];

/**
 * Fields BOTH sides edit, stored under the same key on both copies. Last
 * writer wins; each direction fires only for the fields that changed on the
 * side that was written, and the echo stamp ends the bounce.
 */
export const HOUSEHOLD_SHARED_FIELDS: readonly string[] = [
  'sex',
  'weight',
  'colorMarkings',
  'spayedNeutered',
  'vetInfo',
  'feedingInstructions',
  'walkingInstructions',
  'allergies',
  'emergencyNotes',
  'sitterNotes',
  'staysAs',
  'routine',
  'trainingCommands',
  'feedingBrand',
  'vaccinations',
  'ownVetClinicId',
];

/** The shared fields that hold text (everything above but the fixed flag). */
const SHARED_TEXT_FIELDS: readonly string[] = HOUSEHOLD_SHARED_FIELDS.filter((f) => f !== 'spayedNeutered');

/** Medications: one field, kept as `medications` by the household and `medicationHealthNotes` by the admin. */
export const MEDS_FAMILY_KEY = 'medications';
export const MEDS_FLAT_KEY = 'medicationHealthNotes';

/** Age: a number of years on the household copy, the text the admin typed on the flat one. */
export const AGE_FAMILY_KEY = 'ageYears';
export const AGE_FLAT_KEY = 'age';

/**
 * Household-copy keys the forward (family -> flat) mirror reads. Also the set
 * whose change means "the household changed something the office can see"
 * (`pets.updated`).
 *
 * `status` is deliberately not copied: the two collections speak different
 * status vocabularies (portal `active`/`noLongerWithUs`, flat
 * `active`/`inactive`/`archived`), so `mirrorFamilyKinToFlat` translates it on
 * the create/archive/restore paths instead.
 */
export const FLAT_MIRROR_FIELDS: readonly string[] = [
  ...PARENT_OWNED_FIELDS.filter((f) => f !== 'status'),
  ...HOUSEHOLD_SHARED_FIELDS,
  MEDS_FAMILY_KEY,
  AGE_FAMILY_KEY,
];

/** Admin-copy keys the reverse (flat -> family) mirror reads. */
export const STAFF_EDITABLE_FIELDS: readonly string[] = [...HOUSEHOLD_SHARED_FIELDS, MEDS_FLAT_KEY, AGE_FLAT_KEY];

export { STAFF_ONLY_KIN_FIELDS } from '../lib/kinStaffFields';

/** #1370: flat-doc fields the admin `Kin` models decode as non-null `String`. */
export const FLAT_NON_NULL_TEXT_FIELDS: readonly string[] = [
  'name',
  'species',
  'breed',
  ...SHARED_TEXT_FIELDS,
  MEDS_FLAT_KEY,
  AGE_FLAT_KEY,
];

/** Returns a new object with only the listed keys that are not undefined. */
export function pickDefined(source: Data | undefined, keys: readonly string[]): Data {
  const out: Data = {};
  if (!source) return out;
  for (const k of keys) {
    if (source[k] !== undefined) out[k] = source[k];
  }
  return out;
}

/** Returns a new object with the listed keys removed. */
export function omitKeys(source: Data, keys: readonly string[]): Data {
  const out: Data = { ...source };
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
 * the real-change guard so a write that leaves the projected fields untouched
 * produces no further mirror write.
 */
export function projectChanged(before: Data | undefined, after: Data, keys: readonly string[]): boolean {
  for (const k of keys) {
    if (!shallowEqual(before?.[k], after[k])) return true;
  }
  return false;
}

/**
 * The keys among [keys] whose value is set on [after] and differs from
 * [before]. With no [before] (a create) that is every key that is set. A key
 * removed outright is not a value either side can copy, so it is not listed.
 */
export function changedKeys(before: Data | undefined, after: Data, keys: readonly string[]): string[] {
  return keys.filter((k) => after[k] !== undefined && (before === undefined || !shallowEqual(before[k], after[k])));
}

/**
 * Parses an age into years: a number as it is, or the first decimal number in
 * the admin's text ("4" -> 4, "4 years" -> 4, "4.5" -> 4.5). Unparseable,
 * negative or absurd (> 100, which catches a birth year typed as "2019") ->
 * null. Shared with `scripts/backfill_kin_adoption.ts`.
 */
export function parseAgeYears(v: unknown): number | null {
  let n: number | null = null;
  if (typeof v === 'number' && Number.isFinite(v)) {
    n = v;
  } else if (typeof v === 'string') {
    const m = v.match(/\d+(?:\.\d+)?/);
    n = m ? parseFloat(m[0]) : null;
  }
  if (n == null || !Number.isFinite(n) || n < 0 || n > 100) return null;
  return n;
}

/** The admin's text for an age in years: "4", "0.5", or "" for none. */
export function formatAgeText(v: unknown): string {
  const n = parseAgeYears(v);
  return n === null ? '' : String(n);
}

/** A household-copy value as the admin copy stores it: text is never null. */
function flatValue(key: string, value: unknown): unknown {
  if (value === null && FLAT_NON_NULL_TEXT_FIELDS.includes(key)) return '';
  return value;
}

/**
 * Translates household-copy fields into admin-copy fields. [keys] are the
 * household keys to carry; the rest of [after] is ignored.
 */
export function toFlatFields(after: Data, keys: readonly string[]): Data {
  const out: Data = {};
  for (const k of keys) {
    if (after[k] === undefined) continue;
    if (k === MEDS_FAMILY_KEY) out[MEDS_FLAT_KEY] = flatValue(MEDS_FLAT_KEY, after[k]);
    else if (k === AGE_FAMILY_KEY) out[AGE_FLAT_KEY] = formatAgeText(after[k]);
    else out[k] = flatValue(k, after[k]);
  }
  return out;
}

/**
 * Translates admin-copy fields into household-copy fields. [keys] are the
 * admin keys to carry. An age the admin typed that holds no number is not
 * copied: the household copy holds a number or nothing, and blanking it over
 * a typo would lose the household's value. A cleared age clears it.
 */
export function toFamilyFields(after: Data, keys: readonly string[]): Data {
  const out: Data = {};
  for (const k of keys) {
    if (after[k] === undefined) continue;
    if (k === MEDS_FLAT_KEY) {
      out[MEDS_FAMILY_KEY] = after[k];
    } else if (k === AGE_FLAT_KEY) {
      const text = typeof after[k] === 'string' ? (after[k] as string).trim() : '';
      if (text === '') out[AGE_FAMILY_KEY] = null;
      else {
        const n = parseAgeYears(text);
        if (n !== null) out[AGE_FAMILY_KEY] = n;
      }
    } else {
      out[k] = after[k];
    }
  }
  return out;
}

/**
 * The household copy a flat Kin gets when the office made it first (#1847):
 * identity, photo, age and every shared field, translated. Blank values are
 * left out. Pure.
 */
export function buildFamilyCopyFromFlat(flat: Data): Data {
  const out: Data = {};
  const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
  const name = text(flat['name']);
  if (name) out['name'] = name.trim();
  const species = text(flat['species']);
  if (species) out['species'] = species;
  const breed = text(flat['breed']);
  if (breed) out['breed'] = breed;
  const photo = text(flat['photoUrl']) ?? text(flat['profilePictureUrl']);
  if (photo) out['photoUrl'] = photo;
  const age = parseAgeYears(text(flat[AGE_FLAT_KEY]) ?? flat[AGE_FAMILY_KEY]);
  if (age !== null) out[AGE_FAMILY_KEY] = age;
  const shared = toFamilyFields(flat, [...HOUSEHOLD_SHARED_FIELDS, MEDS_FLAT_KEY]);
  for (const [k, v] of Object.entries(shared)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    out[k] = v;
  }
  return out;
}
