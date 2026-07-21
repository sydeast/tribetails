package com.tribetails.auntieos.web.ui.components

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * 17.3 alive-widgets: the pure display math behind CountUpText. The Compose
 * clock drives progress; this pins the curve endpoints and clamping so the
 * rolled value can never overshoot the real stat.
 */
class CountUpDisplayTest {
    @Test
    fun startsAtZeroAndEndsExactlyOnTarget() {
        assertEquals(0.0, countUpDisplay(42.0, 0f))
        assertEquals(42.0, countUpDisplay(42.0, 1f))
    }

    @Test
    fun midProgressIsProportional() {
        assertEquals(21.0, countUpDisplay(42.0, 0.5f))
    }

    @Test
    fun progressIsClampedSoTheValueNeverOvershoots() {
        assertEquals(42.0, countUpDisplay(42.0, 1.4f))
        assertEquals(0.0, countUpDisplay(42.0, -0.3f))
    }

    @Test
    fun zeroTargetStaysZeroThroughTheRoll() {
        assertEquals(0.0, countUpDisplay(0.0, 0.7f))
    }
}
