package com.tribetails.auntieos.ui.components

import org.junit.Assert.assertEquals
import org.junit.Test

/** 0E, Android parity: trend tone driven by the sign of a computed delta. */
class StatTrendTest {

    @Test fun positive_delta_is_teal() {
        assertEquals(AuntieStatusTone.Teal, trendTone(12.0))
    }

    @Test fun negative_delta_is_coral() {
        assertEquals(AuntieStatusTone.Error, trendTone(-3.5))
    }

    @Test fun flat_delta_is_neutral() {
        assertEquals(AuntieStatusTone.Neutral, trendTone(0.0))
    }
}
