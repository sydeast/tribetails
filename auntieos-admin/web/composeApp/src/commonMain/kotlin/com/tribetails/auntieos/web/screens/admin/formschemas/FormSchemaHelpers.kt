package com.tribetails.auntieos.web.screens.admin.formschemas

import com.tribetails.auntieos.web.data.FormFieldSpec
import com.tribetails.auntieos.web.data.FormSchema
import com.tribetails.auntieos.web.data.FormSectionSpec

/**
 * Pure validation + reorder helpers for the form-schema editor. Kept top-level
 * and Compose-free so they can be unit-tested directly (compose-pure-helper-tdd).
 */

// Identifier regex contracts, kept in lockstep with the backend Zod schema.
// Schema ids may include dot/hyphen (e.g. `tribe.profile-v2`); field keys are
// stricter (used as JS object keys / Firestore field paths) → letters/digits/_.
private val SCHEMA_ID_REGEX = Regex("^[a-zA-Z][a-zA-Z0-9_.\\-]*$")
private val FIELD_KEY_REGEX = Regex("^[a-zA-Z][a-zA-Z0-9_]*$")

// Plaintext contract, mirrors the backend PLAINTEXT_RE in saveFormSchema.ts,
// which rejects angle brackets, ampersand, and control chars in every free-text
// string (name, description, section title/description, field label/helper/
// placeholder/default). We enforce it client-side too so Save is never enabled
// then bounced server-side with an opaque invalid-argument (audit parity gap).
private val PLAINTEXT_BANNED_CHARS = setOf('<', '>', '&')

/** True when [s] contains a banned char or any C0/C1 control character. */
private fun violatesPlaintext(s: String): Boolean =
    s.any { it in PLAINTEXT_BANNED_CHARS || it.isISOControl() }

/** Per-section validation errors. Section indices are stable across calls. */
data class FormSchemaValidationReport(
    val sectionErrors: Map<Int, List<String>>,
    val fieldErrors: Map<Pair<Int, Int>, List<String>>,
) {
    val isValid: Boolean get() = sectionErrors.isEmpty() && fieldErrors.isEmpty()

    val allErrors: List<String>
        get() = buildList {
            sectionErrors.values.forEach { addAll(it) }
            fieldErrors.values.forEach { addAll(it) }
        }
}

/**
 * Runs every client-side invariant the backend Zod schema also enforces, so the
 * Save button is only enabled when the server will actually accept the payload
 * (the audit's enable-then-reject class of bug). Covered:
 *  - schema name + id non-blank, id matches the id regex,
 *  - schema has at least one section (Zod SchemaInputSchema.sections.min(1)),
 *  - each section has a non-blank title and at least one field (SectionSchema.fields.min(1)),
 *  - field key/label non-blank, key matches the key regex, key uniqueness within a section,
 *  - field type ∈ [FormSchema.SUPPORTED_TYPES],
 *  - `options` non-empty when type ∈ {select, multiselect},
 *  - no plaintext-banned chars (<, >, &, control chars) in any free-text string.
 *
 * Surfacing inline beats a 400/invalid-argument round-trip the operator can't act on.
 */
fun validateFormSchema(schema: FormSchema): FormSchemaValidationReport {
    val sectionErrors = mutableMapOf<Int, MutableList<String>>()
    val fieldErrors = mutableMapOf<Pair<Int, Int>, MutableList<String>>()

    // -1 is the "schema-level" bucket the screen renders as a top banner.
    val topErrs = sectionErrors.getOrPut(-1) { mutableListOf() }

    if (schema.name.isBlank()) {
        topErrs.add("Schema name is required.")
    }
    if (schema.id.isNotBlank() && !SCHEMA_ID_REGEX.matches(schema.id)) {
        topErrs.add(
            "Schema id '${schema.id}' must start with a letter and contain only letters, numbers, underscores, dots, or hyphens.",
        )
    }
    if (violatesPlaintext(schema.name)) {
        topErrs.add("Schema name cannot contain < > & or control characters.")
    }
    if (violatesPlaintext(schema.description.orEmpty())) {
        topErrs.add("Schema description cannot contain < > & or control characters.")
    }
    // Backend SchemaInputSchema requires at least one section. Client parity so
    // a fresh "New schema" with zero sections cannot reach an enabled Save.
    if (schema.sections.isEmpty()) {
        topErrs.add("Add at least one section before saving.")
    }

    schema.sections.forEachIndexed { sIdx, section ->
        val secErrs = sectionErrors.getOrPut(sIdx) { mutableListOf() }

        if (section.title.isBlank()) {
            secErrs.add("Section title is required.")
        }
        if (violatesPlaintext(section.title)) {
            secErrs.add("Section title cannot contain < > & or control characters.")
        }
        if (violatesPlaintext(section.description.orEmpty())) {
            secErrs.add("Section description cannot contain < > & or control characters.")
        }
        // Backend SectionSchema requires at least one field per section.
        if (section.fields.isEmpty()) {
            secErrs.add("Add at least one field to this section before saving.")
        }

        // Track keys seen so far to flag duplicates inline on the second+ occurrence.
        val seenKeys = mutableMapOf<String, Int>()

        section.fields.forEachIndexed { fIdx, field ->
            val errs = fieldErrors.getOrPut(sIdx to fIdx) { mutableListOf() }

            if (field.key.isBlank()) errs.add("Field key is required.")
            if (field.label.isBlank()) errs.add("Field label is required.")

            if (field.key.isNotBlank() && !FIELD_KEY_REGEX.matches(field.key)) {
                errs.add(
                    "Field key '${field.key}' must start with a letter and contain only letters, numbers, and underscores.",
                )
            }

            if (field.type !in FormSchema.SUPPORTED_TYPES) {
                errs.add("Unsupported field type: ${field.type}.")
            }

            if (FormSchema.typeRequiresOptions(field.type)) {
                val opts = field.options.orEmpty().filter { it.isNotBlank() }
                if (opts.isEmpty()) {
                    errs.add("Options required for ${field.type} fields.")
                }
            }

            // Plaintext parity on every free-text field string.
            if (violatesPlaintext(field.label)) {
                errs.add("Field label cannot contain < > & or control characters.")
            }
            if (violatesPlaintext(field.helperText.orEmpty())) {
                errs.add("Helper text cannot contain < > & or control characters.")
            }
            if (violatesPlaintext(field.placeholder.orEmpty())) {
                errs.add("Placeholder cannot contain < > & or control characters.")
            }
            if (violatesPlaintext(field.defaultValue.orEmpty())) {
                errs.add("Default value cannot contain < > & or control characters.")
            }

            if (field.key.isNotBlank()) {
                val firstIdx = seenKeys[field.key]
                if (firstIdx != null) {
                    errs.add("Duplicate field key '${field.key}' (also at field ${firstIdx + 1}).")
                } else {
                    seenKeys[field.key] = fIdx
                }
            }

            if (errs.isEmpty()) fieldErrors.remove(sIdx to fIdx)
        }
    }

    return FormSchemaValidationReport(
        sectionErrors = sectionErrors.filterValues { it.isNotEmpty() }.mapValues { it.value.toList() },
        fieldErrors   = fieldErrors.filterValues { it.isNotEmpty() }.mapValues { it.value.toList() },
    )
}

// ---- Reorder primitives ----
// Adjacent swaps only, keeps the operator's mental model simple (up = swap
// with previous, down = swap with next). Edges are no-ops (returns same list).

fun <T> moveItemUp(list: List<T>, index: Int): List<T> {
    if (index <= 0 || index >= list.size) return list
    val mutable = list.toMutableList()
    val tmp = mutable[index - 1]
    mutable[index - 1] = mutable[index]
    mutable[index] = tmp
    return mutable
}

fun <T> moveItemDown(list: List<T>, index: Int): List<T> {
    if (index < 0 || index >= list.size - 1) return list
    val mutable = list.toMutableList()
    val tmp = mutable[index + 1]
    mutable[index + 1] = mutable[index]
    mutable[index] = tmp
    return mutable
}

fun moveSectionUp(schema: FormSchema, sectionIdx: Int): FormSchema =
    schema.copy(sections = moveItemUp(schema.sections, sectionIdx))

fun moveSectionDown(schema: FormSchema, sectionIdx: Int): FormSchema =
    schema.copy(sections = moveItemDown(schema.sections, sectionIdx))

fun moveFieldUp(schema: FormSchema, sectionIdx: Int, fieldIdx: Int): FormSchema {
    val section = schema.sections.getOrNull(sectionIdx) ?: return schema
    val newFields = moveItemUp(section.fields, fieldIdx)
    if (newFields === section.fields || newFields == section.fields) return schema
    return schema.copy(
        sections = schema.sections.mapIndexed { i, s -> if (i == sectionIdx) s.copy(fields = newFields) else s },
    )
}

fun moveFieldDown(schema: FormSchema, sectionIdx: Int, fieldIdx: Int): FormSchema {
    val section = schema.sections.getOrNull(sectionIdx) ?: return schema
    val newFields = moveItemDown(section.fields, fieldIdx)
    if (newFields === section.fields || newFields == section.fields) return schema
    return schema.copy(
        sections = schema.sections.mapIndexed { i, s -> if (i == sectionIdx) s.copy(fields = newFields) else s },
    )
}

// ---- Mutators (pure) ----

fun addSection(schema: FormSchema): FormSchema =
    schema.copy(sections = schema.sections + FormSectionSpec())

fun removeSection(schema: FormSchema, sectionIdx: Int): FormSchema {
    if (sectionIdx !in schema.sections.indices) return schema
    return schema.copy(sections = schema.sections.filterIndexed { i, _ -> i != sectionIdx })
}

fun addField(schema: FormSchema, sectionIdx: Int): FormSchema {
    val section = schema.sections.getOrNull(sectionIdx) ?: return schema
    return schema.copy(
        sections = schema.sections.mapIndexed { i, s ->
            if (i == sectionIdx) s.copy(fields = s.fields + FormFieldSpec()) else s
        },
    )
}

fun removeField(schema: FormSchema, sectionIdx: Int, fieldIdx: Int): FormSchema {
    val section = schema.sections.getOrNull(sectionIdx) ?: return schema
    if (fieldIdx !in section.fields.indices) return schema
    return schema.copy(
        sections = schema.sections.mapIndexed { i, s ->
            if (i == sectionIdx) s.copy(fields = s.fields.filterIndexed { fi, _ -> fi != fieldIdx }) else s
        },
    )
}

fun updateField(
    schema: FormSchema,
    sectionIdx: Int,
    fieldIdx: Int,
    mutate: (FormFieldSpec) -> FormFieldSpec,
): FormSchema {
    val section = schema.sections.getOrNull(sectionIdx) ?: return schema
    val field = section.fields.getOrNull(fieldIdx) ?: return schema
    val newField = mutate(field)
    return schema.copy(
        sections = schema.sections.mapIndexed { i, s ->
            if (i == sectionIdx) s.copy(fields = s.fields.mapIndexed { fi, f -> if (fi == fieldIdx) newField else f }) else s
        },
    )
}

fun updateSection(
    schema: FormSchema,
    sectionIdx: Int,
    mutate: (FormSectionSpec) -> FormSectionSpec,
): FormSchema {
    val section = schema.sections.getOrNull(sectionIdx) ?: return schema
    return schema.copy(
        sections = schema.sections.mapIndexed { i, s -> if (i == sectionIdx) mutate(s) else s },
    )
}
