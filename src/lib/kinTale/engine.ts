/**
 * Conditional-checklist ENGINE for KinTale templates. A {@link ChecklistItem}
 * with no conditions is always shown; with conditions, it is only shown for kin
 * / visits that satisfy ALL of them (AND).
 *
 * This is a direct port of the Compose/wasm `KinTaleConditionEngine.kt` (itself
 * a port of the Android `KinTaleTemplateEngine`), so a template authored on any
 * platform hides/shows the same checklist items for the same visit. The engines
 * MUST stay in lock-step; `engine.test.ts` mirrors the Kotlin
 * `KinTaleConditionEngineTest` case-for-case.
 *
 * FAIL-OPEN: an unknown `source` or `op` (a newer app wrote a value this build
 * does not know) evaluates as "always visible" rather than throwing. Never hide
 * a checklist item because of a parsing gap.
 *
 * I7 EXTENSION: two NEW household condition sources are added on top of the
 * three ported ones, threaded through the evaluation context:
 *   - KINFOLK_ATTRIBUTE, reads a field on the household (kinfolk) the visit
 *     belongs to (see {@link kinfolkAttributeCatalog}).
 *   - KINFOLK_TAG, tests the household's `tags` string list (CONTAINS = a tag is
 *     present; EXISTS = the household has any tag).
 * The original three sources evaluate identically whether or not a kinfolk is
 * supplied.
 */

import {
  ConditionSource,
  ConditionOp,
  type ChecklistItem,
  type FieldCondition,
} from './model';
import type { KinDetail } from '../../api/kinView';
import type { KinfolkProfile } from '../../api/kinfolkProfile';
import type { SessionEntry } from '../../api/sessions';

/**
 * The slice of a session the engine reads (only the service type, for
 * SERVICE_TYPE conditions). Derived from the real `api/sessions.ts#SessionEntry`
 * so a full session row is structurally assignable.
 */
export type ConditionSession = Pick<SessionEntry, 'serviceType'>;

/** Everything one condition evaluates against. */
export interface ConditionContext {
  session: ConditionSession;
  /** The kin under evaluation (null for a PER_VISIT item with no kin). */
  kin: KinDetail | null;
  /** The household the visit belongs to (null when not loaded / not supplied). */
  kinfolk: KinfolkProfile | null;
}

// ── Public API (ported signatures + threaded kinfolk) ────────────────────────

/**
 * Whether a checklist item is visible at all in this session. PER_PET items are
 * visible if ANY kin matches; PER_VISIT items are evaluated once against the
 * first kin (service-type / household rules need no kin at all). The optional
 * `kinfolk` is only consulted by the KINFOLK_* sources; the other three sources
 * behave the same whether it is supplied or not.
 */
export function isChecklistItemVisible(
  item: ChecklistItem,
  session: ConditionSession,
  kinList: readonly KinDetail[],
  kinfolk: KinfolkProfile | null = null,
): boolean {
  if (item.conditions.length === 0) return true;
  if (isPerPet(item.scope)) {
    // PER_PET: visible if ANY kin in the visit matches.
    return kinList.some((kin) => evaluateAll(item.conditions, { session, kin, kinfolk }));
  }
  // PER_VISIT: evaluated once against the first kin (or no kin).
  const first = kinList[0] ?? null;
  return evaluateAll(item.conditions, { session, kin: first, kinfolk });
}

/** For PER_PET items, the subset of kin the item actually applies to (order preserved). */
export function applicableKinForChecklistItem(
  item: ChecklistItem,
  session: ConditionSession,
  kinList: readonly KinDetail[],
  kinfolk: KinfolkProfile | null = null,
): KinDetail[] {
  if (item.conditions.length === 0) return [...kinList];
  return kinList.filter((kin) => evaluateAll(item.conditions, { session, kin, kinfolk }));
}

// ── Evaluation core (private) ────────────────────────────────────────────────

/** Case-insensitive "PER_PET" test, matching the Kotlin `scope.equals(..., ignoreCase)`. */
function isPerPet(scope: string): boolean {
  return scope.toLowerCase() === 'per_pet';
}

function evaluateAll(conditions: readonly FieldCondition[], ctx: ConditionContext): boolean {
  return conditions.every((c) => evaluate(c, ctx));
}

function evaluate(c: FieldCondition, ctx: ConditionContext): boolean {
  const source = parseSource(c.source);
  if (source === null) return true; // fail-open on unknown source
  const op = parseOp(c.op);
  if (op === null) return true; // fail-open on unknown op

  // KINFOLK_TAG compares against a list, not a single string.
  if (source === ConditionSource.KINFOLK_TAG) {
    return matchesTag(ctx.kinfolk?.tags ?? [], c.value, op);
  }
  return matches(actualFor(source, c, ctx), c.value, op);
}

/** The single string value a (non-tag) source resolves to. */
function actualFor(source: ConditionSource, c: FieldCondition, ctx: ConditionContext): string {
  switch (source) {
    case ConditionSource.SERVICE_TYPE:
      return ctx.session.serviceType ?? '';
    case ConditionSource.KIN_SPECIES:
      return ctx.kin?.species ?? '';
    case ConditionSource.KIN_ATTRIBUTE:
      return ctx.kin ? readAttribute(ctx.kin, c.attributeKey) : '';
    case ConditionSource.KINFOLK_ATTRIBUTE:
      return ctx.kinfolk ? readKinfolkAttribute(ctx.kinfolk, c.attributeKey) : '';
    case ConditionSource.KINFOLK_TAG:
      return ''; // handled by evaluate() before reaching here
  }
}

/** String comparison, case-insensitive and trimmed, matching the Kotlin `matches`. */
function matches(actual: string, expected: string, op: ConditionOp): boolean {
  const a = actual.trim();
  const e = expected.trim();
  switch (op) {
    case ConditionOp.EQUALS:
      return a.toLowerCase() === e.toLowerCase();
    case ConditionOp.NOT_EQUALS:
      return a.toLowerCase() !== e.toLowerCase();
    case ConditionOp.CONTAINS:
      return a.toLowerCase().includes(e.toLowerCase());
    case ConditionOp.EXISTS:
      return a !== '' && a.toLowerCase() !== 'false';
  }
}

/**
 * Tag-list comparison for KINFOLK_TAG. CONTAINS (and EQUALS) = a tag equal to
 * `expected` is present (case-insensitive); EXISTS = the household has any
 * non-blank tag; NOT_EQUALS = that tag is absent.
 */
function matchesTag(tags: readonly string[], expected: string, op: ConditionOp): boolean {
  const e = expected.trim().toLowerCase();
  const present = tags.some((t) => t.trim().toLowerCase() === e);
  switch (op) {
    case ConditionOp.EXISTS:
      return tags.some((t) => t.trim() !== '');
    case ConditionOp.NOT_EQUALS:
      return !present;
    case ConditionOp.EQUALS:
    case ConditionOp.CONTAINS:
      return present;
  }
}

/**
 * Maps a catalogued KIN attribute key to its value on the kin. MUST cover every
 * key in {@link conditionAttributeCatalog} (guarded by the engine test) so the
 * editor can never offer a key the engine reads as blank. Booleans stringify to
 * "true"/"false" (matching Kotlin `Boolean.toString()`), so EXISTS treats a
 * `false` boolean as absent.
 */
function readAttribute(kin: KinDetail, key: string): string {
  switch (key) {
    case 'medicationHealthNotes':
      return kin.medicationHealthNotes;
    case 'vaccinations':
      return kin.vaccinations;
    case 'vetInfo':
      return kin.vetInfo;
    case 'feedingBrand':
      return kin.feedingBrand;
    case 'trainingCommands':
      return kin.trainingCommands;
    case 'routine':
      return kin.routine;
    case 'checklist':
      return kin.checklist;
    case 'reactive':
      return String(kin.reactive);
    case 'spayedNeutered':
      return String(kin.spayedNeutered);
    case 'officeNotes':
      return kin.officeNotes;
    case 'colorMarkings':
      return kin.colorMarkings;
    default:
      return '';
  }
}

/**
 * Maps a catalogued KINFOLK (household) attribute key to its value. MUST cover
 * every key in {@link kinfolkAttributeCatalog} (guarded by the engine test).
 */
function readKinfolkAttribute(kinfolk: KinfolkProfile, key: string): string {
  switch (key) {
    case 'serviceAddress':
      return kinfolk.serviceAddress;
    case 'gateCode':
      return kinfolk.gateCode;
    case 'parkingInstructions':
      return kinfolk.parkingInstructions;
    case 'entryNotes':
      return kinfolk.entryNotes;
    case 'emergencyContactName':
      return kinfolk.emergencyContactName;
    case 'emergencyContactPhone':
      return kinfolk.emergencyContactPhone;
    case 'vetClinicName':
      return kinfolk.vetClinicName;
    default:
      return '';
  }
}

// ── Safe enum parsing (fail-open helpers) ────────────────────────────────────

const SOURCE_NAMES: readonly ConditionSource[] = [
  ConditionSource.KIN_SPECIES,
  ConditionSource.KIN_ATTRIBUTE,
  ConditionSource.SERVICE_TYPE,
  ConditionSource.KINFOLK_ATTRIBUTE,
  ConditionSource.KINFOLK_TAG,
];

const OP_NAMES: readonly ConditionOp[] = [
  ConditionOp.EQUALS,
  ConditionOp.NOT_EQUALS,
  ConditionOp.CONTAINS,
  ConditionOp.EXISTS,
];

function parseSource(name: string): ConditionSource | null {
  return (SOURCE_NAMES as readonly string[]).includes(name) ? (name as ConditionSource) : null;
}

function parseOp(name: string): ConditionOp | null {
  return (OP_NAMES as readonly string[]).includes(name) ? (name as ConditionOp) : null;
}

// ── Editor-facing catalogs + helpers ─────────────────────────────────────────

/** A catalogued attribute an operator can build a condition on. */
export interface ConditionAttribute {
  key: string;
  label: string;
}

/**
 * The canonical list of KIN attributes the condition editor offers. Single
 * source of truth: every key here must be readable by {@link readAttribute}
 * (asserted in the engine test) so the editor never offers a key the engine
 * reads as blank. Ported verbatim from the Kotlin `conditionAttributeCatalog`.
 */
export const conditionAttributeCatalog: readonly ConditionAttribute[] = [
  { key: 'medicationHealthNotes', label: 'Medication / health notes' },
  { key: 'vaccinations', label: 'Vaccinations' },
  { key: 'vetInfo', label: 'Vet info' },
  { key: 'feedingBrand', label: 'Feeding brand' },
  { key: 'trainingCommands', label: 'Training commands' },
  { key: 'routine', label: 'Routine' },
  { key: 'checklist', label: 'Care checklist' },
  { key: 'reactive', label: 'Reactive' },
  { key: 'spayedNeutered', label: 'Spayed / neutered' },
  { key: 'officeNotes', label: 'Office notes' },
  { key: 'colorMarkings', label: 'Color / markings' },
];

/**
 * I7: the canonical list of KINFOLK (household) attributes the editor offers for
 * a KINFOLK_ATTRIBUTE condition. Every key must be readable by
 * {@link readKinfolkAttribute} (asserted in the engine test). Fields are drawn
 * from `api/kinfolkProfile.ts#KinfolkProfile` (the household detail read); only
 * fields the engine can actually resolve are listed.
 */
export const kinfolkAttributeCatalog: readonly ConditionAttribute[] = [
  { key: 'serviceAddress', label: 'Service address' },
  { key: 'gateCode', label: 'Gate code' },
  { key: 'parkingInstructions', label: 'Parking instructions' },
  { key: 'entryNotes', label: 'Entry notes' },
  { key: 'emergencyContactName', label: 'Emergency contact' },
  { key: 'emergencyContactPhone', label: 'Emergency contact phone' },
  { key: 'vetClinicName', label: 'Vet on file' },
];

/** One selectable condition source, for the editor's source picker. */
export interface ConditionSourceOption {
  source: ConditionSource;
  label: string;
}

/** The full list of sources the editor offers, including the two I7 household sources. */
export const conditionSourceOptions: readonly ConditionSourceOption[] = [
  { source: ConditionSource.KIN_SPECIES, label: "Pet's species" },
  { source: ConditionSource.KIN_ATTRIBUTE, label: 'Pet attribute' },
  { source: ConditionSource.SERVICE_TYPE, label: 'Service type' },
  { source: ConditionSource.KINFOLK_ATTRIBUTE, label: 'Household attribute' },
  { source: ConditionSource.KINFOLK_TAG, label: 'Household tag' },
];

/**
 * Editor helper: whether this source picks an attribute key (so the editor shows
 * the attribute dropdown). True for KIN_ATTRIBUTE and, per I7, KINFOLK_ATTRIBUTE.
 * Unknown sources do not, matching the fail-open engine default.
 */
export function conditionUsesAttributeKey(sourceName: string): boolean {
  return (
    sourceName === ConditionSource.KIN_ATTRIBUTE ||
    sourceName === ConditionSource.KINFOLK_ATTRIBUTE
  );
}

/**
 * Editor helper: whether this op compares against a typed value (so the editor
 * shows the value field). EXISTS needs no value; every other op, including a
 * forward-compatible unknown one, does.
 */
export function conditionUsesValueInput(opName: string): boolean {
  return opName !== ConditionOp.EXISTS;
}

/**
 * A human-readable, kinfolk-safe summary of one condition, rendered under the
 * checklist item in the editor. Falls back to a neutral label for a
 * forward-compatible unknown enum value.
 */
export function conditionSummary(c: FieldCondition): string {
  const source = parseSource(c.source);
  const op = parseOp(c.op);
  if (source === null || op === null) return 'Custom condition';

  const value = c.value.trim() === '' ? '(blank)' : c.value.trim();

  if (source === ConditionSource.KIN_ATTRIBUTE) {
    const label = attributeLabel(conditionAttributeCatalog, c.attributeKey);
    switch (op) {
      case ConditionOp.EXISTS:
        return `Only show when the pet has ${label}`;
      case ConditionOp.EQUALS:
        return `Only show when the pet's ${label} is ${value}`;
      case ConditionOp.NOT_EQUALS:
        return `Only show when the pet's ${label} is not ${value}`;
      case ConditionOp.CONTAINS:
        return `Only show when the pet's ${label} contains ${value}`;
    }
  }

  if (source === ConditionSource.KINFOLK_ATTRIBUTE) {
    const label = attributeLabel(kinfolkAttributeCatalog, c.attributeKey);
    switch (op) {
      case ConditionOp.EXISTS:
        return `Only show when the household's ${label} is set`;
      case ConditionOp.EQUALS:
        return `Only show when the household's ${label} is ${value}`;
      case ConditionOp.NOT_EQUALS:
        return `Only show when the household's ${label} is not ${value}`;
      case ConditionOp.CONTAINS:
        return `Only show when the household's ${label} contains ${value}`;
    }
  }

  if (source === ConditionSource.KINFOLK_TAG) {
    switch (op) {
      case ConditionOp.EXISTS:
        return 'Only show when the household has any tags';
      case ConditionOp.NOT_EQUALS:
        return `Only show when the household is not tagged ${value}`;
      case ConditionOp.EQUALS:
      case ConditionOp.CONTAINS:
        return `Only show when the household is tagged ${value}`;
    }
  }

  // KIN_SPECIES / SERVICE_TYPE generic branch.
  const subject = source === ConditionSource.KIN_SPECIES ? "the pet's species" : 'the service type';
  switch (op) {
    case ConditionOp.EQUALS:
      return `Only show when ${subject} is ${value}`;
    case ConditionOp.NOT_EQUALS:
      return `Only show when ${subject} is not ${value}`;
    case ConditionOp.CONTAINS:
      return `Only show when ${subject} contains ${value}`;
    case ConditionOp.EXISTS:
      return `Only show when ${subject} is set`;
  }
}

function attributeLabel(catalog: readonly ConditionAttribute[], key: string): string {
  const found = catalog.find((a) => a.key === key);
  if (found) return found.label;
  return key.trim() === '' ? 'an attribute' : key;
}
