package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.FormFieldSpec
import com.tribetails.auntieos.web.data.FormSchema
import com.tribetails.auntieos.web.data.FormSectionSpec
import com.tribetails.auntieos.web.screens.admin.formschemas.moveFieldDown
import com.tribetails.auntieos.web.screens.admin.formschemas.moveFieldUp
import com.tribetails.auntieos.web.screens.admin.formschemas.moveItemDown
import com.tribetails.auntieos.web.screens.admin.formschemas.moveItemUp
import com.tribetails.auntieos.web.screens.admin.formschemas.moveSectionDown
import com.tribetails.auntieos.web.screens.admin.formschemas.moveSectionUp
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotSame

class FormSchemaReorderTest {

    private fun section(title: String, vararg fieldKeys: String) =
        FormSectionSpec(
            title  = title,
            fields = fieldKeys.map { FormFieldSpec(key = it, label = it, type = "text") },
        )

    private val sampleSchema = FormSchema(
        id   = "s",
        name = "Sample",
        sections = listOf(
            section("A", "a1", "a2", "a3"),
            section("B", "b1", "b2"),
            section("C", "c1"),
        ),
    )

    // ---- generic moveItemUp/Down ----

    @Test
    fun moveItemUp_swapsAdjacentOnly() {
        val list = listOf("x", "y", "z", "w")
        val r = moveItemUp(list, 2)
        assertEquals(listOf("x", "z", "y", "w"), r)
    }

    @Test
    fun moveItemUp_atIndexZero_isNoop() {
        val list = listOf("x", "y", "z")
        assertEquals(list, moveItemUp(list, 0))
    }

    @Test
    fun moveItemUp_outOfBounds_isNoop() {
        val list = listOf("x", "y")
        assertEquals(list, moveItemUp(list, 99))
        assertEquals(list, moveItemUp(list, -1))
    }

    @Test
    fun moveItemDown_swapsAdjacentOnly() {
        val list = listOf("x", "y", "z", "w")
        val r = moveItemDown(list, 1)
        assertEquals(listOf("x", "z", "y", "w"), r)
    }

    @Test
    fun moveItemDown_atLastIndex_isNoop() {
        val list = listOf("x", "y", "z")
        assertEquals(list, moveItemDown(list, 2))
    }

    @Test
    fun moveItemDown_outOfBounds_isNoop() {
        val list = listOf("x")
        assertEquals(list, moveItemDown(list, -1))
        assertEquals(list, moveItemDown(list, 99))
    }

    // ---- section reorder ----

    @Test
    fun moveSectionUp_swapsAdjacentSections() {
        val r = moveSectionUp(sampleSchema, 1)
        assertEquals(listOf("B", "A", "C"), r.sections.map { it.title })
    }

    @Test
    fun moveSectionUp_atTop_isNoop() {
        val r = moveSectionUp(sampleSchema, 0)
        assertEquals(sampleSchema.sections.map { it.title }, r.sections.map { it.title })
    }

    @Test
    fun moveSectionDown_swapsAdjacentSections() {
        val r = moveSectionDown(sampleSchema, 0)
        assertEquals(listOf("B", "A", "C"), r.sections.map { it.title })
    }

    @Test
    fun moveSectionDown_atBottom_isNoop() {
        val r = moveSectionDown(sampleSchema, 2)
        assertEquals(sampleSchema.sections.map { it.title }, r.sections.map { it.title })
    }

    @Test
    fun moveSectionUp_preservesFieldData() {
        val r = moveSectionUp(sampleSchema, 1)
        // B got moved to top, fields should be intact:
        val b = r.sections[0]
        assertEquals("B", b.title)
        assertEquals(listOf("b1", "b2"), b.fields.map { it.key })
        // A is now in slot 1, still has all three fields:
        val a = r.sections[1]
        assertEquals(listOf("a1", "a2", "a3"), a.fields.map { it.key })
    }

    @Test
    fun moveSectionUp_returnsNewInstance_notMutated() {
        val r = moveSectionUp(sampleSchema, 1)
        assertNotSame(sampleSchema, r)
        assertNotSame(sampleSchema.sections, r.sections)
    }

    // ---- field reorder within a section ----

    @Test
    fun moveFieldUp_swapsAdjacentFields() {
        val r = moveFieldUp(sampleSchema, sectionIdx = 0, fieldIdx = 2)
        assertEquals(listOf("a1", "a3", "a2"), r.sections[0].fields.map { it.key })
    }

    @Test
    fun moveFieldUp_atTop_isNoop() {
        val r = moveFieldUp(sampleSchema, sectionIdx = 0, fieldIdx = 0)
        assertEquals(sampleSchema.sections[0].fields.map { it.key }, r.sections[0].fields.map { it.key })
    }

    @Test
    fun moveFieldDown_swapsAdjacentFields() {
        val r = moveFieldDown(sampleSchema, sectionIdx = 0, fieldIdx = 0)
        assertEquals(listOf("a2", "a1", "a3"), r.sections[0].fields.map { it.key })
    }

    @Test
    fun moveFieldDown_atBottom_isNoop() {
        val r = moveFieldDown(sampleSchema, sectionIdx = 0, fieldIdx = 2)
        assertEquals(sampleSchema.sections[0].fields.map { it.key }, r.sections[0].fields.map { it.key })
    }

    @Test
    fun moveFieldUp_leavesOtherSectionsUntouched() {
        val r = moveFieldUp(sampleSchema, sectionIdx = 1, fieldIdx = 1)
        assertEquals(listOf("a1", "a2", "a3"), r.sections[0].fields.map { it.key })
        assertEquals(listOf("c1"), r.sections[2].fields.map { it.key })
        assertEquals(listOf("b2", "b1"), r.sections[1].fields.map { it.key })
    }

    @Test
    fun moveFieldUp_outOfBoundsSection_isNoop() {
        val r = moveFieldUp(sampleSchema, sectionIdx = 99, fieldIdx = 0)
        assertEquals(sampleSchema, r)
    }
}
