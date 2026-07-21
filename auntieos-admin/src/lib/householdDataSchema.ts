import { z } from 'zod';

/**
 * Validation AND the field catalog for the Household Data editor.
 *
 * Ported from android `ui/directory/HouseholdDataScreen.kt` (the five editable
 * cards) over `data/model/DynamicFields.kt#HouseholdData` (the 30 stored
 * fields). The Kotlin screen hand-writes 30 `AuntieField` call sites and
 * validates exactly one thing, that `kinfolkId` is not blank, on save. That is
 * why a phone number there can be "call the desk", and nothing says so.
 *
 * Two jobs live in one module on purpose:
 *
 *  1. THE CATALOG (`HOUSEHOLD_SECTIONS`) is the single source of the section
 *     titles, the field labels, the input kind, and which fields are secrets.
 *     The read view, the edit dialog, and the completeness counts all derive
 *     from it, so a field cannot be shown in one surface and forgotten in
 *     another. The Kotlin's `fieldLabel(base, value)` "· empty" hint exists for
 *     the same reason; the catalog makes the gap structural rather than a
 *     suffix on a label.
 *
 *  2. THE SCHEMA is executable, following `lib/kinTaleDraftSchema.ts`. Household
 *     data is written straight to Firestore (there is no `saveHouseholdData`
 *     callable anywhere in MyTribe/functions/src, checked before writing the API
 *     layer), so there is no backend contract to mirror. These rules ARE the
 *     contract.
 *
 * The catalog and the schema are kept in step by a test, not by discipline:
 * `householdDataSchema.test.ts` asserts the catalog's keys are exactly the
 * schema's keys, so adding a field to one and not the other fails the suite.
 */

/**
 * Voice Bible section 11, the one punctuation rule enforced mechanically, same
 * regex and same message as the KinTale composer. Household data is read aloud
 * to sitters and pasted into KinTales, so it is Auntie's voice too.
 */
const NO_DASHES = /[—–]/;
const DASH_MESSAGE = 'Auntie does not use dashes. Try a comma, ellipses (.....), or parentheses.';

/** A single-line note (a name, an hours string, a shelf location). */
const LINE_MAX = 200;
/** A multi-line note (an address, a routine, an evacuation plan). */
const TEXT_MAX = 2000;
const PHONE_MAX = 40;

/**
 * Enough digits to actually dial. The point is not to police formatting, it is
 * to catch the field that says "ask Marcus" sitting where an emergency vet
 * number should be, which nobody notices until the night they need it.
 */
const MIN_PHONE_DIGITS = 7;

/** Digits, the usual separators, and a trailing extension. */
const PHONE_SHAPE = /^[0-9+()\-.\s]+(?:(?:ext|x)\.?\s*[0-9]+)?$/i;

const PHONE_MESSAGE =
  'Use a number that can be dialed: at least 7 digits, with spaces, dots, hyphens, or parentheses.';

function digitCount(value: string): number {
  return (value.match(/[0-9]/g) ?? []).length;
}

/** Blank passes: every field on this record is optional, the Kotlin defaults them all to "". */
export function isDialablePhone(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '') return true;
  return PHONE_SHAPE.test(trimmed) && digitCount(trimmed) >= MIN_PHONE_DIGITS;
}

const noDashes = (v: string): boolean => !NO_DASHES.test(v);

const line = z
  .string()
  .trim()
  .max(LINE_MAX, `Keep this under ${LINE_MAX} characters.`)
  .refine(noDashes, { message: DASH_MESSAGE });

const text = z
  .string()
  .trim()
  .max(TEXT_MAX, `Keep this under ${TEXT_MAX} characters.`)
  .refine(noDashes, { message: DASH_MESSAGE });

const phone = z
  .string()
  .trim()
  .max(PHONE_MAX, `Keep this under ${PHONE_MAX} characters.`)
  .refine(isDialablePhone, { message: PHONE_MESSAGE })
  .refine(noDashes, { message: DASH_MESSAGE });

/**
 * The 30 stored fields, in the model's own order. Every one is optional (blank
 * is valid) because a household record is filled in over months, not in one
 * sitting; the rules here govern SHAPE, never presence.
 */
export const householdDataSchema = z.object({
  // Veterinary
  primaryVetName: line,
  primaryVetPhone: phone,
  primaryVetAddress: text,
  primaryVetHours: line,
  emergencyVetName: line,
  emergencyVetPhone: phone,
  emergencyVetAddress: text,

  // Household items and locations
  foodLocation: line,
  treatLocation: line,
  medicationLocation: line,
  toysLocation: line,
  beddingLocation: line,
  leashesPoopBagsLocation: line,
  cleaningSuppliesLocation: line,

  // Routines and preferences
  householdRules: text,
  preferredWalkRoutes: text,
  neighborhoodHazards: text,
  securitySystemInfo: line,
  thermostatInstructions: line,
  lightingPreferences: line,

  // Emergency and safety
  poisonControlNumber: phone,
  emergencyContactsPriority: text,
  evacuationPlan: text,
  importantDocumentsLocation: line,

  // Service providers
  groomerName: line,
  groomerPhone: phone,
  trainerName: line,
  trainerPhone: phone,
  petSitterBackup: line,
  dogWalkerBackup: line,
});

export type HouseholdFields = z.infer<typeof householdDataSchema>;
export type HouseholdFieldKey = keyof HouseholdFields;

/** Field name to its first message. An empty object means the record is clean. */
export type HouseholdFieldErrors = Partial<Record<HouseholdFieldKey, string>>;

/**
 * Validate for inline display, the `validateKinTaleDraft` shape: a field-keyed
 * map rather than a thrown ZodError, because the dialog shows each message
 * beside the input it belongs to.
 */
export function validateHouseholdData(input: HouseholdFields): HouseholdFieldErrors {
  const result = householdDataSchema.safeParse(input);
  if (result.success) return {};

  const errors: HouseholdFieldErrors = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0];
    // First message per field wins: stacking "too long" under "no dashes" is
    // noise, and the operator fixes them one at a time regardless.
    if (typeof field === 'string' && !(field in errors)) {
      errors[field as HouseholdFieldKey] = issue.message;
    }
  }
  return errors;
}

// ── The catalog ─────────────────────────────────────────────────────────────

export type HouseholdInputKind = 'line' | 'multiline' | 'phone';

export interface HouseholdFieldSpec {
  readonly key: HouseholdFieldKey;
  readonly label: string;
  readonly kind: HouseholdInputKind;
  /**
   * Rendered through `MaskedValue` in the read view and behind a reveal toggle
   * in the editor. See the SECRETS note below for why these two and no others.
   */
  readonly secret?: true;
}

export interface HouseholdSectionSpec {
  readonly id: string;
  readonly title: string;
  readonly blurb: string;
  readonly fields: readonly HouseholdFieldSpec[];
}

/**
 * SECRETS, and the reasoning, because "mask more" is not automatically safer.
 *
 * MASKED
 *   securitySystemInfo          An alarm panel code. Knowing it is knowing how
 *                               to enter the home without tripping anything.
 *   importantDocumentsLocation  Names the drawer holding passports, titles, and
 *                               deeds. It grants no entry, but it is the one
 *                               line on this record that tells someone already
 *                               inside exactly where to go, and every sitter,
 *                               walker, and backup on the roster can read it.
 *
 * DELIBERATELY NOT MASKED
 *   poisonControlNumber, emergencyContactsPriority, evacuationPlan
 *                               Masking these would be actively dangerous. They
 *                               exist to be read in the ninety seconds after
 *                               something goes wrong, one-handed, and a reveal
 *                               toggle is a step between a sitter and a vet.
 *   medicationLocation          A location note that has to be legible at the
 *                               doorstep on a dose schedule. Operational, and
 *                               hiding it costs more than it protects.
 *   food/treat/toys/bedding/leashes/cleaning locations
 *                               Operational, by the parent brief's own rule.
 */
export const HOUSEHOLD_SECTIONS: readonly HouseholdSectionSpec[] = [
  {
    id: 'veterinary',
    title: 'Veterinary',
    blurb: 'Who to call, and who to call at 2am.',
    fields: [
      { key: 'primaryVetName', label: 'Primary vet', kind: 'line' },
      { key: 'primaryVetPhone', label: 'Primary vet phone', kind: 'phone' },
      { key: 'primaryVetHours', label: 'Primary vet hours', kind: 'line' },
      { key: 'primaryVetAddress', label: 'Primary vet address', kind: 'multiline' },
      { key: 'emergencyVetName', label: 'Emergency vet', kind: 'line' },
      { key: 'emergencyVetPhone', label: 'Emergency vet phone', kind: 'phone' },
      { key: 'emergencyVetAddress', label: 'Emergency vet address', kind: 'multiline' },
    ],
  },
  {
    id: 'items',
    title: 'Items and locations',
    blurb: 'Where everything lives, so nobody has to open every cupboard.',
    fields: [
      { key: 'foodLocation', label: 'Food', kind: 'line' },
      { key: 'treatLocation', label: 'Treats', kind: 'line' },
      { key: 'medicationLocation', label: 'Medications', kind: 'line' },
      { key: 'toysLocation', label: 'Toys', kind: 'line' },
      { key: 'beddingLocation', label: 'Bedding', kind: 'line' },
      { key: 'leashesPoopBagsLocation', label: 'Leashes and bags', kind: 'line' },
      { key: 'cleaningSuppliesLocation', label: 'Cleaning supplies', kind: 'line' },
    ],
  },
  {
    id: 'routines',
    title: 'Routines and preferences',
    blurb: 'How this household runs when Auntie is the one running it.',
    fields: [
      { key: 'householdRules', label: 'Household rules', kind: 'multiline' },
      { key: 'preferredWalkRoutes', label: 'Preferred walk routes', kind: 'multiline' },
      { key: 'neighborhoodHazards', label: 'Neighborhood hazards', kind: 'multiline' },
      { key: 'securitySystemInfo', label: 'Security system', kind: 'line', secret: true },
      { key: 'thermostatInstructions', label: 'Thermostat', kind: 'line' },
      { key: 'lightingPreferences', label: 'Lighting', kind: 'line' },
    ],
  },
  {
    id: 'emergency',
    title: 'Emergency and safety',
    blurb: 'Read in the first ninety seconds, so none of it hides behind a toggle.',
    fields: [
      { key: 'poisonControlNumber', label: 'Poison control', kind: 'phone' },
      { key: 'emergencyContactsPriority', label: 'Emergency contacts, in order', kind: 'multiline' },
      { key: 'evacuationPlan', label: 'Evacuation plan', kind: 'multiline' },
      {
        key: 'importantDocumentsLocation',
        label: 'Important documents',
        kind: 'line',
        secret: true,
      },
    ],
  },
  {
    id: 'providers',
    title: 'Service providers',
    blurb: 'The rest of the household roster, and who covers Auntie.',
    fields: [
      { key: 'groomerName', label: 'Groomer', kind: 'line' },
      { key: 'groomerPhone', label: 'Groomer phone', kind: 'phone' },
      { key: 'trainerName', label: 'Trainer', kind: 'line' },
      { key: 'trainerPhone', label: 'Trainer phone', kind: 'phone' },
      // The stored keys stay `petSitterBackup` / `dogWalkerBackup`: they are the
      // android model's field names and renaming them would be a migration, not
      // a relabel. The LABELS follow house vocabulary, which has no "pet" in it.
      { key: 'petSitterBackup', label: 'Backup sitter', kind: 'line' },
      { key: 'dogWalkerBackup', label: 'Backup dog walker', kind: 'line' },
    ],
  },
];

/** Every catalogued key, in section order. Pinned against the schema by test. */
export const HOUSEHOLD_FIELD_KEYS: readonly HouseholdFieldKey[] = HOUSEHOLD_SECTIONS.flatMap(
  (section) => section.fields.map((field) => field.key),
);

/** The all-blank record. Every field defaults to "", matching the Kotlin model. */
export function blankHouseholdFields(): HouseholdFields {
  const blank = {} as Record<HouseholdFieldKey, string>;
  for (const key of HOUSEHOLD_FIELD_KEYS) blank[key] = '';
  return blank as HouseholdFields;
}

/** The subset of [errors] belonging to [section], so a dialog only blocks on its own fields. */
export function sectionErrors(
  errors: HouseholdFieldErrors,
  section: HouseholdSectionSpec,
): HouseholdFieldErrors {
  const own: HouseholdFieldErrors = {};
  for (const field of section.fields) {
    const message = errors[field.key];
    if (message !== undefined) own[field.key] = message;
  }
  return own;
}

/** How many of [section]'s fields carry a real value. Drives the "3 of 7 on file" subtitle. */
export function sectionFilledCount(section: HouseholdSectionSpec, values: HouseholdFields): number {
  return section.fields.filter((field) => values[field.key].trim() !== '').length;
}
