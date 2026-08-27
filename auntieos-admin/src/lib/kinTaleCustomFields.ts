import type { FormSchemaDetail } from '../api/formSchemasWrite';

/**
 * CUSTOM FIELD ANSWERS on a KinTale, decode + label resolution. The read half
 * of `KinCareReport.formValues`, which until now no web surface rendered.
 *
 * WHAT THIS IS, and what it is NOT. It is NOT the template checklist: that is
 * `fieldResponses`, keyed `"$kinId|$fieldKey"`, decoded by
 * `lib/kinTaleChecklist.ts`, and driven by `KinTaleTemplate.checklistItems`.
 * This is the SEPARATE Phase 14 mechanism, where an admin authors a
 * `form_schemas` doc with `appliesTo: 'KINTALE'` and its fields then appear on
 * every KinTale composer. Android keeps the two apart on screen for the same
 * reason ("Custom fields ... Distinct from the template checklist above;
 * answers persist into report.formValues",
 * `android/.../ui/kintales/KinTaleReportScreen.kt:273`).
 *
 * THE SHAPE, read off the writer: `Models.kt:905` declares
 * `var formValues: Map<String, String> = emptyMap()` on `KinCareReport`, keyed
 * by `FormField.key`. Flat, one level, string values only. Decode narrows to
 * exactly that and drops anything else, for the same "a cast is not a
 * validation" reason `kinTaleMood.ts` documents.
 *
 * AN ANSWER WHOSE LABEL WILL NOT RESOLVE IS DROPPED. A stored key whose field
 * no longer exists in any KINTALE-placed schema (the field was renamed, the
 * section was deleted, the whole schema was deleted) has no truthful label to
 * put beside its value. Rendering the raw key would present an internal
 * identifier as if it were the question the auntie answered, and rendering a
 * blank label would present an answer to nothing. Neither is honest, so the row
 * goes. This is the same reasoning `getMyKinTales.ts` applies to checklist keys
 * it cannot resolve against a template.
 *
 * That mood keys get the OPPOSITE treatment (raw key shown, see
 * `kinTaleMood.ts`) is not an inconsistency: a mood key is itself the word the
 * auntie picked, while a form field key is an identifier the ANSWER hangs off.
 * Dropping the mood would lose the auntie's word; keeping the field key would
 * invent a question.
 */
export interface CustomFieldRow {
  /** `FormField.key`, unique across the resolved schemas. Safe as a list key. */
  key: string;
  /** The section this field was authored under, or `''` for an untitled one. */
  section: string;
  /** `FormField.label`. Never blank: a blank-label field is dropped. */
  label: string;
  /** The stored answer. Never blank: a blank answer is dropped. */
  value: string;
}

/**
 * Narrows raw `formValues` to the flat string->string map it is supposed to be.
 * Blank keys and blank/non-string values are dropped, not coerced.
 */
export function decodeFormValues(raw: unknown): Record<string, string> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.trim() === '') continue;
    if (typeof value !== 'string') continue;
    if (value.trim() === '') continue;
    out[key] = value;
  }
  return out;
}

/**
 * The rows a "Custom fields" panel should draw, or `[]` for no panel.
 *
 * `schemas` must already be narrowed to the KINTALE-placed ones; this function
 * does not re-filter on `appliesTo`, because the caller is the one that decided
 * which schemas a KinTale is composed against and re-checking here would hide a
 * mistake there rather than surface it.
 *
 * Order is SCHEMA order, then section order, then field order: the order the
 * admin authored the form in, which is the order the composer asked the
 * questions in. Iterating the stored map instead would order the answers by
 * whatever Firestore happened to hand back, which is not an order anyone chose.
 * A field with no stored answer contributes no row (the panel reports what was
 * answered, it is not a blank form).
 */
export function customFieldRows(
  raw: unknown,
  schemas: readonly FormSchemaDetail[],
): CustomFieldRow[] {
  const values = decodeFormValues(raw);
  const rows: CustomFieldRow[] = [];
  const seen = new Set<string>();
  for (const schema of schemas) {
    for (const section of schema.sections) {
      for (const field of section.fields) {
        const value = values[field.key];
        if (value === undefined) continue;
        if (field.label.trim() === '') continue;
        // Two schemas can legally declare the same field key. The stored map
        // holds ONE answer for it, so the first authored field wins and the
        // duplicate is skipped rather than printing the same answer twice.
        if (seen.has(field.key)) continue;
        seen.add(field.key);
        rows.push({
          key: field.key,
          section: section.title,
          label: field.label,
          value,
        });
      }
    }
  }
  return rows;
}
