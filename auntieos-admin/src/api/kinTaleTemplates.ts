import { type CollectionSpec } from '../lib/firestore';
import {
  DEFAULT_KINTALE_TEMPLATE,
  DEFAULT_KINTALE_TEMPLATE_ID,
  makeChecklistItem,
  makeFieldCondition,
  makeMoodOption,
  type ChecklistItem,
  type FieldCondition,
  type KinTaleTemplate,
  type MoodOption,
} from '../lib/kinTale/model';

/**
 * READ layer for the `kintale_templates` collection: the bounded live query the
 * KinTale template editor subscribes to, plus the defensive decode that turns a
 * raw Firestore doc into a fully-populated {@link KinTaleTemplate}.
 *
 * There is NO callable for this collection (confirmed: nothing named
 * `listKinTaleTemplates` / `saveKinTaleTemplate` exists under
 * `MyTribe/functions/src`; the only reads are the client streams in the Compose
 * `FirestoreClient.templatesStream()` and Android `AuntieRepository`). The rule
 * `match /kintale_templates/{id} { read: if isAuntie() || isTestAdmin(); write:
 * if isAuntie() }` (MyTribe/firestore.rules) means the admin reads + writes this
 * collection DIRECTLY from the client SDK, exactly like `kin_care_reports`
 * (`api/kinTalesWrite.ts`). So the editor subscribes via `useCollection` and the
 * write half lives in `api/kinTaleTemplatesWrite.ts`.
 */

/**
 * The live template query. `useCollection` REQUIRES an order + a hard cap (every
 * listener the admin opens is bounded + server-ordered by construction, closing
 * AO-29). We order by `name` asc for a stable, human-legible picker; every writer
 * on every platform always stamps `name` (Kotlin data-class default `""`, and our
 * own `saveKinTaleTemplate` always includes it), so no doc is dropped by the
 * orderBy. 200 is far above any realistic template count for a single Den.
 */
export const KINTALE_TEMPLATES_QUERY: CollectionSpec = {
  path: 'kintale_templates',
  order: ['name', 'asc'],
  max: 200,
};

// ── defensive field readers ──────────────────────────────────────────────────
//
// A `kintale_templates` doc can be partial: an older app wrote it before a field
// existed, or it was hand-edited. Kotlin fills a missing field with the
// data-class default; TypeScript has no such thing, so decode does it by hand,
// carrying the SAME defaults as `KinTaleModels.kt`'s `KinTaleTemplate` /
// `ChecklistItem` / `FieldCondition` / `MoodOption` data classes.

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function readString(o: Record<string, unknown>, key: string, fallback = ''): string {
  const v = o[key];
  return typeof v === 'string' ? v : fallback;
}

function readBool(o: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = o[key];
  return typeof v === 'boolean' ? v : fallback;
}

function readInt(o: Record<string, unknown>, key: string, fallback = 0): number {
  const v = o[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function readStringArray(o: Record<string, unknown>, key: string): string[] {
  const v = o[key];
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

function readArray(o: Record<string, unknown>, key: string): unknown[] {
  const v = o[key];
  return Array.isArray(v) ? v : [];
}

// ── nested decoders (use the piece-1 make* helpers for defaults) ─────────────

/** One condition, forward-compatibly: unknown `source`/`op` survive as plain strings (the engine fails open on them). */
export function decodeFieldCondition(raw: unknown): FieldCondition {
  const o = asRecord(raw);
  return makeFieldCondition({
    source: readString(o, 'source', makeFieldCondition().source),
    op: readString(o, 'op', makeFieldCondition().op),
    value: readString(o, 'value'),
    attributeKey: readString(o, 'attributeKey'),
  });
}

export function decodeChecklistItem(raw: unknown): ChecklistItem {
  const o = asRecord(raw);
  const base = makeChecklistItem();
  return makeChecklistItem({
    key: readString(o, 'key'),
    text: readString(o, 'text'),
    scope: readString(o, 'scope', base.scope),
    showWhenUnchecked: readBool(o, 'showWhenUnchecked', base.showWhenUnchecked),
    required: readBool(o, 'required', base.required),
    order: readInt(o, 'order'),
    conditions: readArray(o, 'conditions').map(decodeFieldCondition),
  });
}

export function decodeMoodOption(raw: unknown): MoodOption {
  const o = asRecord(raw);
  return makeMoodOption({
    key: readString(o, 'key'),
    label: readString(o, 'label'),
    emoji: readString(o, 'emoji'),
    order: readInt(o, 'order'),
  });
}

/**
 * Turn a raw `kintale_templates` doc (from `useCollection`, so it already carries
 * `_id`) into a fully-populated {@link KinTaleTemplate}. Every field defaults to
 * its Kotlin data-class default, NOT to the built-in `DEFAULT_KINTALE_TEMPLATE`
 * body: a doc that omits `checklistItems` decodes to an EMPTY list (the
 * data-class default), never to the 12 built-in rows, matching how the Kotlin
 * apps decode the same doc.
 */
export function decodeKinTaleTemplate(raw: unknown): KinTaleTemplate {
  const o = asRecord(raw);
  return {
    _id: readString(o, '_id'),
    name: readString(o, 'name'),
    description: readString(o, 'description'),
    // The one non-empty string default (the Kotlin data-class default message);
    // reused from the built-in template so the long copy lives in one place.
    defaultEmailMessage: readString(o, 'defaultEmailMessage', DEFAULT_KINTALE_TEMPLATE.defaultEmailMessage),
    serviceTypeKeys: readStringArray(o, 'serviceTypeKeys'),
    isActive: readBool(o, 'isActive', true),
    isDefault: readBool(o, 'isDefault', false),

    photoShowcaseEnabled: readBool(o, 'photoShowcaseEnabled', true),
    checklistEnabled: readBool(o, 'checklistEnabled', true),
    petMoodEnabled: readBool(o, 'petMoodEnabled', false),
    visitNotesEnabled: readBool(o, 'visitNotesEnabled', true),
    nextAppointmentEnabled: readBool(o, 'nextAppointmentEnabled', true),
    reviewBoosterEnabled: readBool(o, 'reviewBoosterEnabled', false),

    checklistItems: readArray(o, 'checklistItems').map(decodeChecklistItem),
    moodOptions: readArray(o, 'moodOptions').map(decodeMoodOption),

    createdAt: readString(o, 'createdAt'),
    updatedAt: readString(o, 'updatedAt'),
  };
}

/**
 * The template the editor should open on first load: the one flagged default,
 * else the first in the list, else null (no templates exist yet, the caller then
 * seeds a fresh draft from the built-in default). Mirrors the Compose editor's
 * `data.firstOrNull { it.isDefault } ?: data.firstOrNull()`.
 */
export function pickInitialTemplate(list: readonly KinTaleTemplate[]): KinTaleTemplate | null {
  return list.find((t) => t.isDefault) ?? list[0] ?? null;
}

/**
 * The template a NEW KinTale draft is composed against, resolved from the
 * session's service type. A verbatim port of the rule both Kotlin composers
 * share, `FirestoreClient.kt#activeTemplateForService` and
 * `AuntieRepository.kt#getActiveTemplateForService`:
 *
 *   1. consider only `isActive` templates;
 *   2. the first whose `serviceTypeKeys` contains the session's `serviceType`,
 *      compared lowercased and trimmed on BOTH sides;
 *   3. else the first flagged `isDefault`;
 *   4. else the built-in {@link DEFAULT_KINTALE_TEMPLATE}.
 *
 * "First" is the order the caller hands in, which for `KINTALE_TEMPLATES_QUERY`
 * is `name` ascending. The Kotlin queries have NO `orderBy` at all, so with two
 * matching templates their pick is Firestore snapshot order and effectively
 * unspecified; ordering by name here is a strict improvement (deterministic and
 * legible) rather than a divergence in the rule itself.
 *
 * A BLANK `serviceType` matches nothing rather than matching a blank
 * `serviceTypeKeys` entry, because the trimmed-and-lowered comparison would
 * otherwise pair "this session has no service type recorded" (true of 76 of 99
 * live sessions) with "this template's key list has a stray empty string" and
 * call that a deliberate match. Step 3's default is the honest answer there.
 */
export function pickTemplateForService(
  list: readonly KinTaleTemplate[],
  serviceType: string,
): KinTaleTemplate {
  const active = list.filter((t) => t.isActive);
  const needle = serviceType.toLowerCase().trim();
  const match =
    needle === ''
      ? undefined
      : active.find((t) => t.serviceTypeKeys.some((k) => k.toLowerCase().trim() === needle));
  return match ?? active.find((t) => t.isDefault) ?? DEFAULT_KINTALE_TEMPLATE;
}

/**
 * The template an EXISTING draft was composed against: looked up by the
 * `templateId` stored on the report, never re-derived from the service type.
 *
 * Re-deriving would silently re-key a saved draft's `fieldResponses` whenever
 * the Den's templates changed between saving and reopening: the responses are
 * keyed by `fieldKey`, so a different template turns every stored tick into a
 * key the new item list does not contain, and the operator watches their
 * checklist empty itself.
 *
 * A blank `templateId` means the built-in default, which is what every
 * platform's `scaffoldReport` writes for it. An id that no longer resolves (the
 * template was deleted, which the operator is allowed to do) also falls back to
 * the built-in: fabricating a different template's labels over the stored ticks
 * would be worse than the built-in's honest ones.
 */
export function templateForDraft(
  list: readonly KinTaleTemplate[],
  templateId: string,
): KinTaleTemplate {
  if (templateId.trim() === '') return DEFAULT_KINTALE_TEMPLATE;
  return list.find((t) => t._id === templateId) ?? DEFAULT_KINTALE_TEMPLATE;
}

/**
 * The value to STAMP on a report's `templateId` for a resolved template: the
 * doc id, or `''` for the built-in default. Mirrors
 * `template._id.takeUnless { it == DefaultKinTaleTemplate.ID }.orEmpty()`
 * (`KinTaleComposeScreen.kt:1167`, `KinTaleReportViewModel.kt:366`), so the
 * sentinel id never reaches Firestore.
 */
export function templateIdForWire(template: KinTaleTemplate): string {
  return template._id === DEFAULT_KINTALE_TEMPLATE_ID ? '' : template._id;
}
