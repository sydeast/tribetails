package com.kinfolk.portal.components

import com.kinfolk.portal.portal.FormField
import com.kinfolk.portal.portal.FormFieldType
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * #901. A schema `defaultValue` is a HINT, never a stored value.
 *
 * Portal web used to seed an empty schema field with the default as its VALUE
 * while the save sent nothing for a key that was never stored, so the screen and
 * the record disagreed. Both clients now show it as the field's placeholder
 * instead. Mirrors `schemaPlaceholder` in web `api/tribeApi.ts`.
 */
class SchemaPlaceholderTest {

    private fun field(placeholder: String? = null, defaultValue: String? = null) = FormField(
        key = "feeding",
        label = "Feeding notes",
        type = FormFieldType.Text,
        required = false,
        helperText = null,
        placeholder = placeholder,
        options = null,
        defaultValue = defaultValue,
        group = null,
    )

    @Test
    fun `the schema's own placeholder wins`() {
        assertEquals("e.g. twice a day", schemaPlaceholder(field(placeholder = "e.g. twice a day", defaultValue = "Twice a day")))
    }

    @Test
    fun `the default is the fallback when there is no placeholder`() {
        assertEquals("Twice a day", schemaPlaceholder(field(defaultValue = "Twice a day")))
    }

    @Test
    fun `neither set is no hint at all`() {
        assertNull(schemaPlaceholder(field()))
    }

    @Test
    fun `a blank placeholder falls through to the default rather than painting an empty hint`() {
        assertEquals("Twice a day", schemaPlaceholder(field(placeholder = "   ", defaultValue = "Twice a day")))
    }

    @Test
    fun `a blank default is no hint`() {
        assertNull(schemaPlaceholder(field(defaultValue = "  ")))
    }
}
