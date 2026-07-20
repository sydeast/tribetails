package com.tribetails.auntieos.web.ui.components

import com.tribetails.auntieos.web.data.FormFieldSpec
import com.tribetails.auntieos.web.data.FormSchema
import com.tribetails.auntieos.web.data.FormSectionSpec
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class DynamicFormFieldsReadOnlyTest {

    private val schema = FormSchema(
        appliesTo = "KINFOLK",
        sections = listOf(
            FormSectionSpec(
                fields = listOf(
                    FormFieldSpec(key = "gate", label = "Gate", type = "text"),
                    FormFieldSpec(key = "vip", label = "VIP", type = "checkbox"),
                    FormFieldSpec(key = "pets", label = "Pets", type = "multiselect"),
                ),
            ),
        ),
    )

    @Test fun hasValues_trueOnlyWhenAFieldHasANonBlankValue() {
        assertTrue(hasDynamicFieldValues(listOf(schema), mapOf("gate" to "4321")))
        // whitespace-only and unrelated keys do not count
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
