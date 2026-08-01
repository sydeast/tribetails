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

/** Every input is a plain string; age/photo are parsed at build time. */
export interface KinEditForm {
  name: string;
  species: string;
  breed: string;
  ageYears: string;
  photoUrl: string;
  feedingInstructions: string;
  walkingInstructions: string;
  medications: string;
  allergies: string;
  emergencyNotes: string;
  sitterNotes: string;
}

/** Max lengths transcribed from the KinPayload zod schema. */
export const KIN_MAX = {
  name: 80,
  species: 40,
  breed: 80,
  longText: 2000,
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

/** A blank form for the Add New Kin screen (KinAdd.tsx) — every field starts empty. */
export function emptyKinForm(): KinEditForm {
  return {
    name: '',
    species: '',
    breed: '',
    ageYears: '',
    photoUrl: '',
    feedingInstructions: '',
    walkingInstructions: '',
    medications: '',
    allergies: '',
    emergencyNotes: '',
    sitterNotes: '',
  };
}

/** Seeds the string-backed form from the loaded kin (null becomes empty). */
export function kinFormFromDto(kin: KinDto): KinEditForm {
  return {
    name: kin.name ?? '',
    species: kin.species ?? '',
    breed: kin.breed ?? '',
    ageYears: kin.ageYears !== null ? String(kin.ageYears) : '',
    photoUrl: kin.photoUrl ?? '',
    feedingInstructions: kin.feedingInstructions ?? '',
    walkingInstructions: kin.walkingInstructions ?? '',
    medications: kin.medications ?? '',
    allergies: kin.allergies ?? '',
    emergencyNotes: kin.emergencyNotes ?? '',
    sitterNotes: kin.sitterNotes ?? '',
  };
}

export type KinFormErrors = Partial<Record<keyof KinEditForm, string>>;

/** True only for a valid, absolute http(s) URL, mirroring the server's SafeUrl refine. */
function isHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

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

  const photoUrl = form.photoUrl.trim();
  if (photoUrl.length > 0 && !isHttpUrl(photoUrl)) errors.photoUrl = 'Photo URL must start with http:// or https://.';

  for (const key of LONG_TEXT_FIELDS) {
    if (form[key].trim().length > KIN_MAX.longText) errors[key] = `Keep this to ${KIN_MAX.longText} characters or fewer.`;
  }

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

  const photoUrl = form.photoUrl.trim() || null;
  if (photoUrl !== kin.photoUrl) changes.photoUrl = photoUrl;

  for (const key of LONG_TEXT_FIELDS) {
    const next = form[key].trim() || null;
    if (next !== kin[key]) changes[key] = next;
  }

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
    photoUrl: form.photoUrl.trim() || null,
    feedingInstructions: form.feedingInstructions.trim() || null,
    walkingInstructions: form.walkingInstructions.trim() || null,
    medications: form.medications.trim() || null,
    allergies: form.allergies.trim() || null,
    emergencyNotes: form.emergencyNotes.trim() || null,
    sitterNotes: form.sitterNotes.trim() || null,
  };
}
