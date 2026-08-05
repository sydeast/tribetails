package com.tribetails.auntieos.ui.admin.formschemas

import com.tribetails.auntieos.data.model.FormSchema
import com.tribetails.auntieos.data.model.FormSchemaField
import com.tribetails.auntieos.data.model.FormSchemaFieldType
import com.tribetails.auntieos.data.model.FormSchemaSection
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.util.Locale

// ─────────────────────────────────────────────────────────────────────────────
// FormSchema pure helpers. Extracted as top-level functions per
// [[compose-pure-helper-tdd]] so validation + reorder logic is unit-testable
// without Compose / Robolectric. The Compose ViewModel/screen layer composes
// these to drive editor behavior.
// ─────────────────────────────────────────────────────────────────────────────

/** What a row shows when the server sent no `updatedAt` at all. */
const val NO_UPDATED_AT_LABEL = "date unknown"

/**
 * A schema row's "last updated" text: LOCAL `MM-DD HH:mm`.
 *
 * THE BUG THIS FIXES: [FormSchemaListScreen]'s row subtitle used to print
 * `row.updatedAt` raw, so the operator read `updated 2026-08-02T10:15:00.000Z
 * by e2e-admin` off the list. The React admin had the identical defect in its
 * own `metaLine`; both are fixed together and both now produce the SAME string
 * for the same input.
 *
 * The format is the React admin's `lib/time.ts#formatWhen`, ported: two-digit
 * month, day, hour and minute in the OPERATOR'S zone. Local, never UTC, is the
 * whole point (the AO-18 rule): `updatedAt` arrives from `listFormSchemas` as a
 * UTC instant, and a schema saved at 5:15am in Chicago must not read 10:15.
 * That also means this is NOT the `substring(11, 16)` slicing that
 * `KinTaleLogsScreen.kt#shortDateTime` and `InboxScreen.kt#shortDateTime` still
 * do; those print the UTC clock and are the bug this deliberately avoids.
 *
 * Three input classes, three honest outputs, never a crash and never a
 * fabricated date:
 *  - a real instant  -> `08-02 05:15`
 *  - blank / absent  -> [NO_UPDATED_AT_LABEL]. `FormSchemaSummary.updatedAt` is
 *    a non-null String on this platform, so a schema saved before the field
 *    existed arrives as `""`. Not "never updated": absent is unknown, not proof
 *    nobody saved it.
 *  - anything else   -> the raw trimmed text, verbatim, so a value this cannot
 *    read is one the operator can actually SEE and report.
 */
fun formSchemaUpdatedLabel(updatedAt: String): String {
    val raw = updatedAt.trim()
    if (raw.isEmpty()) return NO_UPDATED_AT_LABEL
    val local = parseFormSchemaInstant(raw) ?: return raw
    return String.format(
        Locale.US,
        "%02d-%02d %02d:%02d",
        local.monthValue,
        local.dayOfMonth,
        local.hour,
        local.minute,
    )
}

/**
 * The stored string as a LOCAL wall clock, or null when it cannot be read.
 *
 * The four accepted shapes are the ones the React sibling's `new Date(...)`
 * also reads for this field, in the same order and with the same zone
 * semantics, so the two platforms agree on every input either of them
 * formats:
 *  1. `2026-08-02T10:15:00.000Z`  the ONLY shape any live writer produces
 *     (`saveFormSchema` stamps `FieldValue.serverTimestamp()`, and
 *     `listFormSchemas#toIsoOrNull` hands it over as `.toISOString()`).
 *  2. `2026-08-02T05:15:00-05:00`  an explicit offset.
 *  3. `2026-08-02T05:15:00`        no designator, which ISO-8601 reads as
 *     LOCAL time, exactly as JS does.
 *  4. `2026-08-02`                 date-only, anchored at UTC midnight,
 *     matching JS's date-only rule rather than the JVM's start-of-local-day.
 *
 * Free text outside that grammar ("sometime last Tuesday") returns null here
 * and is echoed verbatim by the caller. JS's `Date` would additionally read a
 * few English forms such as "July 1, 2026"; that divergence is accepted rather
 * than chased, because both platforms still degrade honestly (one formats, one
 * shows the operator the raw value) and no writer emits those forms.
 */
private fun parseFormSchemaInstant(raw: String): LocalDateTime? {
    val zone = ZoneId.systemDefault()
    return runCatching { Instant.parse(raw).atZone(zone).toLocalDateTime() }.getOrNull()
        ?: runCatching { OffsetDateTime.parse(raw).atZoneSameInstant(zone).toLocalDateTime() }.getOrNull()
        ?: runCatching { LocalDateTime.parse(raw) }.getOrNull()
        ?: runCatching { LocalDate.parse(raw).atStartOfDay(ZoneOffset.UTC).withZoneSameInstant(zone).toLocalDateTime() }
            .getOrNull()
}

/**
 * The row subtitle's meta tail: `updated 08-02 05:15 by e2e-admin`.
 *
 * A blank `updatedBy` drops the whole "by" clause rather than printing
 * `by -`, which is what the React `metaLine` does with the same pair (it
 * filters blank parts out) and is the only reading that stays true when the
 * pair is absent together, as it is on a schema older than either field.
 */
fun formSchemaUpdatedMeta(updatedAt: String, updatedBy: String): String {
    val who = updatedBy.trim()
    val label = formSchemaUpdatedLabel(updatedAt)
    return if (who.isEmpty()) "updated $label" else "updated $label by $who"
}

/** Pinpoints a validation error to a section + optional field index. */
data class FormSchemaValidationError(
    val sectionIndex: Int,
    val fieldIndex: Int?,
    val message: String,
)

object FormSchemaValidator {

    /**
     * Schema id pattern. Must start with a letter; allows letters, digits,
     * underscore, dot, hyphen. Mirrors the Zod schema on the server (Cloud
     * Function `saveFormSchema`) so client + server agree before the round-
     * trip. Fail-loud per [[fail-loud-policy]] - surface a clear message
     * instead of letting a malformed id slip through and 400 server-side.
     */
    val SCHEMA_ID_REGEX = Regex("^[a-zA-Z][a-zA-Z0-9_.\\-]*$")

    /**
     * Field key pattern. Stricter than the schema id - must be a safe
     * identifier, since these keys become Firestore map keys and JSON
     * property names in form submissions. No dot/hyphen allowed (would
     * collide with Firestore dot-path semantics).
     */
    val FIELD_KEY_REGEX = Regex("^[a-zA-Z][a-zA-Z0-9_]*$")

    /**
     * Validates the entire schema and returns a per-row error list. Empty list
     * means the schema is safe to save. Mirrors the Web sibling validator and
     * the server-side Zod schema so all three layers agree.
     */
    fun validate(schema: FormSchema): List<FormSchemaValidationError> {
        val errors = mutableListOf<FormSchemaValidationError>()
        if (schema.id.isBlank()) {
            errors += FormSchemaValidationError(-1, null, "Schema id is required")
        } else if (!SCHEMA_ID_REGEX.matches(schema.id)) {
            errors += FormSchemaValidationError(
                -1, null,
                "Schema id \"${schema.id}\" is invalid: must start with a letter and contain only letters, digits, underscore, dot, or hyphen",
            )
        }
        if (schema.name.isBlank()) {
            errors += FormSchemaValidationError(-1, null, "Schema name is required")
        }
        if (schema.sections.isEmpty()) {
            errors += FormSchemaValidationError(-1, null, "Schema must have at least one section")
        }
        schema.sections.forEachIndexed { sIdx, section ->
            if (section.title.isBlank()) {
                errors += FormSchemaValidationError(sIdx, null, "Section title is required")
            }
            val seenKeys = mutableSetOf<String>()
            section.fields.forEachIndexed { fIdx, field ->
                errors += validateField(sIdx, fIdx, field, seenKeys)
            }
        }
        return errors
    }

    private fun validateField(
        sectionIdx: Int,
        fieldIdx: Int,
        field: FormSchemaField,
        seenKeysInSection: MutableSet<String>,
    ): List<FormSchemaValidationError> {
        val errs = mutableListOf<FormSchemaValidationError>()
        if (field.key.isBlank()) {
            errs += FormSchemaValidationError(sectionIdx, fieldIdx, "Field key is required")
        } else if (!FIELD_KEY_REGEX.matches(field.key)) {
            errs += FormSchemaValidationError(
                sectionIdx, fieldIdx,
                "Field key \"${field.key}\" is invalid: must start with a letter and contain only letters, digits, or underscore",
            )
        } else if (!seenKeysInSection.add(field.key)) {
            errs += FormSchemaValidationError(
                sectionIdx, fieldIdx,
                "Duplicate key \"${field.key}\" in this section",
            )
        }
        if (field.label.isBlank()) {
            errs += FormSchemaValidationError(sectionIdx, fieldIdx, "Field label is required")
        }
        if (FormSchemaFieldType.fromWire(field.type) == null) {
            errs += FormSchemaValidationError(
                sectionIdx, fieldIdx,
                "Field type \"${field.type}\" is not one of ${FormSchemaFieldType.allWire}",
            )
        }
        if (FormSchemaFieldType.requiresOptions(field.type)) {
            val opts = field.options.orEmpty()
            if (opts.isEmpty() || opts.all { it.isBlank() }) {
                errs += FormSchemaValidationError(
                    sectionIdx, fieldIdx,
                    "Select / multi-select fields require at least one option",
                )
            }
        }
        return errs
    }

    /** Convenience: error count restricted to a particular section/field cell. */
    fun errorsFor(
        all: List<FormSchemaValidationError>,
        sectionIndex: Int,
        fieldIndex: Int?,
    ): List<FormSchemaValidationError> =
        all.filter { it.sectionIndex == sectionIndex && it.fieldIndex == fieldIndex }
}

/**
 * Pure mapper: editor state -> the inputs the shared [com.tribetails.auntieos.ui.components.DynamicFormFields]
 * renderer consumes (a single preview [FormSchema] plus a seeded `key -> value` map).
 *
 * The live-preview pane re-uses the SAME runtime renderer a kinfolk sees, so the
 * preview is faithful by construction. This mapper only prepares the in-progress
 * editor schema for that renderer:
 *
 *  - Every field is shown, never hidden. A blank label falls back to the field key
 *    (or a positional placeholder) so an in-progress field still reads, and an
 *    unknown/unsupported type is shown verbatim and labeled (the renderer's `else`
 *    branch draws it as a plain text input, fail-loud, never dropped).
 *  - Seeded preview values are sample/empty and NEVER persisted: a field's own
 *    `defaultValue` seeds it when present, checkboxes seed to "false", everything
 *    else seeds blank so the operator sees placeholders.
 *
 * Mirrors the type reconciliation the renderer already does (text / textarea /
 * select / multiselect / checkbox / number / phone / email / date / unknown).
 */
object FormSchemaPreviewMapper {

    /**
     * Build the preview schema the renderer draws. Field labels are normalized so
     * nothing renders blank, but types/options/etc. are passed through untouched so
     * the preview reflects exactly what was authored (including an unknown type).
     */
    fun previewSchema(
        sections: List<FormSchemaSection>,
        name: String = "",
        description: String = "",
    ): FormSchema = FormSchema(
        id = "preview",
        name = name,
        description = description,
        sections = sections.map { section ->
            section.copy(
                fields = section.fields.mapIndexed { idx, field ->
                    field.copy(label = previewLabel(field, idx))
                },
            )
        },
    )

    /**
     * Seed the preview value map. Sample/empty only, never written back:
     *  - a non-blank `defaultValue` seeds its field,
     *  - a checkbox with no default seeds "false" (renderer reads `== "true"`),
     *  - everything else stays blank so placeholders show.
     * Keys with a blank field key are skipped (the renderer keys by `field.key`).
     */
    fun previewValues(sections: List<FormSchemaSection>): Map<String, String> {
        val out = linkedMapOf<String, String>()
        sections.forEach { section ->
            section.fields.forEach { field ->
                if (field.key.isBlank()) return@forEach
                val seeded = field.defaultValue?.takeIf { it.isNotBlank() }
                    ?: if (field.type == FormSchemaFieldType.CHECKBOX.wire) "false" else ""
                out[field.key] = seeded
            }
        }
        return out
    }

    /** A field label that is never blank: real label, else key, else positional. */
    internal fun previewLabel(field: FormSchemaField, index: Int): String = when {
        field.label.isNotBlank() -> field.label
        field.key.isNotBlank() -> field.key
        else -> "Field ${index + 1}"
    }

    /** True when there is anything renderable yet (any field in any section). */
    fun hasRenderableFields(sections: List<FormSchemaSection>): Boolean =
        sections.any { it.fields.isNotEmpty() }
}

object FormSchemaReorder {

    /**
     * Move a section from `from` to `to`. No-ops if indices are out of range or
     * if `from == to`. Returns a new list - input is not mutated.
     */
    fun moveSection(sections: List<FormSchemaSection>, from: Int, to: Int): List<FormSchemaSection> {
        if (from == to) return sections
        if (from !in sections.indices) return sections
        if (to !in sections.indices) return sections
        val mutable = sections.toMutableList()
        val removed = mutable.removeAt(from)
        mutable.add(to, removed)
        return mutable
    }

    /**
     * Move a field within a section. No-ops on out-of-range indices. Returns
     * a new sections list - input not mutated.
     */
    fun moveField(
        sections: List<FormSchemaSection>,
        sectionIndex: Int,
        from: Int,
        to: Int,
    ): List<FormSchemaSection> {
        if (sectionIndex !in sections.indices) return sections
        val target = sections[sectionIndex]
        if (from == to) return sections
        if (from !in target.fields.indices) return sections
        if (to !in target.fields.indices) return sections
        val newFields = target.fields.toMutableList().also {
            val removed = it.removeAt(from)
            it.add(to, removed)
        }
        return sections.toMutableList().also { it[sectionIndex] = target.copy(fields = newFields) }
    }

    /** Convenience wrappers used by the up/down arrow handlers in the editor. */
    fun moveSectionUp(sections: List<FormSchemaSection>, index: Int): List<FormSchemaSection> =
        if (index <= 0) sections else moveSection(sections, index, index - 1)

    fun moveSectionDown(sections: List<FormSchemaSection>, index: Int): List<FormSchemaSection> =
        if (index >= sections.size - 1) sections else moveSection(sections, index, index + 1)

    fun moveFieldUp(
        sections: List<FormSchemaSection>,
        sectionIndex: Int,
        fieldIndex: Int,
    ): List<FormSchemaSection> {
        if (sectionIndex !in sections.indices) return sections
        if (fieldIndex <= 0) return sections
        return moveField(sections, sectionIndex, fieldIndex, fieldIndex - 1)
    }

    fun moveFieldDown(
        sections: List<FormSchemaSection>,
        sectionIndex: Int,
        fieldIndex: Int,
    ): List<FormSchemaSection> {
        if (sectionIndex !in sections.indices) return sections
        val fields = sections[sectionIndex].fields
        if (fieldIndex >= fields.size - 1) return sections
        return moveField(sections, sectionIndex, fieldIndex, fieldIndex + 1)
    }
}
