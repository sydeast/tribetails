package com.kinfolk.portal.screens.kin

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Pure layout logic behind the Kin card grid (mirrors the mockup's CSS
 * breakpoints: 3-up >= 880dp, 2-up >= 560dp, 1-up below).
 */
class KinGridTest {

    @Test
    fun threeColumnsAtShellBreakpointAndAbove() {
        assertEquals(3, kinGridColumns(880f))
        assertEquals(3, kinGridColumns(1140f))
    }

    @Test
    fun twoColumnsBetween560AndBreakpoint() {
        assertEquals(2, kinGridColumns(560f))
        assertEquals(2, kinGridColumns(879f))
    }

    @Test
    fun oneColumnOnNarrowPhones() {
        assertEquals(1, kinGridColumns(0f))
        assertEquals(1, kinGridColumns(390f))
        assertEquals(1, kinGridColumns(559f))
    }

    @Test
    fun ageLabel_wholeYearsDropDecimal() {
        assertEquals("4 yrs", kinAgeLabel(4.0))
    }

    @Test
    fun ageLabel_fractionalYearsKeepDecimal() {
        assertEquals("4.5 yrs", kinAgeLabel(4.5))
    }

    @Test
    fun ageLabel_missingAge() {
        assertEquals("Age not set", kinAgeLabel(null))
    }
}
