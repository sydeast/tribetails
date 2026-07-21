package com.tribetails.auntieos.ui.components

import com.tribetails.auntieos.data.model.FormSchema
import com.tribetails.auntieos.data.model.FormSchemaField
import com.tribetails.auntieos.data.model.FormSchemaSection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DynamicFormFieldsReadOnlyTest {

    private val schema = FormSchema(
        sections = listOf(
            FormSchemaSection(
                fields = listOf(
                    FormSchemaField(key = "gate", label = "Gate", type = "text"),
                    FormSchemaField(key = "vip", label = "VIP", type = "checkbox"),
                    FormSchemaField(key = "pets", label = "Pets", type = "multiselect"),
                ),
            ),
        ),
    )

    @Test fun hasValues_trueOnlyWhenAFieldHasANonBlankValue() {
        assertTrue(hasDynamicFieldValues(listOf(schema), mapOf("gate" to "4321")))
        assertFalse(hasDynamicFieldValues(listOf(schema), mapOf("gate" to "   ")))
        assertFalse(hasDynamicFieldValues(listOf(schema), mapOf("unknown" to "x")))
        assertFalse(hasDynamicFieldValues(listOf(schema), emptyMap()))
        assertFalse(hasDynamicFieldValues(emptyList(), mapOf("gate" to "4321")))
    }

    @Test fun formatsCheckboxAndMultiselectForReadOnly() {
        assertEquals("Yes", formatDynamicFieldValue("checkbox", "true"))
        assertEquals("No", formatDynamicFieldValue("checkbox", "false"))
        assertEquals("Dog, Cat", formatDynamicFieldValue("multiselect", "Dog,Cat"))
        assertEquals("4321", formatDynamicFieldValue("text", "4321"))
    }
}
