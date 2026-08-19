/**
 * KinTale template MODEL, a faithful TypeScript port of the Compose/wasm
 * `KinTaleModels.kt`
 * (composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/data/KinTaleModels.kt).
 *
 * This is the visit-recap / checklist template stored in the `kintale_templates`
 * Firestore collection. It is DELIBERATELY a different thing from the EMAIL
 * template concept (`api/templates.ts#TemplateSection` / the `emailTemplates`
 * surface); do not conflate them.
 *
 * The shapes here round-trip byte-for-byte with the Compose/android apps, so a
 * template authored on any platform renders the same recap and hides/shows the
 * same checklist items (see `engine.ts`).
 *
 * Enums are modeled as a string-literal union PLUS a same-named `const` object
 * of the literal names (the string-backed pattern). This mirrors the Kotlin
 * enums, which are serialized by `.name`: an UNKNOWN value read from a doc a
 * newer app wrote survives as a plain `string` on `FieldCondition.source`/`op`
 * (and `ChecklistItem.scope`) rather than throwing. The engine's fail-open
 * evaluation depends on that.
 */

// ── Enums (string-backed unions + name constants) ────────────────────────────

export type ConditionSource =
  | 'KIN_SPECIES'
  | 'KIN_ATTRIBUTE'
  | 'SERVICE_TYPE'
  | 'KINFOLK_ATTRIBUTE'
  | 'KINFOLK_TAG';

export const ConditionSource = {
  KIN_SPECIES: 'KIN_SPECIES',
  KIN_ATTRIBUTE: 'KIN_ATTRIBUTE',
  SERVICE_TYPE: 'SERVICE_TYPE',
  /** I7: evaluates against the KINFOLK (household) the visit belongs to. */
  KINFOLK_ATTRIBUTE: 'KINFOLK_ATTRIBUTE',
  /** I7: evaluates against the household's `tags` string list. */
  KINFOLK_TAG: 'KINFOLK_TAG',
} as const satisfies Record<string, ConditionSource>;

export type ConditionOp = 'EQUALS' | 'NOT_EQUALS' | 'CONTAINS' | 'EXISTS';

export const ConditionOp = {
  EQUALS: 'EQUALS',
  NOT_EQUALS: 'NOT_EQUALS',
  CONTAINS: 'CONTAINS',
  EXISTS: 'EXISTS',
} as const satisfies Record<string, ConditionOp>;

export type ChecklistScope = 'PER_PET' | 'PER_VISIT';

export const ChecklistScope = {
  PER_PET: 'PER_PET',
  PER_VISIT: 'PER_VISIT',
} as const satisfies Record<string, ChecklistScope>;

// ── Model types (mirroring KinTaleModels.kt) ─────────────────────────────────

/**
 * One conditional-visibility rule on a {@link ChecklistItem}. `source`/`op` are
 * plain strings holding a {@link ConditionSource} / {@link ConditionOp} name, so
 * the Firestore doc is byte-for-byte compatible with the Kotlin model and an
 * unknown enum value from a newer app survives forward-compatibly (evaluated as
 * "always visible", never thrown; see `engine.ts`).
 */
export interface FieldCondition {
  source: string;
  op: string;
  value: string;
  /** Which attribute, when source is KIN_ATTRIBUTE or KINFOLK_ATTRIBUTE. */
  attributeKey: string;
}

/**
 * One checklist row on a template. `conditions` empty = always shown; otherwise
 * the item only appears for kin / visits satisfying ALL of them (AND). `scope`
 * is a plain string ("PER_PET" | "PER_VISIT") so an unknown value survives; the
 * engine treats anything that is not case-insensitively "PER_PET" as PER_VISIT,
 * matching the Kotlin engine.
 */
export interface ChecklistItem {
  key: string;
  text: string;
  scope: string;
  /** Precise semantics: unchecked -> hidden in the sent KinTale (default false). */
  showWhenUnchecked: boolean;
  required: boolean;
  order: number;
  conditions: FieldCondition[];
}

export interface MoodOption {
  key: string;
  label: string;
  emoji: string;
  order: number;
}

/**
 * KinTaleTemplate: the dynamic shape of a visit recap (which sections are on,
 * which checklist items appear, etc.). Mirrors the Kotlin `KinTaleTemplate`
 * data class field-for-field so `kintale_templates` docs round-trip cleanly
 * between platforms.
 */
export interface KinTaleTemplate {
  _id: string;
  name: string;
  description: string;
  defaultEmailMessage: string;
  serviceTypeKeys: string[];
  isActive: boolean;
  isDefault: boolean;

  photoShowcaseEnabled: boolean;
  checklistEnabled: boolean;
  petMoodEnabled: boolean;
  visitNotesEnabled: boolean;
  nextAppointmentEnabled: boolean;
  reviewBoosterEnabled: boolean;

  checklistItems: ChecklistItem[];
  moodOptions: MoodOption[];

  createdAt: string;
  updatedAt: string;
}

/** One captured answer for a rendered field. Mirrors the Kotlin `FieldResponse`. */
export interface FieldResponse {
  fieldKey: string;
  kinId: string;
  sectionKey: string;
  boolValue: boolean | null;
  intValue: number | null;
  stringValue: string;
  mediaIds: string[];
}

// ── Default-value builders (encode the Kotlin data-class defaults) ────────────
//
// The Kotlin models rely on data-class default values when a Firestore doc omits
// a field. TypeScript has no such thing, so these `make*` helpers carry the same
// defaults in one place: the editor (piece 2) uses them to add new rows, and the
// decode layer uses them to fill a partial doc.

/** Kotlin `FieldCondition` defaults: source KIN_SPECIES, op EQUALS, blanks. */
export function makeFieldCondition(over: Partial<FieldCondition> = {}): FieldCondition {
  return {
    source: ConditionSource.KIN_SPECIES,
    op: ConditionOp.EQUALS,
    value: '',
    attributeKey: '',
    ...over,
  };
}

/** Kotlin `ChecklistItem` defaults: PER_PET, not required, shown-when-unchecked false, no conditions. */
export function makeChecklistItem(over: Partial<ChecklistItem> = {}): ChecklistItem {
  return {
    key: '',
    text: '',
    scope: ChecklistScope.PER_PET,
    showWhenUnchecked: false,
    required: false,
    order: 0,
    conditions: [],
    ...over,
  };
}

/** Kotlin `MoodOption` defaults: blank key/label/emoji, order 0. */
export function makeMoodOption(over: Partial<MoodOption> = {}): MoodOption {
  return { key: '', label: '', emoji: '', order: 0, ...over };
}

// Positional wrappers used purely to keep the default table below readable.
function ci(
  key: string,
  text: string,
  scope: ChecklistScope,
  order: number,
  required = false,
): ChecklistItem {
  return makeChecklistItem({ key, text, scope, order, required });
}

function mo(key: string, label: string, emoji: string, order: number): MoodOption {
  return makeMoodOption({ key, label, emoji, order });
}

// ── DefaultKinTaleTemplate (ported exactly from KinTaleModels.kt) ─────────────

/** Matches Kotlin `DefaultKinTaleTemplate.ID`. */
export const DEFAULT_KINTALE_TEMPLATE_ID = '__builtin_default__';

/**
 * Built-in fallback template, used when no `kintale_templates` doc matches the
 * session's service type. Kept identical to the Kotlin/Android default so a
 * session scaffolded on either platform produces the same shape.
 */
export const DEFAULT_KINTALE_TEMPLATE: KinTaleTemplate = {
  _id: DEFAULT_KINTALE_TEMPLATE_ID,
  name: 'Default KinTale',
  description: "Catch-all template for any service type that doesn't have its own.",
  // Deliberately blank. Mark 23 of the 2026-08-17 walk: a canned default here
  // invited Auntie to send it unedited, when the message is meant to be the
  // story of THIS visit. Blank on the shared constant so every path that reads
  // it -- a fresh draft, decode of a doc that never had the field, the Android
  // data-class default -- starts empty too. A template's own SAVED message is
  // untouched either way: decode always reads the doc's stored field first.
  defaultEmailMessage: '',
  serviceTypeKeys: [],
  isActive: true,
  isDefault: true,

  photoShowcaseEnabled: true,
  checklistEnabled: true,
  petMoodEnabled: true,
  visitNotesEnabled: true,
  nextAppointmentEnabled: true,
  reviewBoosterEnabled: false,

  checklistItems: [
    // Per-pet items
    ci('peed', 'Peed', ChecklistScope.PER_PET, 0, true),
    ci('pooed', 'Pooed', ChecklistScope.PER_PET, 1, true),
    ci('fed', 'Fed', ChecklistScope.PER_PET, 2),
    ci('water', 'Fresh water provided', ChecklistScope.PER_PET, 3),
    ci('meds', 'Medications given', ChecklistScope.PER_PET, 4),
    ci('play', 'Playtime provided', ChecklistScope.PER_PET, 5),
    // Per-visit items
    ci('secure', 'House / yard secure', ChecklistScope.PER_VISIT, 0),
    ci('locked', 'All doors locked', ChecklistScope.PER_VISIT, 1),
    ci('alarm', 'Alarm system set', ChecklistScope.PER_VISIT, 2),
    ci('mail', 'Mail / packages collected', ChecklistScope.PER_VISIT, 3),
    ci('plants', 'Plants watered', ChecklistScope.PER_VISIT, 4),
    ci('trash', 'Trash taken out', ChecklistScope.PER_VISIT, 5),
  ],

  moodOptions: [
    mo('happy', 'Happy', '😊', 0),
    mo('playful', 'Playful', '🐾', 1),
    mo('calm', 'Calm', '😌', 2),
    mo('cuddly', 'Cuddly', '🤗', 3),
    mo('anxious', 'Anxious', '😟', 4),
    mo('shy', 'Shy', '🙈', 5),
    mo('energetic', 'Energetic', '⚡', 6),
    mo('sleepy', 'Sleepy', '😴', 7),
  ],

  createdAt: '',
  updatedAt: '',
};

/**
 * Composite response key matching the Kotlin `responseKey(fieldKey, kinId)`, so
 * captured answers round-trip. Bare `fieldKey` when kinId is blank, else
 * `"$kinId|$fieldKey"`.
 */
export function responseKey(fieldKey: string, kinId: string): string {
  return kinId.trim() === '' ? fieldKey : `${kinId}|${fieldKey}`;
}
