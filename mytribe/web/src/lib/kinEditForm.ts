import type { AddKinRequest, KinDto, KinPayloadPartial } from '../api/types';

/**
 * Pure form logic for the Kin edit screen (KinEdit.tsx), kept out of the
 * component so validation + the change-diff are unit-testable without a DOM.
 *
 * The editable field set and its limits mirror the `KinPayload` zod schema in
 * functions/src/portal/kinWrites.ts exactly, so the form fails loud on the
 * client BEFORE calling updateKin rather than round-tripping to a server
 * rejection. `legacyKinId` is intentionally not exposed: like the Compose
 * AddEditKinDialog, it is derived from the doc id, never hand-edited.
 */

/**
 * Every input is a plain string; age is parsed at build time.
 *
 * #1291: `photoUrl` is NOT a form field any more. The photo is uploaded
 * (signKinPhotoUpload + confirmKinPhotoUpload) or removed as its own step on
 * the screen, so the text form never carries it: a Save after an upload can
 * not send the stale, pre-upload URL back over the new one.
 */
export interface KinEditForm {
  name: string;
  species: string;
  breed: string;
  ageYears: string;
  feedingInstructions: string;
  walkingInstructions: string;
  medications: string;
  allergies: string;
  emergencyNotes: string;
  sitterNotes: string;
  /** The five facts shared with the admin (#1310). Text ones are '' when unset. */
  sex: string;
  weight: string;
  colorMarkings: string;
  vetInfo: string;
  spayedNeutered: boolean;
}

/**
 * Species the portal offers in the picker. Same seven as the admin's
 * `NEW_KIN_SPECIES_OPTIONS` (auntieos-admin/src/api/directoryWrite.ts), so a
 * pet created on either side lands on a value the avatar icon table knows.
 * `Other` is a picker entry, never a stored value: it reveals a free-text box
 * and the typed text is what is saved.
 */
export const KIN_SPECIES_OPTIONS = ['Dog', 'Cat', 'Bird', 'Rabbit', 'Reptile', 'Small mammal'] as const;
export const SPECIES_OTHER = 'Other';
/** The picker entry a stored species belongs to: a listed species (any case), else Other, else '' for unset. */
export function speciesChoice(species: string): string {
  const trimmed = species.trim();
  if (trimmed === '') return '';
  const listed = KIN_SPECIES_OPTIONS.find((o) => o.toLowerCase() === trimmed.toLowerCase());
  return listed ?? SPECIES_OTHER;
}
/** The form fields backed by a text box (everything but the spayed / neutered checkbox). */
export type KinTextKey = Exclude<keyof KinEditForm, 'spayedNeutered'>;

/** Options for the Sex picker; same three the admin offers (KinEditScreen GENDER_OPTIONS). */
export const KIN_SEX_OPTIONS = ['Male', 'Female', 'Unknown'] as const;

/** Max lengths transcribed from the KinPayload zod schema. */
export const KIN_MAX = {
  name: 80,
  species: 40,
  breed: 80,
  longText: 2000,
  sex: 40,
  weight: 40,
  colorMarkings: 200,
} as const;

/** The six free-text care/notes fields that share the 2000-char cap. */
const LONG_TEXT_FIELDS = [
  'feedingInstructions',
  'walkingInstructions',
  'medications',
  'allergies',
  'emergencyNotes',
  'sitterNotes',
] as const;

/**
 * The shared text facts. Unlike the six above they are never sent as null: the
 * server takes '' to clear (kinWrites.ts), so the diff compares against '' too.
 */
const SHARED_TEXT_FIELDS = ['sex', 'weight', 'colorMarkings', 'vetInfo'] as const;

/** A blank form for the Add New Kin screen (KinAdd.tsx) — every field starts empty. */
export function emptyKinForm(): KinEditForm {
  return {
    name: '',
    species: '',
    breed: '',
    ageYears: '',
    feedingInstructions: '',
    walkingInstructions: '',
    medications: '',
    allergies: '',
    emergencyNotes: '',
    sitterNotes: '',
    sex: '',
    weight: '',
    colorMarkings: '',
    vetInfo: '',
    spayedNeutered: false,
  };
}

/** Seeds the string-backed form from the loaded kin (null becomes empty). */
export function kinFormFromDto(kin: KinDto): KinEditForm {
  return {
    name: kin.name ?? '',
    species: kin.species ?? '',
    breed: kin.breed ?? '',
    ageYears: kin.ageYears !== null ? String(kin.ageYears) : '',
    feedingInstructions: kin.feedingInstructions ?? '',
    walkingInstructions: kin.walkingInstructions ?? '',
    medications: kin.medications ?? '',
    allergies: kin.allergies ?? '',
    emergencyNotes: kin.emergencyNotes ?? '',
    sitterNotes: kin.sitterNotes ?? '',
    sex: kin.sex ?? '',
    weight: kin.weight ?? '',
    colorMarkings: kin.colorMarkings ?? '',
    vetInfo: kin.vetInfo ?? '',
    spayedNeutered: kin.spayedNeutered === true,
  };
}

export type KinFormErrors = Partial<Record<keyof KinEditForm, string>>;


/**
 * Parses the age text into the payload value. Empty is a valid null (age not
 * set); anything that is not a finite number >= 0 returns 'invalid' so the
 * caller can both block submit and skip it in the change-diff.
 */
export function parseAge(raw: string): number | null | 'invalid' {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return 'invalid';
  return n;
}

/** Field-keyed validation errors; an empty object means the form is valid. */
export function validateKinForm(form: KinEditForm): KinFormErrors {
  const errors: KinFormErrors = {};

  const name = form.name.trim();
  if (name.length === 0) errors.name = 'Name is required.';
  else if (name.length > KIN_MAX.name) errors.name = `Name must be ${KIN_MAX.name} characters or fewer.`;

  if (form.species.trim().length > KIN_MAX.species) errors.species = `Species must be ${KIN_MAX.species} characters or fewer.`;
  if (form.breed.trim().length > KIN_MAX.breed) errors.breed = `Breed must be ${KIN_MAX.breed} characters or fewer.`;

  if (parseAge(form.ageYears) === 'invalid') errors.ageYears = 'Age must be a number of 0 or more.';


  for (const key of LONG_TEXT_FIELDS) {
    if (form[key].trim().length > KIN_MAX.longText) errors[key] = `Keep this to ${KIN_MAX.longText} characters or fewer.`;
  }

  if (form.sex.trim().length > KIN_MAX.sex) errors.sex = `Sex must be ${KIN_MAX.sex} characters or fewer.`;
  if (form.weight.trim().length > KIN_MAX.weight) errors.weight = `Weight must be ${KIN_MAX.weight} characters or fewer.`;
  if (form.colorMarkings.trim().length > KIN_MAX.colorMarkings) errors.colorMarkings = `Keep this to ${KIN_MAX.colorMarkings} characters or fewer.`;
  if (form.vetInfo.trim().length > KIN_MAX.longText) errors.vetInfo = `Keep this to ${KIN_MAX.longText} characters or fewer.`;

  return errors;
}

/** Convenience predicate for gating the Save control. */
export function hasErrors(errors: KinFormErrors): boolean {
  return Object.keys(errors).length > 0;
}

/**
 * Only the fields whose normalized value differs from the current kin, so the
 * partial sent to updateKin carries just what the kinfolk actually changed.
 * Empty text normalizes to null (clears the field on the server's merge write).
 * Assumes validateKinForm already passed; an unparsable age is left untouched.
 */
export function buildKinChanges(kin: KinDto, form: KinEditForm): KinPayloadPartial {
  const changes: KinPayloadPartial = {};

  const name = form.name.trim();
  if (name !== (kin.name ?? '')) changes.name = name;

  const species = form.species.trim() || null;
  if (species !== kin.species) changes.species = species;

  const breed = form.breed.trim() || null;
  if (breed !== kin.breed) changes.breed = breed;

  const parsedAge = parseAge(form.ageYears);
  const ageYears = parsedAge === 'invalid' ? kin.ageYears : parsedAge;
  if (ageYears !== kin.ageYears) changes.ageYears = ageYears;


  for (const key of LONG_TEXT_FIELDS) {
    const next = form[key].trim() || null;
    if (next !== kin[key]) changes[key] = next;
  }

  for (const key of SHARED_TEXT_FIELDS) {
    const next = form[key].trim();
    if (next !== (kin[key] ?? '')) changes[key] = next;
  }
  if (form.spayedNeutered !== (kin.spayedNeutered === true)) changes.spayedNeutered = form.spayedNeutered;

  return changes;
}

/**
 * Full addKin payload (not a diff, unlike buildKinChanges): every field
 * normalized, empty text becomes null except `name` (required, trimmed).
 * Assumes validateKinForm already passed — an unparsable age is sent as null
 * rather than blocking, mirroring buildKinChanges' fallback.
 */
export function buildNewKinPayload(form: KinEditForm): AddKinRequest['kin'] {
  const parsedAge = parseAge(form.ageYears);
  return {
    name: form.name.trim(),
    species: form.species.trim() || null,
    breed: form.breed.trim() || null,
    ageYears: parsedAge === 'invalid' ? null : parsedAge,
    feedingInstructions: form.feedingInstructions.trim() || null,
    walkingInstructions: form.walkingInstructions.trim() || null,
    medications: form.medications.trim() || null,
    allergies: form.allergies.trim() || null,
    emergencyNotes: form.emergencyNotes.trim() || null,
    sitterNotes: form.sitterNotes.trim() || null,
    // Shared facts: omitted when blank (a new pet has nothing to clear), and the
    // flag only when set, so an untouched Add form writes no empty strings.
    ...(form.sex.trim() ? { sex: form.sex.trim() } : {}),
    ...(form.weight.trim() ? { weight: form.weight.trim() } : {}),
    ...(form.colorMarkings.trim() ? { colorMarkings: form.colorMarkings.trim() } : {}),
    ...(form.vetInfo.trim() ? { vetInfo: form.vetInfo.trim() } : {}),
    ...(form.spayedNeutered ? { spayedNeutered: true } : {}),
  };
}
