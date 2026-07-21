package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.DynamicField
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class DynamicFieldTest {

    @Test
    fun dynamicField_defaultFields_areBlank() {
        val f = DynamicField()
        assertEquals("", f._id)
        assertEquals("", f.name)
        assertEquals("", f.label)
        assertEquals("text", f.fieldType)
        assertEquals("kinfolk", f.appliesTo)
        assertEquals(emptyList(), f.options)
        assertFalse(f.required)
        assertEquals("", f.helpText)
        assertEquals(0, f.displayOrder)
        assertFalse(f.archived)
    }

    @Test
    fun typeRequiresOptions_trueForSelectVariants() {
        assertTrue(DynamicField.typeRequiresOptions("select"))
        assertTrue(DynamicField.typeRequiresOptions("multiselect"))
    }

    @Test
    fun typeRequiresOptions_falseForOtherTypes() {
        listOf("text", "long_text", "number", "boolean", "date", "email", "phone").forEach { t ->
            assertFalse(DynamicField.typeRequiresOptions(t), "$t should not require options")
        }
    }

    @Test
    fun supportedTypes_coverEachKnownEntry() {
        val expected = listOf(
            "text", "long_text", "number", "boolean",
            "date", "email", "phone", "select", "multiselect",
        )
        assertEquals(expected, DynamicField.SUPPORTED_TYPES)
    }

    @Test
    fun supportedAppliesTo_coverEachKnownEntry() {
        assertEquals(listOf("kinfolk", "kin", "session", "booking"), DynamicField.SUPPORTED_APPLIES_TO)
    }

    @Test
    fun dynamicField_serializesAndRoundTrips() {
        val original = DynamicField(
            _id = "abc",
            name = "favorite_treat",
            label = "Favorite Treat",
            fieldType = "select",
            appliesTo = "kin",
            options = listOf("Bacon", "Liver", "Cheese"),
            required = true,
            helpText = "Pick what gets the tail wagging.",
            displayOrder = 3,
            archived = false,
            createdAt = "2026-05-09T00:00:00Z",
            updatedAt = "2026-05-09T01:00:00Z",
        )
        val json = Json { ignoreUnknownKeys = true }
        val text = json.encodeToString(DynamicField.serializer(), original)
        val parsed = json.decodeFromString(DynamicField.serializer(), text)
        assertEquals(original, parsed)
        assertTrue(text.contains("\"name\":\"favorite_treat\""))
        assertTrue(text.contains("\"options\":[\"Bacon\",\"Liver\",\"Cheese\"]"))
    }
}
