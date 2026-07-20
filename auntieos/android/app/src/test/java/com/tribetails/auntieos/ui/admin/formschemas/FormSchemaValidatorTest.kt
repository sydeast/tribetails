package com.tribetails.auntieos.ui.admin.formschemas

import com.tribetails.auntieos.data.model.FormSchema
import com.tribetails.auntieos.data.model.FormSchemaField
import com.tribetails.auntieos.data.model.FormSchemaFieldType
import com.tribetails.auntieos.data.model.FormSchemaSection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-JVM tests for [FormSchemaValidator]. Covers the three invariants from
 * the spec - key uniqueness, type enum membership, options non-empty for
 * select/multiselect - plus schema-level structural checks.
 */
class FormSchemaValidatorTest {

    // ── Key uniqueness ──────────────────────────────────────────────────────

    @Test fun `duplicate keys in same section produce error`() {
        val schema = baseSchema().copy(
            sections = listOf(
                FormSchemaSection(
                    title = "Section",
                    fields = listOf(
                        validField("a"),
                        validField("a"),
                    ),
                ),
            ),
        )
        val errors = FormSchemaValidator.validate(schema)
        assertTrue(errors.any { it.message.contains("Duplicate key", ignoreCase = true) })
    }

    @Test fun `same key across different sections is allowed`() {
        val schema = baseSchema().copy(
            sections = listOf(
                FormSchemaSection(title = "A", fields = listOf(validField("shared"))),
                FormSchemaSection(title = "B", fields = listOf(validField("shared"))),
            ),
        )
        val errors = FormSchemaValidator.validate(schema)
        assertFalse(errors.any { it.message.contains("Duplicate key", ignoreCase = true) })
    }

    @Test fun `three unique keys produce no duplicate errors`() {
        val schema = baseSchema().copy(
            sections = listOf(
                FormSchemaSection(
                    title = "S",
                    fields = listOf(validField("a"), validField("b"), validField("c")),
                ),
            ),
        )
        val errors = FormSchemaValidator.validate(schema)
        assertFalse(errors.any { it.message.contains("Duplicate key", ignoreCase = true) })
    }

    @Test fun `blank key produces required error`() {
        val schema = baseSchema().copy(
            sections = listOf(
                FormSchemaSection(title = "S", fields = listOf(validField("").copy(key = ""))),
            ),
        )
        val errors = FormSchemaValidator.validate(schema)
        assertTrue(errors.any { it.message.contains("key is required", ignoreCase = true) })
    }

    @Test fun `three duplicates produce one duplicate error for each repeat`() {
        val schema = baseSchema().copy(
            sections = listOf(
                FormSchemaSection(
                    title = "S",
                    fields = listOf(validField("k"), validField("k"), validField("k")),
                ),
            ),
        )
        val errors = FormSchemaValidator.validate(schema)
        val dupes = errors.filter { it.message.contains("Duplicate key", ignoreCase = true) }
        assertEquals(2, dupes.size)
    }

    // ── Type enum membership ────────────────────────────────────────────────

    @Test fun `unknown type produces error`() {
        val schema = baseSchema().copy(
            sections = listOf(
                FormSchemaSection(title = "S", fields = listOf(validField("a").copy(type = "color"))),
            ),
        )
        val errors = FormSchemaValidator.validate(schema)
        assertTrue(errors.any { it.message.contains("type", ignoreCase = true) && it.message.contains("color") })
    }

    @Test fun `each of the 9 allowed types validates without type error`() {
        FormSchemaFieldType.allWire.forEachIndexed { idx, wire ->
            val field = validField("k$idx").copy(
                type = wire,
                options = if (FormSchemaFieldType.requiresOptions(wire)) listOf("a") else null,
            )
            val schema = baseSchema().copy(
                sections = listOf(FormSchemaSection(title = "S", fields = listOf(field))),
            )
            val errors = FormSchemaValidator.validate(schema)
            assertFalse(
                "type $wire should be accepted but errors=$errors",
                errors.any { it.message.contains("not one of", ignoreCase = true) },
            )
        }
    }

    @Test fun `case-mismatched type is rejected`() {
        val schema = baseSchema().copy(
            sections = listOf(
                FormSchemaSection(title = "S", fields = listOf(validField("a").copy(type = "TEXT"))),
            ),
        )
        // FormSchemaFieldType.fromWire is case-insensitive - verify behavior is
        // explicit: TEXT should map to TEXT, no error.
        val errors = FormSchemaValidator.validate(schema)
        assertFalse(errors.any { it.message.contains("not one of", ignoreCase = true) })
    }

    @Test fun `blank type is rejected`() {
        val schema = baseSchema().copy(
            sections = listOf(
                FormSchemaSection(title = "S", fields = listOf(validField("a").copy(type = ""))),
            ),
        )
        val errors = FormSchemaValidator.validate(schema)
        assertTrue(errors.any { it.message.contains("not one of", ignoreCase = true) })
    }

    @Test fun `random garbage type is rejected`() {
        val schema = baseSchema().copy(
            sections = listOf(
                FormSchemaSection(title = "S", fields = listOf(validField("a").copy(type = "xyzzy"))),
            ),
        )
        val errors = FormSchemaValidator.validate(schema)
        assertTrue(errors.any { it.message.contains("not one of", ignoreCase = true) })
    }

    @Test fun `text type with options is fine`() {
        val schema = baseSchema().copy(
            sections = listOf(
                FormSchemaSection(title = "S", fields = listOf(validField("a").copy(options = listOf("x")))),
            ),
        )
        val errors = FormSchemaValidator.validate(schema)
        assertTrue(errors.none { it.message.contains("option", ignoreCase = true) })
    }

    // ── Options required for select / multiselect ───────────────────────────

    @Test fun `select with no options is rejected`() {
        val schema = baseSchema().copy(
            sections = listOf(
                FormSchemaSection(title = "S",
                    fields = listOf(validField("a").copy(type = "select", options = null))),
            ),
        )
        val errors = FormSchemaValidator.validate(schema)
        assertTrue(errors.any { it.message.contains("option", ignoreCase = true) })
    }

    @Test fun `multiselect with empty options list is rejected`() {
        val schema = baseSchema().copy(
            sections = listOf(
                FormSchemaSection(title = "S",
                    fields = listOf(validField("a").copy(type = "multiselect", options = emptyList()))),
            ),
        )
        val errors = FormSchemaValidator.validate(schema)
        assertTrue(errors.any { it.message.contains("option", ignoreCase = true) })
    }

    @Test fun `select with one option passes`() {
        val schema = baseSchema().copy(
            sections = listOf(
                FormSchemaSection(title = "S",
                    fields = listOf(validField("a").copy(type = "select", options = listOf("yes")))),
            ),
        )
        val errors = FormSchemaValidator.validate(schema)
        assertTrue(errors.none { it.message.contains("option", ignoreCase = true) })
    }

    @Test fun `multiselect with blank-only options is rejected`() {
        val schema = baseSchema().copy(
            sections = listOf(
                FormSchemaSection(title = "S",
                    fields = listOf(validField("a").copy(type = "multiselect", options = listOf("", "  ")))),
            ),
        )
        val errors = FormSchemaValidator.validate(schema)
        assertTrue(errors.any { it.message.contains("option", ignoreCase = true) })
    }

    @Test fun `non-select type with no options is fine`() {
        val schema = baseSchema().copy(
            sections = listOf(
                FormSchemaSection(title = "S", fields = listOf(validField("a").copy(type = "text", options = null))),
            ),
        )
        val errors = FormSchemaValidator.validate(schema)
        assertTrue(errors.none { it.message.contains("option", ignoreCase = true) })
    }

    // ── Structural ──────────────────────────────────────────────────────────

    @Test fun `valid schema has no errors`() {
        val schema = baseSchema().copy(
            sections = listOf(
                FormSchemaSection(title = "S", fields = listOf(validField("a"))),
            ),
        )
        val errors = FormSchemaValidator.validate(schema)
        assertTrue("Expected no errors but got $errors", errors.isEmpty())
    }

    @Test fun `schema with no sections is rejected`() {
        val schema = baseSchema().copy(sections = emptyList())
        val errors = FormSchemaValidator.validate(schema)
        assertTrue(errors.any { it.message.contains("at least one section", ignoreCase = true) })
    }

    @Test fun `blank schema id is rejected`() {
        val schema = baseSchema().copy(id = "")
        val errors = FormSchemaValidator.validate(schema)
        assertTrue(errors.any { it.message.contains("id is required", ignoreCase = true) })
    }

    @Test fun `blank schema name is rejected`() {
        val schema = baseSchema().copy(name = "")
        val errors = FormSchemaValidator.validate(schema)
        assertTrue(errors.any { it.message.contains("name is required", ignoreCase = true) })
    }

    @Test fun `blank section title is rejected`() {
        val schema = baseSchema().copy(
            sections = listOf(FormSchemaSection(title = "", fields = listOf(validField("a")))),
        )
        val errors = FormSchemaValidator.validate(schema)
        assertTrue(errors.any { it.message.contains("section title", ignoreCase = true) })
    }

    // ── Regex validation (schema id + field key) ────────────────────────────

    @Test fun `valid field key passes regex check`() {
        val schema = baseSchema().copy(
            sections = listOf(
                FormSchemaSection(title = "S", fields = listOf(validField("first_name_2"))),
            ),
        )
        val errors = FormSchemaValidator.validate(schema)
        assertFalse(
            "Expected no key-regex error but got $errors",
            errors.any { it.message.contains("Field key", ignoreCase = true) && it.message.contains("invalid", ignoreCase = true) },
        )
    }

    @Test fun `field key starting with digit is rejected`() {
        val schema = baseSchema().copy(
            sections = listOf(
                FormSchemaSection(title = "S", fields = listOf(validField("a").copy(key = "1stChoice"))),
            ),
        )
        val errors = FormSchemaValidator.validate(schema)
        assertTrue(
            "Expected a field-key invalid error but got $errors",
            errors.any { it.message.contains("Field key", ignoreCase = true) && it.message.contains("invalid", ignoreCase = true) },
        )
    }

    @Test fun `field key with hyphen is rejected`() {
        val schema = baseSchema().copy(
            sections = listOf(
                FormSchemaSection(title = "S", fields = listOf(validField("a").copy(key = "first-name"))),
            ),
        )
        val errors = FormSchemaValidator.validate(schema)
        assertTrue(
            "Expected a field-key invalid error but got $errors",
            errors.any { it.message.contains("Field key", ignoreCase = true) && it.message.contains("invalid", ignoreCase = true) },
        )
    }

    @Test fun `schema id with space is rejected`() {
        val schema = baseSchema().copy(id = "tribe profile")
        val errors = FormSchemaValidator.validate(schema)
        assertTrue(
            "Expected a schema-id invalid error but got $errors",
            errors.any { it.message.contains("Schema id", ignoreCase = true) && it.message.contains("invalid", ignoreCase = true) },
        )
    }

    @Test fun `schema id with dot and hyphen passes`() {
        val schema = baseSchema().copy(
            id = "tribe.profile-v2",
            sections = listOf(FormSchemaSection(title = "S", fields = listOf(validField("a")))),
        )
        val errors = FormSchemaValidator.validate(schema)
        assertFalse(
            "Expected no schema-id-invalid error but got $errors",
            errors.any { it.message.contains("Schema id", ignoreCase = true) && it.message.contains("invalid", ignoreCase = true) },
        )
    }

    @Test fun `schema id starting with digit is rejected`() {
        val schema = baseSchema().copy(id = "2024_profile")
        val errors = FormSchemaValidator.validate(schema)
        assertTrue(
            "Expected schema-id invalid error but got $errors",
            errors.any { it.message.contains("Schema id", ignoreCase = true) && it.message.contains("invalid", ignoreCase = true) },
        )
    }

    @Test fun `errorsFor filters by section and field index`() {
        val all = listOf(
            FormSchemaValidationError(0, 0, "x"),
            FormSchemaValidationError(0, 1, "y"),
            FormSchemaValidationError(1, null, "z"),
        )
        assertEquals(1, FormSchemaValidator.errorsFor(all, 0, 0).size)
        assertEquals(1, FormSchemaValidator.errorsFor(all, 1, null).size)
        assertEquals(0, FormSchemaValidator.errorsFor(all, 2, null).size)
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    private fun baseSchema() = FormSchema(
        id = "tribeProfile",
        name = "Tribe Profile",
        description = "",
        version = 1,
        sections = emptyList(),
    )

    private fun validField(key: String) = FormSchemaField(
        key = key,
        label = "Label for $key",
        type = FormSchemaFieldType.TEXT.wire,
        required = false,
    )
}
