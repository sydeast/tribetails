package com.tribetails.auntieos.web.ui.components

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * 0E, trend tone is driven by the SIGN of a computed delta, never a literal.
 * Positive renders teal, negative coral, flat neutral.
 */
class StatTrendTest {

    @Test fun `positive delta is teal`() {
        assertEquals(AuntieStatusTone.Teal, trendTone(12.0))
        assertEquals(AuntieStatusTone.Teal, trendTone(0.01))
    }

    @Test fun `negative delta is coral (error tone)`() {
        assertEquals(AuntieStatusTone.Error, trendTone(-3.5))
    }

    @Test fun `flat delta is neutral`() {
        assertEquals(AuntieStatusTone.Neutral, trendTone(0.0))
    }
}
