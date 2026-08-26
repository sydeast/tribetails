import {
  ChecklistScope,
  responseKey,
  type ChecklistItem,
  type FieldResponse,
  type KinTaleTemplate,
} from './kinTale/model';
import { isChecklistItemVisible } from './kinTale/engine';
import type { KinDetail } from '../api/kinView';
import type { KinfolkProfile } from '../api/kinfolkProfile';
import type { SessionEntry } from '../api/sessions';

/**
 * The per-item checklist the KinTale composer renders, and the `fieldResponses`
 * map it writes. Pure, so the wire shape is a testable fact rather than
 * something buried in a component.
 *
 * WIRE SHAPE, confirmed against both Kotlin composers and the portal reader:
 *
 *  - The field is `fieldResponses` on the `kin_care_reports` doc: a MAP from a
 *    composite key to a {@link FieldResponse} object, never key->bool.
 *    (`Models.kt:869`, `FirestoreClient.kt:2568`.)
 *  - The composite key is `responseKey(fieldKey, kinId)`: `"$kinId|$fieldKey"`
 *    for a PER_PET item, the bare `fieldKey` for a PER_VISIT one, because the
 *    composers pass `""` as the kin id there (`KinTaleReportScreen.kt:800`,
 *    `KinTaleComposeScreen.kt:562`).
 *  - `fieldKey` and `kinId` are DUPLICATED inside the value as well as encoded
 *    in the key. That is not redundancy we chose: the portal reads the value's
 *    own `fieldKey` (`getMyKinTales.ts:171`), never the map key, so a response
 *    written without it is invisible to the household.
 *  - `sectionKey`, `intValue` and `mediaIds` are never written by any composer
 *    and stay at their data-class defaults. They are still emitted so the
 *    document round-trips through the Kotlin decoders unchanged.
 *
 * COMPATIBILITY WITH THE M18 RULING (issue #397, operator ruling 2026-08-23).
 * The ruling is that a client must see an item deliberately left undone as
 * UNTICKED, rather than not at all, and that the way to get there is to port the
 * template condition engine to the portal, NOT to stamp a resolved item list
 * onto the report at send time. That shortcut was offered and declined. Nothing
 * here contradicts it, and two decisions here are what make it possible:
 *
 *  1. The report carries a real `templateId` (or `''` for the built-in), so the
 *     portal can re-resolve THIS report's items and THIS report's conditions
 *     later. No resolved list is stamped, no send-time snapshot is taken.
 *  2. Unticking writes `boolValue: false` and keeps the entry, exactly as
 *     `KinTaleComposeScreen.kt:292-295` does. It never deletes it. So a
 *     deliberately-undone item is already distinguishable from an untouched one
 *     for anything that cares to look, which is strictly more than M18 needs and
 *     never less. The portal reading only `boolValue === true` today
 *     (`getMyKinTales.ts:171`) is exactly the limitation M18 fixes; this module
 *     writes the data that fix will read.
 */

/** One rendered checklist row: the template item plus the kin it is being asked about. */
export interface ChecklistRow {
  item: ChecklistItem;
  /** `''` for a PER_VISIT item, matching the kin id the composers pass. */
  kinId: string;
  /** The map key this row reads and writes. */
  key: string;
  checked: boolean;
}

/** The kin/household context the condition engine evaluates against. */
export interface ChecklistContext {
  session: Pick<SessionEntry, 'serviceType'>;
  kinList: readonly KinDetail[];
  kinfolk: KinfolkProfile | null;
}

/**
 * Order-stable split of a template's items into the two scopes, matching the
 * composers: sorted by `order`, and anything whose `scope` is not
 * case-insensitively PER_PET counts as PER_VISIT.
 *
 * Case-INSENSITIVE deliberately. Android's screen splits case-sensitively
 * (`KinTaleReportScreen.kt:741-742`) while the desktop and BOTH condition
 * engines are case-insensitive, so a template doc carrying `"per_pet"` renders
 * on desktop and vanishes on Android. Following the engines keeps this port
 * consistent with the code that decides whether the item is visible at all;
 * silently dropping a row because of letter case is the worse of the two bugs.
 */
export function splitChecklistScopes(items: readonly ChecklistItem[]): {
  perPet: ChecklistItem[];
  perVisit: ChecklistItem[];
} {
  const sorted = [...items].sort((a, b) => a.order - b.order);
  const isPerPet = (i: ChecklistItem) => i.scope.toLowerCase() === ChecklistScope.PER_PET.toLowerCase();
  return {
    perPet: sorted.filter(isPerPet),
    perVisit: sorted.filter((i) => !isPerPet(i)),
  };
}

/**
 * The rows to render for one kin. An item is offered for THIS kin only when its
 * conditions hold for this kin, which is the per-kin exactness Android uses
 * (`applicableKinForChecklistItem(...).any { it.id == kin.id }`,
 * `KinTaleReportScreen.kt:705-717`) rather than "visible if any kin matches".
 * Asking whether the cat's litter box was scooped on the dog's row is the defect
 * the conditions exist to prevent.
 */
export function perPetChecklistRows(
  template: KinTaleTemplate,
  kin: KinDetail,
  ctx: ChecklistContext,
  responses: Readonly<Record<string, FieldResponse>>,
): ChecklistRow[] {
  if (!template.checklistEnabled) return [];
  const { perPet } = splitChecklistScopes(template.checklistItems);
  return perPet
    .filter((item) => isChecklistItemVisible(item, ctx.session, [kin], ctx.kinfolk))
    .map((item) => toRow(item, kin._id, responses));
}

/**
 * The rows to render once for the whole visit. Evaluated against the full kin
 * list, matching `isChecklistItemVisible`'s own PER_VISIT branch (first kin, or
 * none at all when the visit has no kin on file).
 */
export function perVisitChecklistRows(
  template: KinTaleTemplate,
  ctx: ChecklistContext,
  responses: Readonly<Record<string, FieldResponse>>,
): ChecklistRow[] {
  if (!template.checklistEnabled) return [];
  const { perVisit } = splitChecklistScopes(template.checklistItems);
  return perVisit
    .filter((item) => isChecklistItemVisible(item, ctx.session, ctx.kinList, ctx.kinfolk))
    .map((item) => toRow(item, '', responses));
}

function toRow(
  item: ChecklistItem,
  kinId: string,
  responses: Readonly<Record<string, FieldResponse>>,
): ChecklistRow {
  const key = responseKey(item.key, kinId);
  return { item, kinId, key, checked: responses[key]?.boolValue === true };
}

/**
 * Set one item's answer, returning a NEW map.
 *
 * Unticking keeps the entry with `boolValue: false` rather than deleting it,
 * mirroring `KinTaleComposeScreen.kt#setChecklistChecked`. See this file's
 * header for why that matters to M18.
 *
 * An existing entry is preserved field-by-field and only `boolValue` is
 * replaced, so a response carrying anything another platform wrote (a
 * `stringValue` note, `mediaIds`) survives a tick from this screen. That is the
 * same diff-not-rebuild discipline the Android edit screens got wrong
 * repeatedly; a checklist toggle must not be a full-object rewrite.
 */
export function setChecklistResponse(
  responses: Readonly<Record<string, FieldResponse>>,
  fieldKey: string,
  kinId: string,
  checked: boolean,
): Record<string, FieldResponse> {
  const key = responseKey(fieldKey, kinId);
  const existing = responses[key];
  const next: FieldResponse = existing
    ? { ...existing, boolValue: checked }
    : {
        fieldKey,
        kinId,
        sectionKey: '',
        boolValue: checked,
        intValue: null,
        stringValue: '',
        mediaIds: [],
      };
  return { ...responses, [key]: next };
}

/**
 * Whether the checklist alone is enough to call a draft worth persisting.
 *
 * Ported from the DESKTOP predicate (`KinTaleComposeScreen.kt:1174`), not
 * Android's. Android counts a `fieldResponses` map that is merely non-empty
 * (`KinTaleReportViewModel.kt:621`), which means opening the screen and
 * unticking one item creates a Firestore row saying nothing happened. The
 * desktop requires a truthy answer, and that is the one both platforms' own
 * "no ghost row" comments are actually reaching for.
 *
 * `stringValue` counts even though this composer writes no per-item notes: the
 * other two composers do, and a draft resumed from one of them must not be
 * judged empty here.
 */
export function checklistHasContent(responses: Readonly<Record<string, FieldResponse>>): boolean {
  return Object.values(responses).some((r) => r.boolValue === true || r.stringValue.trim() !== '');
}

/**
 * Decode a raw `fieldResponses` map off a Firestore doc. Every field is
 * defaulted to its Kotlin data-class default for the reason
 * `api/kinTaleTemplates.ts` decodes templates by hand: a doc written by an older
 * app, or hand-edited, is partial, and TypeScript's structural types promise a
 * key the document may simply not have.
 *
 * A non-object entry (a stray string, a `null`) is DROPPED rather than coerced
 * into a blank response: inventing an unanswered item is worse than losing one
 * we cannot read, and a fabricated `fieldKey: ''` would round-trip back to
 * Firestore on the next save.
 */
export function decodeFieldResponses(raw: unknown): Record<string, FieldResponse> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, FieldResponse> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const o = value as Record<string, unknown>;
    const fieldKey = typeof o['fieldKey'] === 'string' ? o['fieldKey'] : '';
    if (fieldKey === '') continue;
    out[key] = {
      fieldKey,
      kinId: typeof o['kinId'] === 'string' ? o['kinId'] : '',
      sectionKey: typeof o['sectionKey'] === 'string' ? o['sectionKey'] : '',
      boolValue: typeof o['boolValue'] === 'boolean' ? o['boolValue'] : null,
      intValue: typeof o['intValue'] === 'number' && Number.isFinite(o['intValue']) ? o['intValue'] : null,
      stringValue: typeof o['stringValue'] === 'string' ? o['stringValue'] : '',
      mediaIds: Array.isArray(o['mediaIds'])
        ? (o['mediaIds'] as unknown[]).filter((m): m is string => typeof m === 'string')
        : [],
    };
  }
  return out;
}
