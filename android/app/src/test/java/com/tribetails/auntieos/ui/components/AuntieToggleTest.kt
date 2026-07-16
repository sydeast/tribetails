package com.tribetails.auntieos.ui.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-JVM tests for AuntieToggle decision logic. Visual rendering covered by
 * smoke-test on device; callback gating + state mapping covered here.
 */
class AuntieToggleTest {

    @Test
    fun `resolveToggleClick returns inverted value when enabled`() {
        assertEquals(true, resolveToggleClick(enabled = true, currentChecked = false))
        assertEquals(false, resolveToggleClick(enabled = true, currentChecked = true))
    }

    @Test
    fun `resolveToggleClick returns null when disabled (no-op)`() {
        assertNull(resolveToggleClick(enabled = false, currentChecked = false))
        assertNull(resolveToggleClick(enabled = false, currentChecked = true))
    }

    @Test
    fun `computeToggleVisualState thumbProgress 1f when checked, 0f when unchecked`() {
        assertEquals(1f, computeToggleVisualState(checked = true,  enabled = true).thumbProgress, 0.001f)
        assertEquals(0f, computeToggleVisualState(checked = false, enabled = true).thumbProgress, 0.001f)
    }

    @Test
    fun `computeToggleVisualState dims trackAlpha when disabled`() {
        val enabled  = computeToggleVisualState(checked = true, enabled = true)
        val disabled = computeToggleVisualState(checked = true, enabled = false)
        assertEquals(1.0f, enabled.trackAlpha, 0.001f)
        assertTrue("disabled trackAlpha must be < 1f", disabled.trackAlpha < 1f)
        assertTrue("disabled trackAlpha must be > 0f", disabled.trackAlpha > 0f)
    }

    @Test
    fun `computeToggleVisualState callbackEnabled matches enabled flag`() {
        assertTrue(computeToggleVisualState(checked = false, enabled = true).callbackEnabled)
        assertFalse(computeToggleVisualState(checked = false, enabled = false).callbackEnabled)
    }
}
