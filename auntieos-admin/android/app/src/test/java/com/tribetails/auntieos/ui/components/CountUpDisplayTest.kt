package com.tribetails.auntieos.ui.components

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 17.3 alive-widgets: pure clamp math behind CountUpText. The animation drives
 * progress 0..1; the display value must never overshoot the target or dip below
 * zero even if a spring feeds an out-of-range progress.
 */
class CountUpDisplayTest {

    @Test
    fun zeroProgressShowsZero() {
        assertEquals(0.0, countUpDisplay(42.0, 0f), 0.0)
    }

    @Test
    fun fullProgressShowsTargetExactly() {
        assertEquals(42.0, countUpDisplay(42.0, 1f), 0.0)
        assertEquals(1280.55, countUpDisplay(1280.55, 1f), 0.0)
    }

    @Test
    fun midProgressScalesLinearly() {
        assertEquals(21.0, countUpDisplay(42.0, 0.5f), 1e-9)
    }

    @Test
    fun progressIsClampedToUnitRange() {
        assertEquals(42.0, countUpDisplay(42.0, 1.4f), 0.0) // overshoot clamps to target
        assertEquals(0.0, countUpDisplay(42.0, -0.3f), 0.0) // undershoot clamps to zero
    }

    @Test
    fun zeroTargetStaysZeroAcrossTheRoll() {
        assertEquals(0.0, countUpDisplay(0.0, 0.7f), 0.0)
    }
}
