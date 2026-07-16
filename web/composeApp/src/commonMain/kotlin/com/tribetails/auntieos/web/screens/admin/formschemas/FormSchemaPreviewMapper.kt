package com.tribetails.auntieos.web.screens.admin.formschemas

import com.tribetails.auntieos.web.data.FormFieldSpec
import com.tribetails.auntieos.web.data.FormSchema
import com.tribetails.auntieos.web.data.FormSectionSpec

/**
 * Pure mappers that turn the in-progress editor [FormSchema] into the exact input
 * the shared runtime renderer ([com.tribetails.auntieos.web.ui.components.DynamicFormFields])
 * consumes: a normalized [FormSchema] plus a seed `key -> value` map.
 *
 * Why a mapper, not a direct pass-through: the editor lets an operator pick any
 * value from [FormSchema.SUPPORTED_TYPES] and also load schemas the backend may
 * carry with a newer/unknown `type`. The renderer keys its widget choice off the
 * `type` string, so we reconcile every field type here and decide the preview
 * seed value per type. Output is a [FormSchema] (the renderer's model) so the
 * preview pane is literally the production widget tree, never a parallel copy.
 *
 * Fail-loud, never hide: an unknown field type is NOT dropped and NOT silently
 * rendered as a plain field with no signal. It is re-labeled so the operator sees
 * the offending type inline (renderer falls back to a plain text input), exactly
 * as project policy requires.
 */

/** The reconciled render bundle: the normalized schema + its seeded preview values. */
data class FormPreviewRenderModel(
    val schema: FormSchema,
    val values: Map<String, String>,
)

/** Marker wrapped into a field label when its [FormFieldSpec.type] is not recognized. */
internal const val UNKNOWN_TYPE_LABEL_PREFIX = "[unknown type: "
internal const val UNKNOWN_TYPE_LABEL_SUFFIX = "] "

/**
 * True when [type] is a field type the runtime renderer has a dedicated widget for.
 * Mirrors the `when (field.type)` arms in DynamicFormFields (text is the implicit
 * default arm, so it is included here as a recognized type).
 */
internal fun isRenderableFieldType(type: String): Boolean =
    type in FormSchema.SUPPORTED_TYPES

/**
 * Reconciles one editor field into the field the renderer should draw. Known types
 * pass through unchanged. An unknown type keeps its widget fallback (plain text,
 * handled by the renderer's else arm) but its label is prefixed so the unknown
 * type is visible in the preview rather than masquerading as a normal text field.
 */
internal fun reconcilePreviewField(field: FormFieldSpec): FormFieldSpec {
    if (isRenderableFieldType(field.type)) return field
    val annotated = UNKNOWN_TYPE_LABEL_PREFIX + field.type + UNKNOWN_TYPE_LABEL_SUFFIX + field.label
    // Keep the original (unknown) type string so the renderer's else arm draws a
    // plain text input; the prefixed label is what makes the unknown type loud.
    return field.copy(label = annotated)
}

/**
 * Seed value for a single field in the preview. Uses the operator-authored
 * [FormFieldSpec.defaultValue] when present (so the preview shows what a kinfolk
 * would start with); otherwise empty. Values are the string wire format the
 * renderer + form_schemas backend use (multiselect = comma-joined, checkbox =
 * "true"/"false"). Blank keys are skipped (the renderer maps by key; a blank key
 * cannot round-trip a value).
 */
internal fun previewSeedValue(field: FormFieldSpec): String? {
    if (field.key.isBlank()) return null
    val default = field.defaultValue?.trim().orEmpty()
    return default.ifEmpty { null }
}

/**
 * Builds the full [FormPreviewRenderModel] for the schema currently being edited.
 * Pure: no IO, no persistence. Recompute on every editor change and feed the
 * result straight into DynamicFormFields in a read-only preview pane.
 */
fun formSchemaPreviewModel(schema: FormSchema): FormPreviewRenderModel {
    val seed = mutableMapOf<String, String>()
    val sections = schema.sections.map { section ->
        val fields = section.fields.map { field ->
            previewSeedValue(field)?.let { seed[field.key] = it }
            reconcilePreviewField(field)
        }
        FormSectionSpec(
            title = section.title,
            description = section.description,
            fields = fields,
        )
    }
    return FormPreviewRenderModel(
        schema = schema.copy(sections = sections),
        values = seed.toMap(),
    )
}
