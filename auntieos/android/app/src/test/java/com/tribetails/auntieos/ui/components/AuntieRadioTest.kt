package com.tribetails.auntieos.ui.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-JVM tests for AuntieRadio decision logic. Selection is mutually exclusive
 * within a group - clicking already-selected is a no-op (matches M3 RadioButton
 * + web SegmentedPicker semantics).
 */
class AuntieRadioTest {

    @Test
    fun `shouldFireRadioClick true when enabled and not already selected`() {
        assertTrue(shouldFireRadioClick(enabled = true, selected = false))
    }

    @Test
    fun `shouldFireRadioClick false when already selected`() {
        assertFalse(shouldFireRadioClick(enabled = true, selected = true))
    }

    @Test
    fun `shouldFireRadioClick false when disabled`() {
        assertFalse(shouldFireRadioClick(enabled = false, selected = false))
        assertFalse(shouldFireRadioClick(enabled = false, selected = true))
    }

    @Test
    fun `computeRadioVisualState innerScale 1f when selected, 0f when unselected`() {
        assertEquals(1f, computeRadioVisualState(selected = true,  enabled = true).innerScale, 0.001f)
        assertEquals(0f, computeRadioVisualState(selected = false, enabled = true).innerScale, 0.001f)
    }

    @Test
    fun `computeRadioVisualState dims alpha when disabled`() {
        val enabled  = computeRadioVisualState(selected = true, enabled = true)
        val disabled = computeRadioVisualState(selected = true, enabled = false)
        assertEquals(1.0f, enabled.alpha, 0.001f)
        assertTrue("disabled alpha must be < 1f", disabled.alpha < 1f)
    }
}
