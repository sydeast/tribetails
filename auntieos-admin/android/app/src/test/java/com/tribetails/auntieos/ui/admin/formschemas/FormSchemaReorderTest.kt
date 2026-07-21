package com.tribetails.auntieos.ui.admin.formschemas

import com.tribetails.auntieos.data.model.FormSchemaField
import com.tribetails.auntieos.data.model.FormSchemaSection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

/**
 * Pure-JVM tests for [FormSchemaReorder]. Verifies that reorder helpers swap
 * adjacent items, no-op at edges, and preserve all other data.
 */
class FormSchemaReorderTest {

    private fun sections(vararg titles: String): List<FormSchemaSection> =
        titles.map { FormSchemaSection(title = it, fields = listOf(FormSchemaField(key = "k_$it"))) }

    // ── moveSection ─────────────────────────────────────────────────────────

    @Test fun `moveSection swaps adjacent`() {
        val src = sections("A", "B", "C")
        val out = FormSchemaReorder.moveSection(src, 0, 1)
        assertEquals(listOf("B", "A", "C"), out.map { it.title })
    }

    @Test fun `moveSection from 0 to 2 reorders correctly`() {
        val src = sections("A", "B", "C")
        val out = FormSchemaReorder.moveSection(src, 0, 2)
        assertEquals(listOf("B", "C", "A"), out.map { it.title })
    }

    @Test fun `moveSection same index is no-op`() {
        val src = sections("A", "B", "C")
        val out = FormSchemaReorder.moveSection(src, 1, 1)
        assertSame(src, out)
    }

    @Test fun `moveSection out-of-range is no-op`() {
        val src = sections("A", "B")
        assertEquals(src, FormSchemaReorder.moveSection(src, 5, 0))
        assertEquals(src, FormSchemaReorder.moveSection(src, 0, 5))
        assertEquals(src, FormSchemaReorder.moveSection(src, -1, 0))
    }

    @Test fun `moveSection preserves nested field data`() {
        val src = listOf(
            FormSchemaSection(title = "A", fields = listOf(FormSchemaField(key = "x"))),
            FormSchemaSection(title = "B", fields = listOf(FormSchemaField(key = "y"))),
        )
        val out = FormSchemaReorder.moveSection(src, 0, 1)
        assertEquals("y", out[0].fields[0].key)
        assertEquals("x", out[1].fields[0].key)
    }

    // ── moveSectionUp / Down ────────────────────────────────────────────────

    @Test fun `moveSectionUp at index 0 is no-op`() {
        val src = sections("A", "B")
        val out = FormSchemaReorder.moveSectionUp(src, 0)
        assertSame(src, out)
    }

    @Test fun `moveSectionUp at index 1 swaps`() {
        val src = sections("A", "B", "C")
        val out = FormSchemaReorder.moveSectionUp(src, 1)
        assertEquals(listOf("B", "A", "C"), out.map { it.title })
    }

    @Test fun `moveSectionDown at last index is no-op`() {
        val src = sections("A", "B")
        val out = FormSchemaReorder.moveSectionDown(src, 1)
        assertSame(src, out)
    }

    @Test fun `moveSectionDown swaps with next`() {
        val src = sections("A", "B", "C")
        val out = FormSchemaReorder.moveSectionDown(src, 0)
        assertEquals(listOf("B", "A", "C"), out.map { it.title })
    }

    // ── moveField ───────────────────────────────────────────────────────────

    private fun sectionWith(vararg keys: String): FormSchemaSection =
        FormSchemaSection(title = "S", fields = keys.map { FormSchemaField(key = it, label = "L_$it") })

    @Test fun `moveField swaps adjacent fields`() {
        val src = listOf(sectionWith("a", "b", "c"))
        val out = FormSchemaReorder.moveField(src, 0, 0, 1)
        assertEquals(listOf("b", "a", "c"), out[0].fields.map { it.key })
    }

    @Test fun `moveField preserves field labels`() {
        val src = listOf(sectionWith("a", "b"))
        val out = FormSchemaReorder.moveField(src, 0, 0, 1)
        assertEquals("L_b", out[0].fields[0].label)
        assertEquals("L_a", out[0].fields[1].label)
    }

    @Test fun `moveField out-of-section is no-op`() {
        val src = listOf(sectionWith("a", "b"))
        val out = FormSchemaReorder.moveField(src, 5, 0, 1)
        assertSame(src, out)
    }

    @Test fun `moveField same indices is no-op`() {
        val src = listOf(sectionWith("a", "b"))
        val out = FormSchemaReorder.moveField(src, 0, 1, 1)
        assertSame(src, out)
    }

    @Test fun `moveField out-of-field-range is no-op`() {
        val src = listOf(sectionWith("a", "b"))
        assertEquals(src, FormSchemaReorder.moveField(src, 0, 5, 0))
        assertEquals(src, FormSchemaReorder.moveField(src, 0, 0, 5))
    }

    // ── moveFieldUp / Down ──────────────────────────────────────────────────

    @Test fun `moveFieldUp at index 0 is no-op`() {
        val src = listOf(sectionWith("a", "b"))
        val out = FormSchemaReorder.moveFieldUp(src, 0, 0)
        assertSame(src, out)
    }

    @Test fun `moveFieldUp swaps with previous`() {
        val src = listOf(sectionWith("a", "b", "c"))
        val out = FormSchemaReorder.moveFieldUp(src, 0, 2)
        assertEquals(listOf("a", "c", "b"), out[0].fields.map { it.key })
    }

    @Test fun `moveFieldDown at last is no-op`() {
        val src = listOf(sectionWith("a", "b"))
        val out = FormSchemaReorder.moveFieldDown(src, 0, 1)
        assertSame(src, out)
    }

    @Test fun `moveFieldDown swaps with next`() {
        val src = listOf(sectionWith("a", "b", "c"))
        val out = FormSchemaReorder.moveFieldDown(src, 0, 0)
        assertEquals(listOf("b", "a", "c"), out[0].fields.map { it.key })
    }

    @Test fun `moveField does not mutate input list`() {
        val original = sectionWith("a", "b", "c")
        val src = listOf(original)
        FormSchemaReorder.moveField(src, 0, 0, 2)
        // original list contents unchanged
        assertEquals(listOf("a", "b", "c"), original.fields.map { it.key })
    }

    @Test fun `moveSection does not mutate input list`() {
        val src = sections("A", "B", "C")
        val snapshot = src.map { it.title }
        FormSchemaReorder.moveSection(src, 0, 2)
        assertEquals(snapshot, src.map { it.title })
    }
}
