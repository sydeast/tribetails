package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.FormFieldSpec
import com.tribetails.auntieos.web.data.FormSchema
import com.tribetails.auntieos.web.data.FormSectionSpec
import com.tribetails.auntieos.web.screens.admin.formschemas.validateFormSchema
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Pure-helper tests for the three spec-mandated client-side invariants:
 *  1. field key uniqueness within a section,
 *  2. type ∈ FormSchema.SUPPORTED_TYPES,
 *  3. options non-empty when type ∈ {select, multiselect}.
 */
class FormSchemaValidatorTest {

    private fun field(
        key: String = "k",
        label: String = "Label",
        type: String = "text",
        options: List<String>? = null,
    ) = FormFieldSpec(key = key, label = label, type = type, options = options)

    private fun schema(vararg fields: FormFieldSpec): FormSchema =
        FormSchema(
            id = "test",
            name = "Test Schema",
            sections = listOf(FormSectionSpec(title = "S", fields = fields.toList())),
        )

    // ---- key uniqueness (5+) ----

    @Test
    fun keyUniqueness_singleKey_valid() {
        val r = validateFormSchema(schema(field(key = "a")))
        assertTrue(r.isValid)
    }

    @Test
    fun keyUniqueness_twoDistinctKeys_valid() {
        val r = validateFormSchema(schema(field(key = "a"), field(key = "b")))
        assertTrue(r.isValid)
    }

    @Test
    fun keyUniqueness_duplicateKeys_invalid() {
        val r = validateFormSchema(schema(field(key = "a"), field(key = "a")))
        assertFalse(r.isValid)
        val errs = r.fieldErrors[0 to 1].orEmpty()
        assertTrue(errs.any { it.contains("Duplicate") })
    }

    @Test
    fun keyUniqueness_dupAcrossDifferentSections_allowed() {
        val s = FormSchema(
            id = "x", name = "X",
            sections = listOf(
                FormSectionSpec(title = "A", fields = listOf(field(key = "k"))),
                FormSectionSpec(title = "B", fields = listOf(field(key = "k"))),
            ),
        )
        assertTrue(validateFormSchema(s).isValid, "Same key in different sections is allowed.")
    }

    @Test
    fun keyUniqueness_tripleDup_flagsBothLaterOccurrences() {
        val r = validateFormSchema(schema(field(key = "a"), field(key = "a"), field(key = "a")))
        assertTrue(r.fieldErrors.containsKey(0 to 1))
        assertTrue(r.fieldErrors.containsKey(0 to 2))
        assertFalse(r.fieldErrors.containsKey(0 to 0), "First occurrence should be clean.")
    }

    // ---- type enum (5+) ----

    @Test
    fun typeEnum_text_valid() {
        assertTrue(validateFormSchema(schema(field(type = "text"))).isValid)
    }

    @Test
    fun typeEnum_email_valid() {
        assertTrue(validateFormSchema(schema(field(type = "email"))).isValid)
    }

    @Test
    fun typeEnum_unknown_invalid() {
        val r = validateFormSchema(schema(field(type = "unknown_type")))
        assertFalse(r.isValid)
        assertTrue(r.fieldErrors[0 to 0].orEmpty().any { it.contains("Unsupported") })
    }

    @Test
    fun typeEnum_blank_invalid() {
        val r = validateFormSchema(schema(field(type = "")))
        assertFalse(r.isValid)
    }

    @Test
    fun typeEnum_allNineTypes_valid() {
        FormSchema.SUPPORTED_TYPES.forEachIndexed { idx, t ->
            val opts = if (FormSchema.typeRequiresOptions(t)) listOf("a") else null
            val r = validateFormSchema(schema(field(key = "k$idx", type = t, options = opts)))
            assertTrue(r.isValid, "$t should be a valid type")
        }
        assertEquals(9, FormSchema.SUPPORTED_TYPES.size)
    }

    // ---- options requirement (5+) ----

    @Test
    fun optionsRequired_selectWithOpts_valid() {
        val r = validateFormSchema(schema(field(type = "select", options = listOf("a", "b"))))
        assertTrue(r.isValid)
    }

    @Test
    fun optionsRequired_selectWithoutOpts_invalid() {
        val r = validateFormSchema(schema(field(type = "select")))
        assertFalse(r.isValid)
        assertTrue(r.fieldErrors[0 to 0].orEmpty().any { it.contains("Options required") })
    }

    @Test
    fun optionsRequired_selectWithEmptyList_invalid() {
        val r = validateFormSchema(schema(field(type = "select", options = emptyList())))
        assertFalse(r.isValid)
    }

    @Test
    fun optionsRequired_multiselectWithBlankOpts_invalid() {
        // Blank entries are filtered out - counts as zero options.
        val r = validateFormSchema(schema(field(type = "multiselect", options = listOf("", "  "))))
        assertFalse(r.isValid)
    }

    @Test
    fun optionsRequired_textTypeIgnoresOptions() {
        // Non-select types never require options, even if absent.
        val r = validateFormSchema(schema(field(type = "text", options = null)))
        assertTrue(r.isValid)
    }

    // ---- identifier regex (4+) ----

    @Test
    fun fieldKey_validKey_passes() {
        val r = validateFormSchema(schema(field(key = "familyName")))
        assertTrue(r.isValid, "Letters + camelCase should be a valid field key.")
    }

    @Test
    fun fieldKey_startingWithDigit_fails() {
        val r = validateFormSchema(schema(field(key = "1stName")))
        assertFalse(r.isValid)
        assertTrue(
            r.fieldErrors[0 to 0].orEmpty().any { it.contains("must start with a letter") },
            "Should reject field key beginning with a digit.",
        )
    }

    @Test
    fun fieldKey_withHyphen_fails() {
        val r = validateFormSchema(schema(field(key = "family-name")))
        assertFalse(r.isValid)
        assertTrue(
            r.fieldErrors[0 to 0].orEmpty().any { it.contains("only letters") },
            "Hyphens are not allowed in field keys (Firestore field-path safe).",
        )
    }

    @Test
    fun schemaId_withSpace_fails() {
        val s = FormSchema(
            id = "my schema",  // space → invalid
            name = "Whatever",
            sections = listOf(FormSectionSpec(title = "S", fields = listOf(field(key = "a")))),
        )
        val r = validateFormSchema(s)
        assertFalse(r.isValid)
        assertTrue(
            r.sectionErrors[-1].orEmpty().any { it.contains("Schema id") && it.contains("must start with a letter") },
            "Schema id with a space should be rejected.",
        )
    }

    @Test
    fun schemaId_validWithDotAndHyphen_passes() {
        val s = FormSchema(
            id = "tribe.profile-v2",
            name = "Tribe Profile v2",
            sections = listOf(FormSectionSpec(title = "S", fields = listOf(field(key = "a")))),
        )
        val r = validateFormSchema(s)
        assertTrue(r.isValid, "Dots and hyphens are allowed in schema ids.")
    }

    @Test
    fun schemaId_blank_doesNotTriggerRegexError() {
        // Blank schema id is reported by the canSave guard (and name-required check
        // when applicable), but the regex check itself should not fire on empty input.
        val s = FormSchema(
            id = "",
            name = "Fresh",
            sections = listOf(FormSectionSpec(title = "S", fields = listOf(field(key = "a")))),
        )
        val r = validateFormSchema(s)
        assertTrue(
            r.sectionErrors[-1].orEmpty().none { it.contains("Schema id") },
            "Blank schema id is not a regex violation (caught by canSave instead).",
        )
    }

    @Test
    fun multipleErrors_compound() {
        val s = FormSchema(
            id = "z",
            name = "",  // missing name → top-level error
            sections = listOf(
                FormSectionSpec(
                    title = "",  // missing title → section error
                    fields = listOf(
                        field(key = "x", type = "weirdType"),         // bad type
                        field(key = "x", type = "select"),            // dup + missing opts
                    ),
                ),
            ),
        )
        val r = validateFormSchema(s)
        assertFalse(r.isValid)
        assertTrue(r.sectionErrors[-1].orEmpty().any { it.contains("name") })
        assertTrue(r.sectionErrors[0].orEmpty().any { it.contains("title") })
        assertTrue(r.fieldErrors[0 to 0].orEmpty().any { it.contains("Unsupported") })
        val dupErrs = r.fieldErrors[0 to 1].orEmpty()
        assertTrue(dupErrs.any { it.contains("Duplicate") })
        assertTrue(dupErrs.any { it.contains("Options required") })
    }
}
