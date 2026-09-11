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
  /**
   * THE CANONICAL HOUSEHOLD VET (operator ruling 2026-08-01: "vet info lives on
   * household data, it can be seen on the kin profile", matching page-specs
   * 04-kinfolk-profile.md item 3).
   *
   * A `vet_clinics` document id, NOT a copied string. Name, phone, address and
   * hours are resolved through it at read time, so there is exactly one copy of
   * a clinic's details in the product and correcting the clinic in the manager
   * corrects it everywhere at once. That is what makes the number somebody
   * reads in an emergency a number somebody can fix.
   *
   * The seven free-text `primaryVet*` / `emergencyVet*` fields below are the
   * LEGACY fallback, kept readable for a household that predates the catalog
   * link. Never authored with new text; cleared to blank for a slot once that
   * slot links a clinic (`legacyVetKeysForSlot`, `VetSectionDialog`), or on
   * request from the leftovers banner's "Clear old vet notes" control
   * (`HouseholdData.tsx`). Blank id means unlinked, which both clients label
   * rather than hide.
   */
  primaryVetClinicId: line,
  /** The 24-hour clinic. A DISTINCT practice from the primary, never folded in. */
  emergencyVetClinicId: line,
  // Veterinary (legacy free text: read when unlinked, cleared once linked, never authored with new text)
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

export type HouseholdInputKind = 'line' | 'multiline' | 'phone' | 'clinicId';

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
  /**
   * Set when the section is edited by a PURPOSE-BUILT control rather than the
   * generic text dialog. Only the veterinary section carries it.
   *
   * The vet is chosen from the `vet_clinics` catalog by search (operator ruling
   * 2026-08-01: "Vets are not a open string textbox, it is a dropdown and
   * search feature"), so its two stored values are clinic IDS. Handing those to
   * a text dialog would let an operator type a raw document id, which is both
   * unusable and a way to point a household at an arbitrary clinic.
   *
   * `kinfolk` owns the household vet (`vetClinic*` regular and
   * `emergencyVetClinic*` emergency, both picked from the `vet_clinics` catalog
   * and both carrying the clinic's id). The seven fields listed on the section
   * are the OLD free-text copy. They stay in the schema and stay readable, so no
   * household silently loses what is on file before it is dealt with, but they
   * are no longer editable here: a save clears a slot's copy once that slot
   * links a clinic (issue #677), and the leftovers banner can clear whatever is
   * still left on request. Nothing ever writes new text into them again.
   *
   * WHY KINFOLK WON, on the screen someone reads the emergency number off:
   * only the catalog-linked copy can be CORRECTED. `updateVetClinic` fixes a
   * wrong clinic phone number once and fans it out to every linked household.
   * Free text on this record inherits nothing, so leaving it authoritative
   * would have meant the number read under pressure was the one copy in the
   * product that no correction could ever reach.
   */
  readonly editor?: 'vetPicker';
}

/**
 * SECRETS, and the reasoning, because "mask more" is not automatically safer.
 *
 * MASKED
 *   securitySystemInfo          An alarm panel code. Knowing it is knowing how
 *                               to enter the home without tripping anything.
 *
 * DELIBERATELY NOT MASKED
 *   medicationLocation          A location note that has to be legible at the
 *                               doorstep on a dose schedule. Operational, and
 *                               hiding it costs more than it protects.
 *   food/treat/toys/bedding/leashes/cleaning locations
 *                               Operational, by the parent brief's own rule.
 *
 * `importantDocumentsLocation` and the poison-control/emergency-contacts/
 * evacuation fields used to be listed here too (masked, unmasked, and
 * unmasked respectively). They no longer have a section to be masked ON, see
 * the removal note above the catalog below.
 */
export const HOUSEHOLD_SECTIONS: readonly HouseholdSectionSpec[] = [
  {
    id: 'veterinary',
    title: 'Veterinary',
    blurb: 'Who to call, and who to call at 2am. Chosen from the shared vet bank.',
    editor: 'vetPicker',
    fields: [
      // The canonical values. Everything shown for a linked household resolves
      // from these through `vet_clinics`, so there is one copy to correct.
      { key: 'primaryVetClinicId', label: 'Primary vet', kind: 'clinicId' },
      { key: 'emergencyVetClinicId', label: 'Emergency vet', kind: 'clinicId' },
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
  // REMOVED 2026-08-04: "Emergency and safety" (poisonControlNumber,
  // emergencyContactsPriority, evacuationPlan, importantDocumentsLocation) and
  // "Service providers" (groomerName, groomerPhone, trainerName, trainerPhone,
  // petSitterBackup, dogWalkerBackup). Operator, looking at this screen's
  // modal-edit sections: "I dont need this Emergency & Safety or Service
  // Provider boxes."
  //
  // This is a UI removal only. The ten fields stay in `householdDataSchema`
  // below and in `HOUSEHOLD_FIELD_KEYS` (now schema-derived rather than
  // catalog-derived, see the comment on that export), so `getHouseholdData`
  // still reads them off Firestore into every `HouseholdRecord` and a
  // create-time save still writes them. Nothing here deletes data or migrates
  // it away; they simply have no panel and no edit dialog on THIS screen
  // anymore.
  //
  // The emergency-contact data is not going away, it is going to a different
  // screen: the pending household/family-page redesign (operator screenshot
  // 2026-08-03 17.18.43) asks for an "Emergency Must Knows" section there,
  // built from this same emergency-contact data. Do not "clean up" these
  // fields off `householdDataSchema` or `HOUSEHOLD_FIELD_KEYS` when you don't
  // see a section using them here — that family-page work is what reads them
  // next.
];

/**
 * Every stored field, in the schema's own order (which matches the section
 * order above). Deliberately NOT derived from `HOUSEHOLD_SECTIONS`: two
 * sections were pulled from this screen's catalog above without pulling their
 * fields out of Firestore, and if this stayed `HOUSEHOLD_SECTIONS.flatMap(...)`,
 * `mergeHouseholdRecord` would quietly stop reading those ten fields off an
 * existing household's doc at all, `blankHouseholdRecord` would build an
 * incomplete `HouseholdFields` object, and a create-time save would stop
 * writing them even for brand-new households. None of that is desired: the
 * record in memory should stay complete, just under-rendered, so the
 * family-page "Emergency Must Knows" section (see the removal note above) can
 * read `HouseholdRecord.poisonControlNumber` and friends with no backfill.
 */
export const HOUSEHOLD_FIELD_KEYS: readonly HouseholdFieldKey[] = Object.keys(
  householdDataSchema.shape,
) as HouseholdFieldKey[];

/** The sections the generic text dialog may edit (everything but the vet picker). */
export const EDITABLE_HOUSEHOLD_SECTIONS: readonly HouseholdSectionSpec[] =
  HOUSEHOLD_SECTIONS.filter((s) => s.editor === undefined);

/**
 * The seven free-text vet fields, retired as an authoring surface by A2.
 *
 * Still read, still shown when populated. Never authored with new text: a save
 * only ever clears one of these, never fills it back in. The migration script
 * (`mytribe/scripts/backfillHouseholdVetToKinfolk.ts`) reads exactly this list,
 * so it and the screen cannot drift into disagreeing about what "the old copy"
 * means.
 */
export const LEGACY_VET_FIELD_KEYS: readonly HouseholdFieldKey[] =
  HOUSEHOLD_SECTIONS.find((s) => s.id === 'veterinary')
    ?.fields.filter((f) => f.kind !== 'clinicId')
    .map((f) => f.key) ?? [];

/**
 * The legacy keys for one vet slot ("primary" or "emergency"), the exact set
 * `VetSectionDialog` clears in the same write once that slot links a clinic
 * (issue #677: linking left the old text sitting on the record with no way to
 * clear it, which read as "cannot update vet"), and the subset the leftovers
 * banner's "Clear old vet notes" button can also blank on request.
 */
export function legacyVetKeysForSlot(slot: 'primary' | 'emergency'): HouseholdFieldKey[] {
  const prefix = slot === 'primary' ? 'primaryVet' : 'emergencyVet';
  return LEGACY_VET_FIELD_KEYS.filter((key) => key.startsWith(prefix));
}

/** The legacy vet fields still carrying a value, so leftovers fail loud, not silent. */
export function legacyVetLeftovers(values: HouseholdFields): HouseholdFieldSpec[] {
  const section = HOUSEHOLD_SECTIONS.find((s) => s.id === 'veterinary');
  if (section === undefined) return [];
  return section.fields.filter((f) => f.kind !== 'clinicId' && values[f.key].trim() !== '');
}

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

/** How many of [section]'s fields carry a real value. Drives the "3 of 7 on file" detail line. */
export function sectionFilledCount(section: HouseholdSectionSpec, values: HouseholdFields): number {
  return section.fields.filter((field) => values[field.key].trim() !== '').length;
}
