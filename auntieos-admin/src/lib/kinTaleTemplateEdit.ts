import {
  DEFAULT_KINTALE_TEMPLATE,
  ConditionOp,
  ConditionSource,
  makeChecklistItem,
  makeFieldCondition,
  makeMoodOption,
  type ChecklistItem,
  type FieldCondition,
  type KinTaleTemplate,
  type MoodOption,
} from './kinTale/model';
import {
  conditionAttributeCatalog,
  kinfolkAttributeCatalog,
  type ConditionAttribute,
} from './kinTale/engine';

/**
 * Pure, unit-tested transforms behind the KinTale template editor
 * (`screens/KinTaleTemplates.tsx`). Every mutation the editor performs (add /
 * remove / reorder a checklist item, edit its conditions, edit mood options,
 * parse the service-type list) lives here as a data-in / data-out function, so
 * the screen stays a thin render + wiring layer and the interesting logic is
 * tested without a DOM. Ports the private helpers of the Compose
 * `KinTaleTemplateEditorScreen.kt` (reorderWithinScope, freshKey, freshMoodKey,
 * the condition-source defaulting) and extends the condition editing to the two
 * new I7 household sources.
 */

// ── checklist scope ──────────────────────────────────────────────────────────

/** Case-insensitive PER_PET test, matching the engine's own `isPerPet`. */
export function isPerPetScope(scope: string): boolean {
  return scope.toLowerCase() === 'per_pet';
}

/** The PER_PET items, ordered by `order` (the editor's per-pet section). */
export function perPetItems(items: readonly ChecklistItem[]): ChecklistItem[] {
  return items.filter((i) => isPerPetScope(i.scope)).sort((a, b) => a.order - b.order);
}

/** The PER_VISIT items, ordered by `order` (anything not case-insensitively PER_PET). */
export function perVisitItems(items: readonly ChecklistItem[]): ChecklistItem[] {
  return items.filter((i) => !isPerPetScope(i.scope)).sort((a, b) => a.order - b.order);
}

// ── checklist item add / update / remove / reorder ───────────────────────────

/** A fresh, collision-free `item_N` key across ALL items (Compose `freshKey`). */
export function freshChecklistKey(items: readonly ChecklistItem[]): string {
  let i = 1;
  while (items.some((it) => it.key === `item_${i}`)) i++;
  return `item_${i}`;
}

/** Next `order` for a new item in this scope: max existing + 1, or 0 when the scope is empty. */
export function nextOrderForScope(items: readonly ChecklistItem[], scope: string): number {
  const inScope = items.filter((i) => isPerPetScope(i.scope) === isPerPetScope(scope));
  return inScope.reduce((max, i) => Math.max(max, i.order), -1) + 1;
}

/** Append a blank item to the given scope. Scope is fixed at creation (the two sections each own their add). */
export function addChecklistItem(items: readonly ChecklistItem[], scope: string): ChecklistItem[] {
  return [
    ...items,
    makeChecklistItem({ key: freshChecklistKey(items), scope, order: nextOrderForScope(items, scope) }),
  ];
}

/** Patch the one item matching (key, scope). */
export function updateChecklistItem(
  items: readonly ChecklistItem[],
  key: string,
  scope: string,
  patch: Partial<ChecklistItem>,
): ChecklistItem[] {
  return items.map((it) => (it.key === key && it.scope === scope ? { ...it, ...patch } : it));
}

/** Drop the one item matching (key, scope). */
export function removeChecklistItem(
  items: readonly ChecklistItem[],
  key: string,
  scope: string,
): ChecklistItem[] {
  return items.filter((it) => !(it.key === key && it.scope === scope));
}

/**
 * Move an item one step within its own scope by swapping `order` with its
 * neighbour. `delta` is -1 (earlier) or +1 (later); a no-op at the ends. Ported
 * verbatim from Compose `reorderWithinScope`.
 */
export function reorderChecklistItem(
  items: readonly ChecklistItem[],
  key: string,
  scope: string,
  delta: number,
): ChecklistItem[] {
  const sameScope = items
    .filter((i) => isPerPetScope(i.scope) === isPerPetScope(scope))
    .sort((a, b) => a.order - b.order);
  const idx = sameScope.findIndex((i) => i.key === key);
  if (idx < 0) return [...items];
  const swapWith = idx + delta;
  if (swapWith < 0 || swapWith >= sameScope.length) return [...items];
  const a = sameScope[idx]!;
  const b = sameScope[swapWith]!;
  return items.map((it) => {
    if (it.key === a.key && it.scope === a.scope) return { ...it, order: b.order };
    if (it.key === b.key && it.scope === b.scope) return { ...it, order: a.order };
    return it;
  });
}

// ── condition editing (the I7 payload) ───────────────────────────────────────

/**
 * The attribute catalog a source's key dropdown draws from: kin attributes for
 * KIN_ATTRIBUTE, household attributes for KINFOLK_ATTRIBUTE, and none for every
 * other source (which shows no attribute dropdown).
 */
export function attributeCatalogForSource(source: string): readonly ConditionAttribute[] {
  if (source === ConditionSource.KIN_ATTRIBUTE) return conditionAttributeCatalog;
  if (source === ConditionSource.KINFOLK_ATTRIBUTE) return kinfolkAttributeCatalog;
  return [];
}

/**
 * Switch a condition to a new source, keeping the rule VALID by construction.
 * When the new source needs an attribute key (KIN_ATTRIBUTE / KINFOLK_ATTRIBUTE)
 * and the current key is not in that source's catalog (blank, or left over from
 * the OTHER attribute source), it is reset to the catalog's first entry so the
 * rule never points at an attribute the engine would read as blank. Extends the
 * Compose defaulting, which only handled KIN_ATTRIBUTE and only the blank case.
 */
export function changeConditionSource(cond: FieldCondition, source: string): FieldCondition {
  const catalog = attributeCatalogForSource(source);
  if (catalog.length === 0) return { ...cond, source };
  const valid = catalog.some((a) => a.key === cond.attributeKey);
  return { ...cond, source, attributeKey: valid ? cond.attributeKey : catalog[0]!.key };
}

/** Append a fresh KIN_SPECIES / EQUALS condition (Compose's "Add condition" default). */
export function addCondition(conditions: readonly FieldCondition[]): FieldCondition[] {
  return [...conditions, makeFieldCondition()];
}

/** Patch the condition at `idx`. */
export function updateCondition(
  conditions: readonly FieldCondition[],
  idx: number,
  next: FieldCondition,
): FieldCondition[] {
  return conditions.map((c, i) => (i === idx ? next : c));
}

/** Remove the condition at `idx`. */
export function removeCondition(conditions: readonly FieldCondition[], idx: number): FieldCondition[] {
  return conditions.filter((_, i) => i !== idx);
}

/** Human label for the op picker. Falls back to the raw name for a forward-compatible unknown op. */
export function opLabel(op: string): string {
  switch (op) {
    case ConditionOp.EQUALS:
      return 'is';
    case ConditionOp.NOT_EQUALS:
      return 'is not';
    case ConditionOp.CONTAINS:
      return 'contains';
    case ConditionOp.EXISTS:
      return 'is set';
    default:
      return op;
  }
}

/** Placeholder for the value input, tuned per source (Compose `valuePlaceholder`). */
export function valuePlaceholder(source: string): string {
  switch (source) {
    case ConditionSource.KIN_SPECIES:
      return 'e.g. Cat';
    case ConditionSource.SERVICE_TYPE:
      return 'e.g. walk';
    case ConditionSource.KINFOLK_TAG:
      return 'e.g. VIP';
    default:
      return 'Value to match';
  }
}

// ── mood options ─────────────────────────────────────────────────────────────

/** A fresh, collision-free `mood_N` key (Compose `freshMoodKey`). */
export function freshMoodKey(moods: readonly MoodOption[]): string {
  let i = 1;
  while (moods.some((m) => m.key === `mood_${i}`)) i++;
  return `mood_${i}`;
}

/** Append a blank mood at the next order. */
export function addMood(moods: readonly MoodOption[]): MoodOption[] {
  const nextOrder = moods.reduce((max, m) => Math.max(max, m.order), -1) + 1;
  return [...moods, makeMoodOption({ key: freshMoodKey(moods), order: nextOrder })];
}

/** Patch the mood matching `key`. */
export function updateMood(
  moods: readonly MoodOption[],
  key: string,
  patch: Partial<MoodOption>,
): MoodOption[] {
  return moods.map((m) => (m.key === key ? { ...m, ...patch } : m));
}

/** Drop the mood matching `key`. */
export function removeMood(moods: readonly MoodOption[], key: string): MoodOption[] {
  return moods.filter((m) => m.key !== key);
}

/**
 * Move a mood one step by swapping `order` with its neighbour in display order.
 * `delta` is -1 (earlier) or +1 (later); a no-op at the ends. Same swap shape as
 * `reorderChecklistItem` (moods have no scope, so the whole list is one group).
 */
export function reorderMood(moods: readonly MoodOption[], key: string, delta: number): MoodOption[] {
  const ordered = sortedMoods(moods);
  const idx = ordered.findIndex((m) => m.key === key);
  if (idx < 0) return [...moods];
  const swapWith = idx + delta;
  if (swapWith < 0 || swapWith >= ordered.length) return [...moods];
  const a = ordered[idx]!;
  const b = ordered[swapWith]!;
  return moods.map((m) => {
    if (m.key === a.key) return { ...m, order: b.order };
    if (m.key === b.key) return { ...m, order: a.order };
    return m;
  });
}

/** Moods ordered by `order`, for stable rendering. */
export function sortedMoods(moods: readonly MoodOption[]): MoodOption[] {
  return [...moods].sort((a, b) => a.order - b.order);
}

// ── service-type keys (comma-separated editing) ──────────────────────────────

/** The service-type keys as a single comma-separated field value. */
export function serviceKeysToText(keys: readonly string[]): string {
  return keys.join(', ');
}

/** Parse the comma-separated field back into a trimmed, non-empty key list. */
export function textToServiceKeys(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ── new-template drafts ──────────────────────────────────────────────────────

/** Deep-clone the built-in default so editing a draft never mutates the shared constant. */
function cloneDefaultTemplate(): KinTaleTemplate {
  return {
    ...DEFAULT_KINTALE_TEMPLATE,
    serviceTypeKeys: [...DEFAULT_KINTALE_TEMPLATE.serviceTypeKeys],
    checklistItems: DEFAULT_KINTALE_TEMPLATE.checklistItems.map((i) => ({
      ...i,
      conditions: i.conditions.map((c) => ({ ...c })),
    })),
    moodOptions: DEFAULT_KINTALE_TEMPLATE.moodOptions.map((m) => ({ ...m })),
  };
}

/**
 * The draft used the FIRST time the editor opens against an empty collection:
 * the built-in default, unsaved (`_id: ''`) so Save creates the Den's first real
 * template. Keeps the default's name + `isDefault: true`. Mirrors the Compose
 * seed `DefaultKinTaleTemplate.template.copy(_id = "")`.
 */
export function seedTemplateDraft(): KinTaleTemplate {
  return { ...cloneDefaultTemplate(), _id: '', createdAt: '', updatedAt: '' };
}

/**
 * The draft "New template" creates: the built-in default shape, unsaved, renamed,
 * and NOT default (a brand-new template should not silently steal the default
 * flag). Mirrors the Compose `onAddNew` copy.
 */
export function newTemplateDraft(): KinTaleTemplate {
  return {
    ...cloneDefaultTemplate(),
    _id: '',
    name: 'New template',
    isDefault: false,
    createdAt: '',
    updatedAt: '',
  };
}
