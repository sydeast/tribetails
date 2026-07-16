package com.kinfolk.portal.util

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Edge-case probes — not behavior verification of known shapes.
 * Failure here = real bug in formatUsd.
 */
class FormatBugSweepTest {

    @Test
    fun nan_does_not_render_NaN_chars() {
        val s = formatUsd(Double.NaN)
        assertTrue(!s.contains("NaN"), "NaN leak in output: '$s'")
    }

    @Test
    fun positive_infinity_does_not_render_infinity_chars() {
        val s = formatUsd(Double.POSITIVE_INFINITY)
        assertTrue(!s.contains("Infinity"), "infinity leak: '$s'")
    }

    @Test
    fun negative_infinity_does_not_render_infinity_chars() {
        val s = formatUsd(Double.NEGATIVE_INFINITY)
        assertTrue(!s.contains("Infinity"), "infinity leak: '$s'")
    }

    @Test
    fun very_small_negative_rounds_to_zero_not_neg_zero() {
        // -0.001 should render as "$0.00", not "-$0.00"
        assertEquals("$0.00", formatUsd(-0.001))
    }
}
