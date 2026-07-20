package com.tribetails.auntieos.data.model

/**
 * Admin-authored form schema describing the structure of a kinfolk-facing form
 * (e.g. `tribeProfile`). Matches the canonical `formSchemas/{schemaId}` document
 * shape consumed by MyTribe's schema-driven form renderer.
 *
 * Cross-platform parity: the Web sibling defines the same shape - keep field
 * names and ordering aligned per [[full-stack-coverage]].
 */
data class FormSchema(
    val id: String = "",
    val name: String = "",
    val description: String = "",
    // 1C placement: which entity this schema attaches to (NONE = global/standalone).
    val appliesTo: String = FormSchemaAppliesTo.NONE,
    val version: Int = 0,
    val sections: List<FormSchemaSection> = emptyList(),
    val createdAt: String = "",
    val updatedAt: String = "",
    val updatedBy: String = "",
)

/** Placement targets a FormSchema can attach to (mirrors the server APPLIES_TO enum). */
object FormSchemaAppliesTo {
    const val NONE = "NONE"
    val ALL = listOf("NONE", "KINFOLK", "KIN", "HOUSEHOLD", "SESSION", "BOOKING", "KINTALE")
}

data class FormSchemaSection(
    val title: String = "",
    val description: String? = null,
    val fields: List<FormSchemaField> = emptyList(),
)

data class FormSchemaField(
    val key: String = "",
    val label: String = "",
    val type: String = FormSchemaFieldType.TEXT.wire,
    val required: Boolean = false,
    val helperText: String? = null,
    val placeholder: String? = null,
    val options: List<String>? = null,
    val defaultValue: String? = null,
    val group: String? = null,
)

/**
 * The 9 allowed enum values from the spec. Stored on the wire as lowercase
 * strings so docs read identically across platforms. Keep this in sync with the
 * Web sibling and the Zod schema in MyTribe `functions/src/admin/saveFormSchema.ts`.
 */
enum class FormSchemaFieldType(val wire: String, val displayLabel: String) {
    TEXT("text", "Text"),
    TEXTAREA("textarea", "Long text"),
    SELECT("select", "Dropdown"),
    MULTISELECT("multiselect", "Multi-select"),
    DATE("date", "Date"),
    NUMBER("number", "Number"),
    CHECKBOX("checkbox", "Checkbox"),
    PHONE("phone", "Phone"),
    EMAIL("email", "Email");

    companion object {
        val allWire: List<String> = entries.map { it.wire }
        fun fromWire(wire: String?): FormSchemaFieldType? =
            entries.firstOrNull { it.wire.equals(wire, ignoreCase = true) }
        fun requiresOptions(wire: String?): Boolean =
            wire == SELECT.wire || wire == MULTISELECT.wire
    }
}

/** Lightweight summary returned by the `listFormSchemas` callable. */
data class FormSchemaSummary(
    val id: String,
    val name: String,
    val appliesTo: String = FormSchemaAppliesTo.NONE,
    val version: Int,
    val updatedAt: String,
    val updatedBy: String,
)

/**
 * Ids of the form_schemas placed on a given entity ([target] = an APPLIES_TO value
 * such as "KIN", "KINFOLK", "SESSION", "BOOKING", "KINTALE"). Pure + case-insensitive;
 * the single shared filter every dynamic-fields consumer screen uses (Phase 14).
 */
fun appliesToSchemaIds(summaries: List<FormSchemaSummary>, target: String): List<String> =
    summaries.filter { it.appliesTo.equals(target, ignoreCase = true) }.map { it.id }
