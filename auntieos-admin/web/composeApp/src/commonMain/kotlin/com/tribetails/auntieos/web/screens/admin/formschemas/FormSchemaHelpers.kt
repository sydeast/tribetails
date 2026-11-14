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

/**
 * #2074: the text rules `saveFormSchema` enforces, so the editor refuses on
 * screen exactly what the server refuses on save. Same limits and the same
 * sentences as the server's `describeFormSchemaIssue`, the web admin's
 * `lib/formSchemaRules.ts` and the Android `FormSchemaTextRules`; the tests on
 * all of them share the walk's strings.
 *
 * Two things this used to get wrong: it checked no lengths (a 330-character
 * label passed), and it refused every C1 control character and every line
 * break, where the server refuses only C0 controls and DEL and allows line
 * breaks and tabs in the two descriptions.
 */
object FormSchemaTextRules {
    const val ID = 80
    const val NAME = 200
    const val DESCRIPTION = 2000
    const val SECTIONS = 50
    const val SECTION_TITLE = 200
    const val SECTION_DESCRIPTION = 2000
    const val FIELDS = 200
    const val KEY = 80
    const val LABEL = 200
    const val HELPER_TEXT = 500
    const val PLACEHOLDER = 200
    const val OPTIONS = 100
    const val OPTION = 200
    const val DEFAULT_VALUE = 2000
    const val GROUP = 80

    private fun isHidden(c: Char, multiline: Boolean): Boolean {
        val code = c.code
        if (code == 0x7F) return true
        if (code > 0x1F) return false
        return !(multiline && (code == 0x09 || code == 0x0A || code == 0x0D))
    }

    /** Why [value] cannot be saved as [thing], or null. [plain] false is Group, held to length only. */
    fun textProblem(
        thing: String,
        value: String?,
        max: Int,
        multiline: Boolean = false,
        plain: Boolean = true,
    ): String? {
        val v = value.orEmpty()
        if (v.length > max) return "$thing is ${v.length} characters long. The limit is $max."
        if (!plain) return null
        if (v.any { it == '<' || it == '>' || it == '&' }) return "$thing cannot contain <, > or &."
        if (v.any { isHidden(it, multiline) }) {
            return "$thing cannot contain a tab, a line break or another hidden character."
        }
        return null
    }
}

/** One field-level refusal from `saveFormSchema`, placed on its section and field (null for the schema). */
data class FormSchemaRefusal(val sectionIndex: Int?, val fieldIndex: Int?, val text: String)

/**
 * Pure: the refusals in a failed save's `details` JSON (#2074). Empty for any
 * other failure and for a server that predates the sentences.
 */
fun formSchemaRefusalsFromDetails(details: String?): List<FormSchemaRefusal> {
    if (details.isNullOrBlank()) return emptyList()
    val obj = runCatching { kotlinx.serialization.json.Json.parseToJsonElement(details) as? kotlinx.serialization.json.JsonObject }
        .getOrNull() ?: return emptyList()
    val reason = (obj["reason"] as? kotlinx.serialization.json.JsonPrimitive)?.content
    if (reason != "form-schema-refused") return emptyList()
    val list = obj["validationErrors"] as? kotlinx.serialization.json.JsonArray ?: return emptyList()
    return list.mapNotNull { el ->
        val e = el as? kotlinx.serialization.json.JsonObject ?: return@mapNotNull null
        val textPrim = e["text"] as? kotlinx.serialization.json.JsonPrimitive ?: return@mapNotNull null
        if (!textPrim.isString || textPrim.content.isBlank()) return@mapNotNull null
        fun index(key: String): Int? = (e[key] as? kotlinx.serialization.json.JsonPrimitive)
            ?.takeIf { !it.isString }?.content?.toIntOrNull()
        FormSchemaRefusal(index("sectionIndex"), index("fieldIndex"), textPrim.content)
    }
}

/** A report with the server's refusals added where they belong, so the cards show them inline. */
fun FormSchemaValidationReport.withRefusals(refusals: List<FormSchemaRefusal>): FormSchemaValidationReport {
    if (refusals.isEmpty()) return this
    val sections = sectionErrors.mapValues { it.value.toMutableList() }.toMutableMap()
    val fields = fieldErrors.mapValues { it.value.toMutableList() }.toMutableMap()
    for (r in refusals) {
        val s = r.sectionIndex
        val f = r.fieldIndex
        if (s != null && f != null) fields.getOrPut(s to f) { mutableListOf() }.add(r.text)
        else sections.getOrPut(s ?: -1) { mutableListOf() }.add(r.text)
    }
    return FormSchemaValidationReport(sections.mapValues { it.value.toList() }, fields.mapValues { it.value.toList() })
}

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
 *  - field type in [FormSchema.SUPPORTED_TYPES],
 *  - `options` non-empty when type in {select, multiselect}, each option plain text,
 *  - [FormSchemaTextRules] on every free-text string: no `<`, `>`, `&`, no
 *    hidden characters (line breaks allowed in descriptions), and the
 *    server's length limits (#2074).
 *
 * Surfacing inline beats a 400/invalid-argument round-trip the operator can't act on.
 */
fun validateFormSchema(schema: FormSchema): FormSchemaValidationReport {
    val sectionErrors = mutableMapOf<Int, MutableList<String>>()
    val fieldErrors = mutableMapOf<Pair<Int, Int>, MutableList<String>>()
    val r = FormSchemaTextRules

    // -1 is the "schema-level" bucket the screen renders as a top banner.
    val topErrs = sectionErrors.getOrPut(-1) { mutableListOf() }
    fun MutableList<String>.addIf(problem: String?) { if (problem != null) add(problem) }

    if (schema.name.isBlank()) {
        topErrs.add("Schema name is required.")
    }
    if (schema.id.length > r.ID) {
        topErrs.add("Schema id is ${schema.id.length} characters long. The limit is ${r.ID}.")
    } else if (schema.id.isNotBlank() && !SCHEMA_ID_REGEX.matches(schema.id)) {
        topErrs.add(
            "Schema id '${schema.id}' must start with a letter and contain only letters, numbers, underscores, dots, or hyphens.",
        )
    }
    topErrs.addIf(r.textProblem("Name", schema.name, r.NAME))
    topErrs.addIf(r.textProblem("Description", schema.description, r.DESCRIPTION, multiline = true))
    // Backend SchemaInputSchema requires at least one section. Client parity so
    // a fresh "New schema" with zero sections cannot reach an enabled Save.
    if (schema.sections.isEmpty()) {
        topErrs.add("Add at least one section before saving.")
    }
    if (schema.sections.size > r.SECTIONS) topErrs.add("A form can have at most ${r.SECTIONS} sections.")

    schema.sections.forEachIndexed { sIdx, section ->
        val secErrs = sectionErrors.getOrPut(sIdx) { mutableListOf() }

        if (section.title.isBlank()) {
            secErrs.add("Section title is required.")
        }
        secErrs.addIf(r.textProblem("Section title", section.title, r.SECTION_TITLE))
        secErrs.addIf(r.textProblem("Section description", section.description, r.SECTION_DESCRIPTION, multiline = true))
        // Backend SectionSchema requires at least one field per section.
        if (section.fields.isEmpty()) {
            secErrs.add("Add at least one field to this section before saving.")
        }
        if (section.fields.size > r.FIELDS) secErrs.add("A section can have at most ${r.FIELDS} fields.")

        // Track keys seen so far to flag duplicates inline on the second+ occurrence.
        val seenKeys = mutableMapOf<String, Int>()

        section.fields.forEachIndexed { fIdx, field ->
            val errs = fieldErrors.getOrPut(sIdx to fIdx) { mutableListOf() }

            if (field.key.isBlank()) errs.add("Field key is required.")
            if (field.label.isBlank()) errs.add("Field label is required.")

            if (field.key.length > r.KEY) {
                errs.add("Key is ${field.key.length} characters long. The limit is ${r.KEY}.")
            } else if (field.key.isNotBlank() && !FIELD_KEY_REGEX.matches(field.key)) {
                errs.add(
                    "Field key '${field.key}' must start with a letter and contain only letters, numbers, and underscores.",
                )
            }

            if (field.type !in FormSchema.SUPPORTED_TYPES) {
                errs.add("Unsupported field type: ${field.type}.")
            }

            if (FormSchema.typeRequiresOptions(field.type)) {
                val all = field.options.orEmpty()
                val opts = all.filter { it.isNotBlank() }
                if (opts.isEmpty()) {
                    errs.add("Options required for ${field.type} fields.")
                }
                if (all.size > r.OPTIONS) errs.add("A field can have at most ${r.OPTIONS} options.")
                all.forEachIndexed { i, o ->
                    errs.addIf(if (o.isEmpty()) "Option ${i + 1} is empty." else r.textProblem("Option ${i + 1}", o, r.OPTION))
                }
            }

            errs.addIf(r.textProblem("Label", field.label, r.LABEL))
            errs.addIf(r.textProblem("Helper text", field.helperText, r.HELPER_TEXT))
            errs.addIf(r.textProblem("Placeholder", field.placeholder, r.PLACEHOLDER))
            errs.addIf(r.textProblem("Default value", field.defaultValue, r.DEFAULT_VALUE))
            errs.addIf(r.textProblem("Group", field.group, r.GROUP, plain = false))

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
