package com.tribetails.auntieos.ui.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-JVM tests for AuntieCheckbox decision logic. Mirrors AuntieToggle gating
 * but visual state diverges (fill vs slide).
 */
class AuntieCheckboxTest {

    @Test
    fun `resolveCheckboxClick inverts when enabled`() {
        assertEquals(true,  resolveCheckboxClick(enabled = true, currentChecked = false))
        assertEquals(false, resolveCheckboxClick(enabled = true, currentChecked = true))
    }

    @Test
    fun `resolveCheckboxClick null when disabled`() {
        assertNull(resolveCheckboxClick(enabled = false, currentChecked = false))
        assertNull(resolveCheckboxClick(enabled = false, currentChecked = true))
    }

    @Test
    fun `computeCheckboxVisualState fillAlpha 1f checked, 0f unchecked`() {
        assertEquals(1f, computeCheckboxVisualState(checked = true,  enabled = true).fillAlpha, 0.001f)
        assertEquals(0f, computeCheckboxVisualState(checked = false, enabled = true).fillAlpha, 0.001f)
    }

    @Test
    fun `computeCheckboxVisualState shows check icon only when checked`() {
        assertTrue(computeCheckboxVisualState(checked = true,  enabled = true).showCheck)
        assertFalse(computeCheckboxVisualState(checked = false, enabled = true).showCheck)
    }

    @Test
    fun `computeCheckboxVisualState dims overall alpha when disabled`() {
        val on  = computeCheckboxVisualState(checked = true, enabled = true).overallAlpha
        val off = computeCheckboxVisualState(checked = true, enabled = false).overallAlpha
        assertEquals(1f, on, 0.001f)
        assertTrue("disabled overallAlpha must be < 1f", off < 1f)
    }
}
